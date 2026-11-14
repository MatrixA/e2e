/**
 * The `desktop` fixture: what a Windows test does that `screen` and `app`
 * have no words for. Each call is recorded as a `desktop.<method>` step,
 * bounded by the action timeout.
 */

import type { EngineFixtureContext, Locator } from 'e2e/engine';
import type { CuaSurface } from './surface.ts';

/** One top-level window of the app. */
export interface DesktopWindow {
  readonly title: string;
  /** Position and size on the desktop, in pixels; undefined when the driver reports none. */
  readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number } | undefined;
}

/** Deterministic desktop control, as the `desktop` fixture. */
export interface Desktop {
  /**
   * A locator from a desktop selector, for nodes the `screen` queries cannot
   * name: `id=SaveButton`, `type=Edit name~="file name"`, `role=button name="OK"`.
   */
  locator(selector: string): Locator;
  /** Invokes one application-menu path, outermost first: `['File', 'Save As...']`. */
  menu(path: readonly string[]): Promise<void>;
  /** Sends one key chord to the window: `'Control+s'`, `'Alt+F4'`, `'Shift+Tab'`. */
  hotkey(chord: string): Promise<void>;
  /** The window the engine drives: the app's front window, a dialog while one is open. */
  window(): Promise<DesktopWindow>;
  /** Every window the app has open, front first when Windows reports stacking. */
  windows(): Promise<readonly DesktopWindow[]>;
}

/** Builds the fixture for one attempt. */
export function createDesktopFixture(surface: CuaSurface, context: EngineFixtureContext): Desktop {
  const desktop: Desktop = {
    locator: (selector) => context.locator({ kind: 'selector', selector }),
    async menu(path) {
      await surface.menu(path, context.operation());
    },
    async hotkey(chord) {
      await surface.hotkey(chord, context.operation());
    },
    async window() {
      const { current } = await surface.windows(context.operation());
      return { title: current.title, bounds: current.bounds };
    },
    async windows() {
      const { all } = await surface.windows(context.operation());
      return [...all]
        .sort((a, b) => (b.zIndex ?? 0) - (a.zIndex ?? 0))
        .map((window) => ({ title: window.title, bounds: window.bounds }));
    },
  };
  return context.fixture('desktop', desktop, {
    menu: { kind: 'resource', label: (path) => path.join(' > ') },
    hotkey: { kind: 'resource', label: (chord) => chord },
    window: { kind: 'resource' },
    windows: { kind: 'resource' },
  });
}
