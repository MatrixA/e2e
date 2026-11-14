/**
 * The Windows desktop engine for e2e, on Cua Driver: built with the public
 * `defineEngine`, validated and graded like any other engine. Core imports
 * nothing from here; this package imports the contract from `e2e/engine`
 * and contributes the `desktop` fixture.
 */

import { createRequire } from 'node:module';
import {
  ConfigurationError,
  defineEngine,
  POINTER_ACTION_KINDS,
  type EngineAppCheckInfo,
  type EngineAppDeclaration,
  type EngineHandle,
  type LocatorActionKind,
  type PointerActionKind,
} from 'e2e/engine';
import { createDriverClient, type ClientFactory } from './client.ts';
import { createDesktopFixture } from './desktop.ts';
import { resolveOptions, type CuaOptions } from './options.ts';
import { CuaSurface } from './surface.ts';

/** The node actions the engine performs. `hover`, `longPress`, `scrollIntoView`, and `setInputFiles` have no UI Automation route. */
const CUA_ACTIONS = [
  'tap',
  'doubleTap',
  'secondaryTap',
  'fill',
  'clear',
  'press',
  'check',
  'uncheck',
  'focus',
  'selectOption',
  'dragTo',
  'swipe',
] as const satisfies readonly LocatorActionKind[];

/** The point actions the engine performs. */
const CUA_POINTER_ACTIONS = POINTER_ACTION_KINDS.filter(
  (kind): kind is Exclude<PointerActionKind, 'hover' | 'longPress'> => kind !== 'hover' && kind !== 'longPress',
);

/** Assembles the manifest for one surface. Exported for tests that script the client. */
export function buildEngine(surface: CuaSurface): EngineHandle {
  return defineEngine({
    name: 'cua',
    version: ownVersion(),
    spiVersion: 1,
    platform: 'windows',
    // One desktop, one pointer and keyboard: workers would fight over focus.
    workers: 1,
    validateApp,
    init: (info) => surface.init(info),
    startAttempt: (context) => surface.startAttempt(context),
    endAttempt: (context) => surface.endAttempt(context),
    dispose: (context) => surface.dispose(context),
    observe: (operation, options) => surface.observe(operation, options),
    locate: (expression, operation) => surface.locate(expression, operation),
    perform: (ref, action, operation) => surface.perform(ref, action, operation),
    actions: CUA_ACTIONS,
    tapModifiers: true,
    performAt: (point, action, operation) => surface.performAt(point, action, operation),
    pointerActions: CUA_POINTER_ACTIONS,
    keyboard: {
      type: (text, options, operation) => surface.typeText(text, options, operation),
      press: (key, operation) => surface.pressKey(key, operation),
    },
    // No `open`: a desktop app has no URL, so the runner serves `app.open()`
    // with `restart`, a fresh launch.
    session: {
      restart: (operation) => surface.restart(operation),
    },
    artifacts: {
      screenshot: (label, operation) => surface.screenshot(label, operation),
    },
    fixtures: {
      desktop: (context) => createDesktopFixture(surface, context),
    },
  });
}

/**
 * Creates the Windows desktop engine: one Cua Driver runtime per worker, a
 * fresh launch of the target's app on every `app.open()`.
 *
 * ```ts
 * targets: [{ name: 'notepad', engine: cua(), app: { bundleId: 'notepad.exe' } }]
 * ```
 */
export function cua(options?: CuaOptions): EngineHandle {
  const factory: ClientFactory = () => createDriverClient();
  return buildEngine(new CuaSurface(resolveOptions(options), factory));
}

/**
 * A desktop target launches an installed app: `bundleId` is a packaged
 * app's AUMID (`Microsoft.WindowsCalculator_8wekyb3d8bbwe!App`), an
 * executable on the PATH, or a display name; `appPath` is an executable
 * relative to the project. A URL has nothing to open.
 */
function validateApp(app: EngineAppDeclaration, { targetName }: EngineAppCheckInfo): void {
  const where = `target "${targetName}"`;
  if (app.url !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.url, but a cua() target drives a desktop app: name it with app.bundleId or app.appPath`);
  }
  if (app.bundleId === undefined && app.appPath === undefined) {
    throw new ConfigurationError(
      'INVALID_CONFIG',
      `${where} needs app.bundleId (an AUMID, an executable, or an app name) or app.appPath: targets: [{ engine: cua(), app: { bundleId: 'notepad.exe' } }]`,
    );
  }
  if (app.permissions !== undefined) {
    throw new ConfigurationError('INVALID_CONFIG', `${where} declares app.permissions, which a Windows desktop app has no equivalent for`);
  }
}

/** This package's published version, read through require resolution. */
function ownVersion(): string {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  } catch {
    return 'unknown';
  }
}
