/**
 * The contract's key grammar onto Cua Driver's key names on Windows:
 * `press_key` takes one key and its modifiers, `hotkey` a chord. Named keys
 * are lower case; `ControlOrMeta` is Control, as on every Windows app.
 */

import { EngineError, parseKey, type KeyModifier, type KeyName } from 'e2e/engine';

/** One key as Cua Driver's `press_key` takes it. */
export interface DriverKey {
  readonly key: string;
  readonly modifiers: readonly string[];
}

const NAMED: Readonly<Record<KeyName, string>> = {
  Enter: 'enter',
  Escape: 'escape',
  Tab: 'tab',
  Backspace: 'backspace',
  Delete: 'delete',
  Insert: 'insert',
  Space: 'space',
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Home: 'home',
  End: 'end',
  PageUp: 'pageup',
  PageDown: 'pagedown',
  F1: 'f1',
  F2: 'f2',
  F3: 'f3',
  F4: 'f4',
  F5: 'f5',
  F6: 'f6',
  F7: 'f7',
  F8: 'f8',
  F9: 'f9',
  F10: 'f10',
  F11: 'f11',
  F12: 'f12',
};

const MODIFIERS: Readonly<Record<KeyModifier, string>> = {
  Shift: 'shift',
  Control: 'ctrl',
  Alt: 'alt',
  Meta: 'win',
  ControlOrMeta: 'ctrl',
};

/**
 * Maps one key of the contract grammar. The runner has validated its shape;
 * a spelling that still does not parse (a `desktop.hotkey` chord the test
 * wrote) is `UNSUPPORTED_CAPABILITY`, never a guess.
 */
export function driverKey(spelling: string): DriverKey {
  const parsed = parseKey(spelling);
  if (parsed === undefined) {
    throw new EngineError('UNSUPPORTED_CAPABILITY', `"${spelling}" is not a key of the e2e key grammar (Control+a, Shift+Tab, Enter)`, {
      retryable: false,
    });
  }
  const modifiers = new Set(parsed.modifiers.map((modifier) => MODIFIERS[modifier]));
  if (parsed.key.kind === 'named') return { key: NAMED[parsed.key.name], modifiers: [...modifiers] };
  const char = parsed.key.char;
  if (char === ' ') return { key: 'space', modifiers: [...modifiers] };
  // The driver sends a letter as its virtual key, which types lower case:
  // `A` is typed as itself, so it holds Shift.
  if (/^[A-Z]$/.test(char)) {
    modifiers.add('shift');
    return { key: char.toLowerCase(), modifiers: [...modifiers] };
  }
  return { key: char, modifiers: [...modifiers] };
}

/** The chord `hotkey` takes: the modifiers, then the key. */
export function chord(spelling: string): string[] {
  const { key, modifiers } = driverKey(spelling);
  return [...modifiers, key];
}
