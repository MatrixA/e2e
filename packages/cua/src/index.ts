/**
 * `@e2e-dev/cua`: the Windows desktop engine. `cua()` is the engine factory
 * (also the default export, so `e2e mcp` can open it by package name), and
 * `test` is e2e's `test` typed with the contributed `desktop` fixture.
 */

import { test as base } from 'e2e';
import type { Desktop } from './desktop.ts';
import { cua } from './engine.ts';

export { cua };
export default cua;
export type { CuaOptions, Delivery } from './options.ts';
export type { Desktop, DesktopWindow } from './desktop.ts';

/** `test` with the `desktop` fixture typed; the same runtime `test` as `e2e`'s. */
export const test = base.extend<{ desktop: Desktop }>();
