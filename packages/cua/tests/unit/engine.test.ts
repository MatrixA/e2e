import { describe, expect, it } from 'vitest';
import { type EngineAppInfo, type EngineHandle, type LocatorExpression, type OperationContext } from 'e2e/engine';
import { buildEngine } from '../../src/engine.ts';
import { resolveOptions, type CuaOptions } from '../../src/options.ts';
import { CuaSurface, launchTarget, pngSize } from '../../src/surface.ts';
import { FakeDriver, fakePng, notepad } from '../helpers/fake-driver.ts';

const operation = (): OperationContext => ({ signal: new AbortController().signal, timeoutMs: 5_000, runId: 'r', attemptId: 'a', origin: 'test' });
const cleanup = () => ({ signal: new AbortController().signal, timeoutMs: 5_000 });

async function open(options: CuaOptions = {}, app: EngineAppInfo = { bundleId: 'notepad.exe' }, platform: NodeJS.Platform = 'win32') {
  const driver = new FakeDriver();
  driver.windows.push(notepad());
  const engine = buildEngine(new CuaSurface(resolveOptions({ launchTimeoutMs: 1_000, ...options }), () => driver, platform));
  await engine.init!({
    runId: 'r',
    targetName: 'notepad',
    projectRoot: '/project',
    app,
    env: {},
    headed: false,
    workerSlot: 0,
    signal: new AbortController().signal,
    log: () => undefined,
  });
  await engine.startAttempt!({
    attemptId: 'a',
    artifactsDir: '/tmp/cua-test-artifacts',
    resolveSecret: async () => '',
    signal: new AbortController().signal,
    appLog: () => undefined,
    navigation: () => undefined,
    environment: () => undefined,
  });
  await engine.session!.restart!(operation());
  return { driver, engine };
}

const role = (value: string, name?: string): LocatorExpression => ({
  kind: 'query',
  query: { kind: 'role', value: { kind: 'string', value, exact: true }, ...(name === undefined ? {} : { name: { kind: 'string', value: name, exact: true } }) },
});

async function one(engine: EngineHandle, expression: LocatorExpression) {
  const matches = await engine.locate!(expression, operation());
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

describe('cua engine', () => {
  it('declares a Windows engine with one worker and the desktop fixture', async () => {
    const { engine } = await open();
    expect(engine.platform).toBe('windows');
    expect(engine.workers).toBe(1);
    expect(engine.fixtures).toHaveProperty('desktop');
    expect(engine.actions).not.toContain('hover');
  });

  it('refuses to start on another OS', async () => {
    await expect(open({}, { bundleId: 'notepad.exe' }, 'linux')).rejects.toThrow(/drives Windows desktops/);
  });

  it('launches the app and observes its front window', async () => {
    const { driver, engine } = await open();
    expect(driver.of('launch_app')[0]?.args).toEqual({ name: 'notepad.exe' });
    const snapshot = await engine.observe!(operation(), { pixels: true });
    expect(snapshot.location).toBe('app://Notepad/Untitled%20-%20Notepad');
    expect(snapshot.viewport).toEqual({ width: 800, height: 600 });
    expect(snapshot.pixels).toMatchObject({ width: 800, height: 600, scale: 1, mediaType: 'image/png' });
    expect(driver.of('get_window_state').at(-1)?.args).toMatchObject({ pid: 4242, window_id: 1001, tree_format: 'both', max_image_dimension: 0 });
  });

  it('taps a located node by its element token, in the foreground by default', async () => {
    const { driver, engine } = await open();
    const save = await one(engine, role('button', 'Save'));
    await engine.perform!(save.ref, { kind: 'tap' }, operation());
    expect(driver.of('click').at(-1)?.args).toEqual({ element_token: save.ref.id, delivery_mode: 'foreground' });
    await engine.perform!(save.ref, { kind: 'secondaryTap', modifiers: ['Shift'] }, operation());
    expect(driver.of('click').at(-1)?.args).toEqual({ element_token: save.ref.id, button: 'right', modifier: ['shift'], delivery_mode: 'foreground' });
  });

  it('honours background delivery', async () => {
    const { driver, engine } = await open({ delivery: 'background' });
    const save = await one(engine, role('button', 'Save'));
    await engine.perform!(save.ref, { kind: 'doubleTap' }, operation());
    expect(driver.of('click').at(-1)?.args).toMatchObject({ count: 2, delivery_mode: 'background' });
  });

  it('fills through the value pattern and checks only an unchecked box', async () => {
    const { driver, engine } = await open();
    const editor = await one(engine, { kind: 'query', query: { kind: 'testId', value: { kind: 'string', value: 'RichEditBox', exact: true } } });
    await engine.perform!(editor.ref, { kind: 'fill', value: 'typed', sensitive: false }, operation());
    expect(driver.of('set_value').at(-1)?.args).toEqual({ element_token: editor.ref.id, value: 'typed', delivery_mode: 'foreground' });

    const wrap = await one(engine, role('checkbox'));
    await engine.perform!(wrap.ref, { kind: 'uncheck' }, operation());
    expect(driver.of('click')).toHaveLength(0);
    await engine.perform!(wrap.ref, { kind: 'check' }, operation());
    expect(driver.of('click')).toHaveLength(1);
  });

  it('finds static text and refuses to act on it', async () => {
    const { engine } = await open();
    const text = await one(engine, { kind: 'query', query: { kind: 'text', value: { kind: 'string', value: 'Wrap long lines', exact: true } } });
    expect(text.role).toBe('text');
    await expect(engine.perform!(text.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE' });
  });

  it('answers desktop selectors', async () => {
    const { engine } = await open();
    const save = await one(engine, { kind: 'selector', selector: 'type=Button id=SaveButton' });
    expect(save.name).toBe('Save');
  });

  it('reports a ref from a replaced snapshot as stale', async () => {
    const { engine } = await open();
    const save = await one(engine, role('button', 'Save'));
    await engine.observe!(operation());
    await expect(engine.perform!(save.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
  });

  it('follows a dialog the app opens in front, and back', async () => {
    const { driver, engine } = await open();
    driver.windows.push({ windowId: 2002, title: 'Save as', zIndex: 5, markdown: '- [0] Button "Cancel"', elements: [{ element_index: 0, role: 'Button', label: 'Cancel', frame: { x: 1, y: 1, w: 50, h: 20 } }] });
    expect((await engine.observe!(operation())).location).toBe('app://Notepad/Save%20as');
    driver.windows.pop();
    expect((await engine.observe!(operation())).location).toBe('app://Notepad/Untitled%20-%20Notepad');
  });

  it('maps driver refusals onto the contract', async () => {
    const { driver, engine } = await open({ delivery: 'background' });
    const save = await one(engine, role('button', 'Save'));
    driver.refuse.set('click', 'background_unavailable');
    await expect(engine.perform!(save.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NOT_ACTIONABLE', message: expect.stringContaining("delivery: 'foreground'") });
    driver.refuse.set('click', 'stale_element_token');
    await expect(engine.perform!(save.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'NODE_STALE', retryable: true });
    driver.refuse.set('click', 'something_new');
    await expect(engine.perform!(save.ref, { kind: 'tap' }, operation())).rejects.toMatchObject({ code: 'ACTION_MAY_HAVE_COMMITTED' });
  });

  it('scrolls the window from its root and types to the focus', async () => {
    const { driver, engine } = await open();
    const snapshot = await engine.observe!(operation());
    await engine.perform!(snapshot.root.ref, { kind: 'swipe', direction: 'down' }, operation());
    expect(driver.of('scroll').at(-1)?.args).toMatchObject({ pid: 4242, window_id: 1001, direction: 'down', x: 400, y: 300 });
    await engine.keyboard!.type('hi', { replace: true }, operation());
    expect(driver.of('hotkey').at(-1)?.args).toMatchObject({ keys: ['ctrl', 'a'] });
    expect(driver.of('type_text').at(-1)?.args).toMatchObject({ text: 'hi', pid: 4242, window_id: 1001 });
    await engine.keyboard!.press('Control+s', operation());
    expect(driver.of('press_key').at(-1)?.args).toMatchObject({ key: 's', modifiers: ['ctrl'] });
  });

  it('quits the app at the end of the attempt, once', async () => {
    const { driver, engine } = await open();
    await engine.endAttempt!(cleanup());
    await engine.endAttempt!(cleanup());
    expect(driver.of('kill_app')).toEqual([{ name: 'kill_app', args: { pid: 4242 } }]);
    await expect(engine.observe!(operation())).rejects.toMatchObject({ code: 'INVALID_STATE' });
    await engine.dispose!(cleanup());
    expect(driver.shutdowns).toBe(1);
  });

  it('fails the launch when no matching window appears', async () => {
    await expect(open({ window: /Nope/, launchTimeoutMs: 300 })).rejects.toThrow(/showed no window matching/);
  });
});

describe('config', () => {
  it('validates the app at config load', () => {
    const engine = buildEngine(new CuaSurface(resolveOptions(undefined), () => new FakeDriver()));
    expect(() => engine.validateApp!({ url: 'https://x' }, { targetName: 't' })).toThrow(/app.url/);
    expect(() => engine.validateApp!({}, { targetName: 't' })).toThrow(/needs app.bundleId/);
    expect(() => engine.validateApp!({ bundleId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }, { targetName: 't' })).not.toThrow();
  });

  it('rejects unknown and malformed options', () => {
    expect(() => resolveOptions({ delivery: 'sideways' as never })).toThrow(/delivery/);
    expect(() => resolveOptions({ colour: 1 } as never)).toThrow(/colour/);
    expect(() => resolveOptions({ maxElements: 0 })).toThrow(/maxElements/);
  });

  it('launches packaged apps by AUMID, executables by path, others by name', () => {
    expect(launchTarget({ bundleId: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' }, '/p')).toEqual({ aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' });
    expect(launchTarget({ bundleId: 'C:\\Tools\\app.exe' }, '/p')).toEqual({ path: 'C:\\Tools\\app.exe' });
    expect(launchTarget({ bundleId: 'Paint' }, '/p')).toEqual({ name: 'Paint' });
    expect(launchTarget({ appPath: 'build/app.exe' }, '/p')).toEqual({ path: '/p/build/app.exe' });
  });

  it('reads a PNG size from its header', () => {
    expect(pngSize(new Uint8Array(Buffer.from(fakePng(320, 200), 'base64')))).toEqual({ width: 320, height: 200 });
    expect(pngSize(new Uint8Array(4))).toBeUndefined();
  });
});
