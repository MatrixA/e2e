import { describe, expect, it } from 'vitest';
import type { SemanticNode } from 'e2e/engine';
import { chord, driverKey } from '../../src/keys.ts';
import { matchSelector, parseSelector } from '../../src/selector.ts';

describe('keys', () => {
  it('maps named keys and modifiers onto the driver names', () => {
    expect(driverKey('Enter')).toEqual({ key: 'enter', modifiers: [] });
    expect(driverKey('Shift+Tab')).toEqual({ key: 'tab', modifiers: ['shift'] });
    expect(driverKey('ControlOrMeta+a')).toEqual({ key: 'a', modifiers: ['ctrl'] });
    expect(driverKey('ArrowDown')).toEqual({ key: 'down', modifiers: [] });
    expect(chord('Control+Shift+s')).toEqual(['ctrl', 'shift', 's']);
  });

  it('holds Shift for an upper-case letter, and spells a space', () => {
    expect(driverKey('A')).toEqual({ key: 'a', modifiers: ['shift'] });
    expect(driverKey(' ')).toEqual({ key: 'space', modifiers: [] });
  });

  it('refuses a spelling outside the grammar', () => {
    expect(() => driverKey('Ctrl+s')).toThrow(/not a key/);
  });
});

describe('selectors', () => {
  const node = (fields: Partial<SemanticNode>): SemanticNode => ({ ref: { id: String(Math.random()), revision: '' }, ...fields });
  const nodes = [
    node({ role: 'textbox', name: 'File name:', testId: '1001', attributes: { controlType: 'Edit' } }),
    node({ role: 'button', name: 'Save', testId: '1', attributes: { controlType: 'Button' } }),
    node({ role: 'button', name: 'Cancel', testId: '2', attributes: { controlType: 'Button' } }),
  ];

  it('matches every term', () => {
    expect(matchSelector('id=1', nodes).map((match) => match.name)).toEqual(['Save']);
    expect(matchSelector('type=Button name="Cancel"', nodes).map((match) => match.name)).toEqual(['Cancel']);
    expect(matchSelector('role=textbox name~="file NAME"', nodes)).toHaveLength(1);
  });

  it('unquotes escapes', () => {
    expect(parseSelector('name="say \\"hi\\""')).toEqual([{ key: 'name', value: 'say "hi"', contains: false }]);
  });

  it('refuses a malformed selector', () => {
    expect(() => parseSelector('button')).toThrow(/not a desktop selector/);
    expect(() => parseSelector('id~=x')).toThrow(/not a desktop selector/);
  });
});
