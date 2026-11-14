/**
 * The Windows desktop surface behind `cua()`: one Cua Driver runtime per
 * worker, one fresh launch of the target's app per `app.open()`, and every
 * observation, query, and action against the app's front window through UI
 * Automation.
 *
 * Coordinates: every rect and point is in the pixels of the window
 * screenshot `get_window_state` takes at native resolution, the space the
 * driver's window-scoped pointer input takes, so the viewport is that
 * screenshot's size and its scale is 1.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { release } from 'node:os';
import path from 'node:path';
import {
  EngineError,
  resolveExpression,
  type EngineAppInfo,
  type EngineAttemptContext,
  type EngineCleanupContext,
  type EngineInitInfo,
  type EngineObserveOptions,
  type EngineSnapshot,
  type KeyModifier,
  type LocatorAction,
  type LocatorExpression,
  type NodeRef,
  type ObservationPixels,
  type OperationContext,
  type PointerAction,
  type SemanticNode,
  type ViewportPoint,
} from 'e2e/engine';
import { structured, type ClientFactory, type DriverClient, type DriverImage } from './client.ts';
import { refusal, translate } from './errors.ts';
import { chord, driverKey } from './keys.ts';
import { centreOf, project, ROOT_ID, type DriverElement, type NodeEntry, type Projection } from './nodes.ts';
import type { ResolvedOptions } from './options.ts';
import { matchSelector } from './selector.ts';

/** One top-level window as `list_windows` reports it. */
export interface WindowInfo {
  readonly windowId: number;
  readonly title: string;
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined;
  readonly onScreen: boolean;
  readonly zIndex: number | undefined;
}

/** The app the current attempt launched. */
interface Launched {
  readonly pid: number;
  /** The window the app opened with: the one `options.window` picked. */
  readonly mainWindow: number;
}

/** One window snapshot with its pixels. */
interface Snapshot {
  readonly projection: Projection;
  readonly title: string;
  readonly appName: string;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly png: Uint8Array | undefined;
}

const TEXT_ROLES = new Set(['textbox', 'combobox', 'document', 'spinbutton']);
const CLICK_MODIFIERS: Readonly<Record<KeyModifier, string>> = {
  Shift: 'shift',
  Control: 'ctrl',
  Alt: 'alt',
  Meta: 'win',
  ControlOrMeta: 'ctrl',
};
const SCROLL_LINES = { none: 5, slow: 3, fast: 12 } as const;
const POLL_MS = 250;

export class CuaSurface {
  private client: DriverClient | undefined;
  private app: EngineAppInfo = {};
  private projectRoot = process.cwd();
  private attempt: EngineAttemptContext | undefined;
  private screenshots = 0;
  private launched: Launched | undefined;
  /** The window observations and actions address: the app's front window. */
  private windowId: number | undefined;
  private latest: Projection | undefined;

  constructor(
    readonly options: ResolvedOptions,
    private readonly factory: ClientFactory,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  // ---- lifecycle -------------------------------------------------------

  async init(info: EngineInitInfo): Promise<void> {
    if (this.platform !== 'win32') {
      throw new EngineError('ENGINE_FAILURE', `cua() drives Windows desktops through UI Automation; this worker runs on ${this.platform}`, {
        retryable: false,
      });
    }
    this.app = info.app;
    this.projectRoot = info.projectRoot;
    this.client = this.factory();
    // Loads the native runtime now, so a missing or broken install fails
    // here as infrastructure rather than in the first step.
    const screen = await this.call('get_screen_size', {}, { signal: info.signal, timeoutMs: 30_000 }, false);
    const size = structured(screen);
    info.log(`Cua Driver ready${typeof size.width === 'number' ? `, screen ${String(size.width)}x${String(size.height)}` : ''}`);
  }

  async startAttempt(context: EngineAttemptContext): Promise<void> {
    this.attempt = context;
    this.screenshots = 0;
    this.latest = undefined;
    context.environment({ os: `Windows ${release()}`, driver: 'Cua Driver' });
  }

  async endAttempt(context: EngineCleanupContext): Promise<void> {
    await this.quit(context);
    this.attempt = undefined;
    this.latest = undefined;
  }

  async dispose(context: EngineCleanupContext): Promise<void> {
    await this.quit(context).catch(() => undefined);
    const client = this.client;
    this.client = undefined;
    await client?.shutdown();
  }

  /** `app.open()`, `app.restart()`, and the agent's relaunch: quit what runs, then launch afresh and wait for the window. */
  async restart(operation: OperationContext): Promise<void> {
    await this.quit(operation);
    await this.launch(operation);
  }

  // ---- observation -----------------------------------------------------

  async observe(operation: OperationContext, options?: EngineObserveOptions): Promise<EngineSnapshot> {
    const snapshot = await this.snapshot(operation);
    const pixels = options?.pixels === true ? pixelsOf(snapshot) : undefined;
    return {
      location: `app://${encodeURIComponent(snapshot.appName || 'app')}/${encodeURIComponent(snapshot.title)}`,
      root: snapshot.projection.root,
      viewport: snapshot.viewport,
      ...(snapshot.projection.truncated ? { truncated: true } : {}),
      ...(pixels === undefined ? {} : { pixels, maskedRegionCount: 0 }),
    };
  }

  async locate(expression: LocatorExpression, operation: OperationContext): Promise<readonly SemanticNode[]> {
    const snapshot = await this.snapshot(operation);
    return resolveExpression(expression, snapshot.projection.root.children ?? [], { selector: matchSelector });
  }

  async screenshot(label: string | undefined, operation: OperationContext): Promise<string> {
    const attempt = this.attempt;
    if (attempt === undefined) throw invalidState('a screenshot outside an attempt');
    const { pid, windowId } = await this.target(operation);
    const result = await this.call('get_window_state', { pid, window_id: windowId, include_accessibility_tree: false, include_screenshot: true, max_image_dimension: 0 }, operation, false);
    const png = pngOf(result.images);
    if (png === undefined) throw new EngineError('ENGINE_FAILURE', 'Cua Driver returned no PNG for the window', { retryable: false });
    this.screenshots += 1;
    const relative = path.join('screenshots', `${String(this.screenshots).padStart(3, '0')}-${safeName(label ?? 'screenshot')}.png`);
    mkdirSync(path.join(attempt.artifactsDir, 'screenshots'), { recursive: true });
    writeFileSync(path.join(attempt.artifactsDir, relative), png);
    return relative;
  }

  // ---- actions ---------------------------------------------------------

  async perform(ref: NodeRef, action: LocatorAction, operation: OperationContext): Promise<void> {
    if (ref.id === ROOT_ID) {
      if (action.kind !== 'swipe') throw unsupported(`${action.kind} on the window itself`);
      const { pid, windowId } = await this.target(operation);
      const viewport = this.latest?.root.rect;
      await this.input('scroll', {
        pid,
        window_id: windowId,
        direction: action.direction,
        by: 'line',
        amount: SCROLL_LINES[action.momentum ?? 'none'],
        ...(viewport === undefined ? {} : { x: viewport.width / 2, y: viewport.height / 2 }),
      }, operation);
      return;
    }
    const entry = this.entry(ref);
    switch (action.kind) {
      case 'tap':
      case 'doubleTap':
      case 'secondaryTap':
        return this.click(entry, action.kind, action.modifiers ?? [], operation);
      case 'focus':
        if (!TEXT_ROLES.has(entry.node.role ?? '')) throw unsupported(`focus on a ${entry.node.role ?? 'node'}: only a text field takes focus without being clicked`);
        return this.click(entry, 'tap', [], operation);
      case 'fill':
        return this.fill(entry, action.value, operation);
      case 'clear':
        return this.fill(entry, '', operation);
      case 'check':
      case 'uncheck': {
        const checked = entry.node.states?.checked;
        if (checked === undefined) throw unsupported(`${action.kind} on a ${entry.controlType} whose toggle state UI Automation does not report`);
        if (checked === (action.kind === 'check')) return;
        return this.click(entry, 'tap', [], operation);
      }
      case 'press': {
        const key = driverKey(action.key);
        await this.input('press_key', { element_token: this.token(entry), key: key.key, modifiers: key.modifiers }, operation);
        return;
      }
      case 'selectOption': {
        const option = action.value;
        const label = typeof option === 'string' ? option : option.label;
        if (label === undefined) throw unsupported('selectOption by value or index: a Windows combo box is set by the label it shows');
        if (!entry.actions.includes('value') && entry.controlType !== 'ComboBox') throw unsupported(`selectOption on a ${entry.controlType}`);
        await this.input('set_value', { element_token: this.token(entry), value: label }, operation);
        return;
      }
      case 'dragTo': {
        const target = this.entry(action.target);
        const from = centreOf(entry.node);
        const to = centreOf(target.node);
        if (from === undefined || to === undefined) throw notActionable('a drag between nodes UI Automation reports no bounds for');
        return this.drag(from, to, undefined, operation);
      }
      case 'swipe':
        await this.input('scroll', {
          element_token: this.token(entry),
          direction: action.direction,
          by: 'line',
          amount: SCROLL_LINES[action.momentum ?? 'none'],
        }, operation);
        return;
      default:
        throw unsupported(action.kind);
    }
  }

  async performAt(point: ViewportPoint, action: PointerAction, operation: OperationContext): Promise<void> {
    const { pid, windowId } = await this.target(operation);
    switch (action.kind) {
      case 'tap':
      case 'doubleTap':
      case 'secondaryTap':
        await this.input('click', { pid, window_id: windowId, x: point.x, y: point.y, ...clickShape(action.kind) }, operation);
        return;
      case 'dragTo':
        return this.drag(point, action.target, undefined, operation);
      case 'swipeTo':
        return this.drag(point, action.target, action.durationMs, operation);
      case 'swipe':
        await this.input('scroll', {
          pid,
          window_id: windowId,
          x: point.x,
          y: point.y,
          direction: action.direction,
          by: 'line',
          amount: SCROLL_LINES[action.momentum ?? 'none'],
        }, operation);
        return;
      default:
        throw unsupported(action.kind);
    }
  }

  /** Types into whatever holds focus, as keystrokes; `replace` selects the field's text first. */
  async typeText(text: string, options: { readonly replace: boolean }, operation: OperationContext): Promise<void> {
    const { pid, windowId } = await this.target(operation);
    if (options.replace) await this.input('hotkey', { pid, window_id: windowId, keys: ['ctrl', 'a'] }, operation);
    if (text === '') {
      if (options.replace) await this.input('press_key', { pid, window_id: windowId, key: 'delete' }, operation);
      return;
    }
    await this.input('type_text', { pid, window_id: windowId, text }, operation);
  }

  /** Sends one key of the contract grammar to whatever holds focus. */
  async pressKey(spelling: string, operation: OperationContext): Promise<void> {
    const { pid, windowId } = await this.target(operation);
    const key = driverKey(spelling);
    await this.input('press_key', { pid, window_id: windowId, key: key.key, modifiers: key.modifiers }, operation);
  }

  // ---- desktop fixture -------------------------------------------------

  /** Sends one chord to the window: `Control+s`, `Alt+F4`. */
  async hotkey(spelling: string, operation: OperationContext): Promise<void> {
    const { pid, windowId } = await this.target(operation);
    await this.input('hotkey', { pid, window_id: windowId, keys: chord(spelling) }, operation);
  }

  /** Invokes one application-menu path, outermost first. */
  async menu(menuPath: readonly string[], operation: OperationContext): Promise<void> {
    if (menuPath.length === 0) throw new EngineError('UNSUPPORTED_CAPABILITY', 'desktop.menu needs at least one label', { retryable: false });
    const { pid, windowId } = await this.target(operation);
    await this.input('invoke_menu', { pid, window_id: windowId, path: [...menuPath] }, operation);
  }

  /** The app's windows, front first, and which one the engine drives. */
  async windows(operation: OperationContext): Promise<{ readonly current: WindowInfo; readonly all: readonly WindowInfo[] }> {
    const { pid, windowId } = await this.target(operation);
    const all = await this.listWindows(pid, operation);
    const current = all.find((window) => window.windowId === windowId);
    if (current === undefined) throw invalidState('the app has no window open');
    return { current, all };
  }

  // ---- internals -------------------------------------------------------

  private async launch(operation: OperationContext): Promise<void> {
    const args: Record<string, unknown> = launchTarget(this.app, this.projectRoot);
    if (this.app.launchArguments !== undefined && this.app.launchArguments.length > 0) args.additional_arguments = [...this.app.launchArguments];
    const budget: OperationContext = { ...operation, timeoutMs: Math.max(operation.timeoutMs, this.options.launchTimeoutMs) };
    const result = await this.call('launch_app', args, budget, true);
    const pid = structured(result).pid;
    if (typeof pid !== 'number') throw new EngineError('ENGINE_FAILURE', `launch_app reported no process: ${result.text.trim()}`, { retryable: false });
    const deadline = Date.now() + this.options.launchTimeoutMs;
    for (;;) {
      const window = pickWindow(await this.listWindows(pid, budget), this.options.window);
      if (window !== undefined) {
        this.launched = { pid, mainWindow: window.windowId };
        this.windowId = window.windowId;
        this.latest = undefined;
        this.attempt?.environment({ app: `${describeApp(this.app)} (pid ${String(pid)})` });
        return;
      }
      if (Date.now() >= deadline) {
        this.launched = { pid, mainWindow: 0 };
        throw new EngineError(
          'ENGINE_FAILURE',
          `the app started (pid ${String(pid)}) but showed no ${this.options.window === undefined ? '' : `window matching ${String(this.options.window)} `}within ${String(this.options.launchTimeoutMs)} ms`,
          { retryable: false },
        );
      }
      await delay(POLL_MS, operation.signal);
    }
  }

  /** Quits the launched app. Idempotent: an app that already exited is fine. */
  private async quit(context: { readonly signal: AbortSignal; readonly timeoutMs: number }): Promise<void> {
    const launched = this.launched;
    this.launched = undefined;
    this.windowId = undefined;
    this.latest = undefined;
    if (launched === undefined || this.client === undefined) return;
    try {
      await this.call('kill_app', { pid: launched.pid }, context, false);
    } catch (cause) {
      if (cause instanceof EngineError && cause.code === 'INVALID_STATE') return;
      throw cause;
    }
  }

  /**
   * The process and window to address: the app's front visible window, so a
   * dialog the app opens (Save As, a message box) is what the test sees and
   * acts on, and the main window again once it closes.
   */
  private async target(operation: OperationContext): Promise<{ pid: number; windowId: number }> {
    const launched = this.launched;
    if (launched === undefined) throw invalidState('the app is not open: call app.open() first');
    const windows = await this.listWindows(launched.pid, operation);
    const front = frontmost(windows.filter((window) => window.onScreen));
    if (front === undefined) throw invalidState('the app has no visible window: it may have closed or crashed');
    if (front.windowId !== this.windowId) this.latest = undefined;
    this.windowId = front.windowId;
    return { pid: launched.pid, windowId: front.windowId };
  }

  private async listWindows(pid: number, operation: OperationContext): Promise<WindowInfo[]> {
    const result = await this.call('list_windows', { pid }, operation, false);
    const windows = structured(result).windows;
    return Array.isArray(windows) ? windows.flatMap(windowOf) : [];
  }

  private async snapshot(operation: OperationContext): Promise<Snapshot> {
    const { pid, windowId } = await this.target(operation);
    const result = await this.call(
      'get_window_state',
      { pid, window_id: windowId, tree_format: 'both', include_screenshot: true, max_image_dimension: 0, max_elements: this.options.maxElements },
      operation,
      false,
    );
    const state = structured(result);
    const png = pngOf(result.images);
    const size = png === undefined ? undefined : pngSize(png);
    const viewport = size ?? (await this.windowSize(pid, windowId, operation));
    const title = typeof state.window_title === 'string' ? state.window_title : '';
    const projection = project({
      snapshotId: String(state.snapshot_id ?? Date.now()),
      title,
      elements: Array.isArray(state.elements) ? (state.elements as DriverElement[]) : [],
      markdown: typeof state.tree_markdown === 'string' ? state.tree_markdown : undefined,
      truncated: state.truncated === true || state.elements_complete === false,
      viewport,
    });
    this.latest = projection;
    return { projection, title, appName: typeof state.app_name === 'string' ? state.app_name : '', viewport, png };
  }

  private async windowSize(pid: number, windowId: number, operation: OperationContext): Promise<{ width: number; height: number }> {
    const window = (await this.listWindows(pid, operation)).find((candidate) => candidate.windowId === windowId);
    return { width: window?.bounds?.width ?? 0, height: window?.bounds?.height ?? 0 };
  }

  /** The node behind a ref of the newest projection; `NODE_STALE` once the driver replaced its snapshot. */
  private entry(ref: NodeRef): NodeEntry {
    const entry = this.latest?.entries.get(ref.id);
    if (entry === undefined) throw new EngineError('NODE_STALE', `node ${ref.id} is not in the newest window snapshot`, { retryable: true });
    return entry;
  }

  private token(entry: NodeEntry): string {
    if (entry.token === undefined) throw notActionable(`the ${entry.controlType} "${entry.node.name ?? ''}" is static text, which takes no input`);
    return entry.token;
  }

  private async click(entry: NodeEntry, kind: 'tap' | 'doubleTap' | 'secondaryTap', modifiers: readonly KeyModifier[], operation: OperationContext): Promise<void> {
    const modifier = [...new Set(modifiers.map((key) => CLICK_MODIFIERS[key]))];
    await this.input('click', { element_token: this.token(entry), ...clickShape(kind), ...(modifier.length === 0 ? {} : { modifier }) }, operation);
  }

  /** Sets a field's value through UI Automation's value pattern, else clicks it and types over its text. */
  private async fill(entry: NodeEntry, value: string, operation: OperationContext): Promise<void> {
    const token = this.token(entry);
    if (entry.actions.includes('value')) {
      await this.input('set_value', { element_token: token, value }, operation);
      return;
    }
    if (!TEXT_ROLES.has(entry.node.role ?? '')) throw notActionable(`a ${entry.controlType} takes no text`);
    await this.input('click', { element_token: token }, operation);
    await this.input('hotkey', { element_token: token, keys: ['ctrl', 'a'] }, operation);
    if (value === '') await this.input('press_key', { element_token: token, key: 'delete' }, operation);
    else await this.input('type_text', { element_token: token, text: value }, operation);
  }

  private async drag(from: ViewportPoint, to: ViewportPoint, durationMs: number | undefined, operation: OperationContext): Promise<void> {
    const { pid, windowId } = await this.target(operation);
    await this.input('drag', {
      pid,
      window_id: windowId,
      from_x: from.x,
      from_y: from.y,
      to_x: to.x,
      to_y: to.y,
      ...(durationMs === undefined ? {} : { duration_ms: durationMs }),
    }, operation);
  }

  /** One input tool call, with the configured delivery. */
  private async input(tool: string, args: Record<string, unknown>, operation: OperationContext): Promise<void> {
    await this.call(tool, { ...args, delivery_mode: this.options.delivery }, operation, true);
  }

  /**
   * One tool call, bounded by the operation's budget (the harness signal
   * does not abort at it). An input that ran out of budget may still land,
   * so it is `ACTION_MAY_HAVE_COMMITTED`; a read that did is `OPERATION_TIMEOUT`.
   */
  private async call(tool: string, args: Readonly<Record<string, unknown>>, operation: { readonly signal: AbortSignal; readonly timeoutMs: number }, input: boolean) {
    const client = this.client;
    if (client === undefined) throw invalidState('the engine is not initialized');
    const timeout = AbortSignal.timeout(Math.max(1, operation.timeoutMs));
    const signal = AbortSignal.any([operation.signal, timeout]);
    try {
      const result = await client.call(tool, args, signal);
      if (result.isError) throw refusal(tool, result, input);
      return result;
    } catch (cause) {
      if (timeout.aborted && !operation.signal.aborted) {
        throw input
          ? new EngineError('ACTION_MAY_HAVE_COMMITTED', `${tool} did not answer within its budget; the input may have reached the app`, { retryable: false, cause })
          : new EngineError('OPERATION_TIMEOUT', `${tool} timed out`, { retryable: false, cause });
      }
      throw translate(tool, cause, operation.signal, input);
    }
  }
}

/** What `launch_app` takes for the target's app: an executable by path, a packaged app by AUMID, else a name. */
export function launchTarget(app: EngineAppInfo, projectRoot: string): Record<string, unknown> {
  if (app.appPath !== undefined) return { path: path.resolve(projectRoot, app.appPath) };
  const id = app.bundleId;
  if (id === undefined) throw invalidState('the target declares no app.bundleId or app.appPath');
  if (id.includes('!')) return { aumid: id };
  if (/[\\/]/.test(id)) return { path: id };
  return { name: id };
}

/** The window to drive at launch: the front visible one, among those whose title matches. */
function pickWindow(windows: readonly WindowInfo[], wanted: string | RegExp | undefined): WindowInfo | undefined {
  const visible = windows.filter((window) => window.onScreen && (window.bounds === undefined || (window.bounds.width > 0 && window.bounds.height > 0)));
  const matching = wanted === undefined ? visible : visible.filter((window) => (typeof wanted === 'string' ? window.title.includes(wanted) : wanted.test(window.title)));
  return frontmost(matching);
}

/** The window nearest the front; the first listed when the driver reports no stacking. */
function frontmost(windows: readonly WindowInfo[]): WindowInfo | undefined {
  let best: WindowInfo | undefined;
  for (const window of windows) {
    if (best === undefined) best = window;
    else if (window.zIndex !== undefined && (best.zIndex === undefined || window.zIndex > best.zIndex)) best = window;
  }
  return best;
}

function windowOf(raw: unknown): WindowInfo[] {
  if (raw === null || typeof raw !== 'object') return [];
  const value = raw as Record<string, unknown>;
  if (typeof value.window_id !== 'number') return [];
  const bounds = value.bounds as Record<string, unknown> | undefined;
  const box =
    bounds !== undefined && typeof bounds.x === 'number' && typeof bounds.y === 'number' && typeof bounds.width === 'number' && typeof bounds.height === 'number'
      ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
      : undefined;
  return [
    {
      windowId: value.window_id,
      title: typeof value.title === 'string' ? value.title : '',
      bounds: box,
      onScreen: value.is_on_screen !== false,
      zIndex: typeof value.z_index === 'number' ? value.z_index : undefined,
    },
  ];
}

function clickShape(kind: 'tap' | 'doubleTap' | 'secondaryTap'): Record<string, unknown> {
  if (kind === 'doubleTap') return { count: 2 };
  if (kind === 'secondaryTap') return { button: 'right' };
  return {};
}

function pngOf(images: readonly DriverImage[]): Uint8Array | undefined {
  const image = images.find((candidate) => candidate.mimeType === 'image/png');
  return image === undefined ? undefined : new Uint8Array(Buffer.from(image.dataBase64, 'base64'));
}

/** Width and height from a PNG's IHDR chunk. */
export function pngSize(png: Uint8Array): { width: number; height: number } | undefined {
  if (png.length < 24 || png[12] !== 0x49 || png[13] !== 0x48 || png[14] !== 0x44 || png[15] !== 0x52) return undefined;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function pixelsOf(snapshot: Snapshot): ObservationPixels | undefined {
  if (snapshot.png === undefined) return undefined;
  const size = pngSize(snapshot.png);
  if (size === undefined) return undefined;
  return { data: snapshot.png, mediaType: 'image/png', width: size.width, height: size.height, scale: 1 };
}

function describeApp(app: EngineAppInfo): string {
  return app.bundleId ?? (app.appPath === undefined ? 'app' : path.basename(app.appPath));
}

function safeName(label: string): string {
  return label.replace(/[^\w.-]+/g, '-').slice(0, 60) || 'screenshot';
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new EngineError('CANCELLED', 'cancelled while waiting for the app window', { retryable: false }));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new EngineError('CANCELLED', 'cancelled while waiting for the app window', { retryable: false }));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function unsupported(what: string): EngineError {
  return new EngineError('UNSUPPORTED_CAPABILITY', `the Windows desktop engine cannot ${what}`, { retryable: false });
}

function notActionable(what: string): EngineError {
  return new EngineError('NOT_ACTIONABLE', what, { retryable: false });
}

function invalidState(what: string): EngineError {
  return new EngineError('INVALID_STATE', what, { retryable: false });
}
