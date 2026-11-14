/** Options of `cua()`, checked at config load. */

import { ConfigurationError, rejectUnknownKeys } from 'e2e/engine';

/** How the driver delivers input to the app. */
export type Delivery = 'foreground' | 'background';

export interface CuaOptions {
  /**
   * Which of the app's windows the attempt drives, by title: a string the
   * title contains, or a pattern. Default: the app's front visible window.
   */
  readonly window?: string | RegExp;
  /**
   * `foreground` (default) briefly brings the window forward for pointer and
   * keyboard input and gives focus back after, which every control accepts.
   * `background` never takes focus, through UI Automation and posted
   * messages; controls that drop posted input (Chromium content, some
   * custom controls) then refuse with `NOT_ACTIONABLE` instead of being
   * brought forward.
   */
  readonly delivery?: Delivery;
  /** Most UI Automation rows one observation reads. Default 1000. */
  readonly maxElements?: number;
  /** How long `app.open()` waits for the app's window. Default 30 seconds. */
  readonly launchTimeoutMs?: number;
}

/** The options with defaults applied. */
export interface ResolvedOptions {
  readonly window: string | RegExp | undefined;
  readonly delivery: Delivery;
  readonly maxElements: number;
  readonly launchTimeoutMs: number;
}

/** Checks and completes the options; `INVALID_CONFIG` for a wrong one. */
export function resolveOptions(options: CuaOptions | undefined): ResolvedOptions {
  const given: CuaOptions = options ?? {};
  rejectUnknownKeys('cua() options', given, ['window', 'delivery', 'maxElements', 'launchTimeoutMs']);
  if (given.window !== undefined && typeof given.window !== 'string' && !(given.window instanceof RegExp)) {
    throw new ConfigurationError('INVALID_CONFIG', 'cua() window must be a string the title contains or a RegExp');
  }
  if (given.delivery !== undefined && given.delivery !== 'foreground' && given.delivery !== 'background') {
    throw new ConfigurationError('INVALID_CONFIG', "cua() delivery must be 'foreground' or 'background'");
  }
  return {
    window: given.window,
    delivery: given.delivery ?? 'foreground',
    maxElements: positiveInteger('maxElements', given.maxElements, 1000),
    launchTimeoutMs: positiveInteger('launchTimeoutMs', given.launchTimeoutMs, 30_000),
  };
}

function positiveInteger(name: string, value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new ConfigurationError('INVALID_CONFIG', `cua() ${name} must be a positive integer`);
  return value;
}
