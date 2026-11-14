import { describe, expect, it } from 'vitest';
import { descendants, parseMarkdown, project, roleOf } from '../../src/nodes.ts';
import { notepad } from '../helpers/fake-driver.ts';

function projected() {
  const window = notepad();
  return project({
    snapshotId: 's7',
    title: window.title,
    elements: window.elements.map((element) => ({ ...element, element_token: `s7:${String(element.element_index)}` })),
    markdown: window.markdown,
    truncated: false,
    viewport: { width: 800, height: 600 },
  });
}

describe('parseMarkdown', () => {
  it('reads indexed rows with their name and automation id, static rows with their name, and skips headers', () => {
    const rows = parseMarkdown(notepad().markdown);
    expect(rows[0]).toEqual({ depth: 0, index: 0, controlType: 'Window', name: 'Untitled - Notepad' });
    expect(rows.find((row) => row.index === 3)).toEqual({ depth: 2, index: 3, controlType: 'Edit', name: 'Text editor', automationId: 'RichEditBox' });
    expect(rows.find((row) => row.index === undefined && row.controlType === 'Text')).toEqual({ depth: 2, controlType: 'Text', name: 'Wrap long lines' });
    expect(rows.some((row) => row.controlType === '#')).toBe(false);
  });

  it('keeps a name that contains quotes and brackets', () => {
    const [row] = parseMarkdown('- [9] Button "Say "hi" [now]" [id=Greet]');
    expect(row).toMatchObject({ name: 'Say "hi" [now]', automationId: 'Greet' });
  });

  it('reads an indexed row with attributes and no name', () => {
    const [row] = parseMarkdown('- [2] Edit [value="x" id=Field]');
    expect(row).toEqual({ depth: 0, index: 2, controlType: 'Edit', automationId: 'Field' });
  });
});

describe('project', () => {
  it('nests rows the way the markdown indents them, dropping nameless panes', () => {
    const { root } = projected();
    expect(root.ref.id).toBe('window');
    const [window] = root.children ?? [];
    expect(window?.role).toBe('window');
    expect(window?.children?.map((child) => child.name)).toEqual(['Application', 'Text editor', 'Wrap long lines', 'Word wrap', 'Save', 'Hidden']);
  });

  it('maps control types, values, test ids, toggle state, and visibility', () => {
    const nodes = descendants(projected().root);
    const editor = nodes.find((node) => node.role === 'textbox');
    expect(editor).toMatchObject({ name: 'Text editor', value: 'hello', testId: 'RichEditBox', attributes: { controlType: 'Edit', automationId: 'RichEditBox' } });
    expect(nodes.find((node) => node.role === 'checkbox')?.states).toEqual({ checked: false });
    expect(nodes.find((node) => node.name === 'Hidden')?.states).toEqual({ hidden: true });
    expect(nodes.find((node) => node.role === 'text')).toMatchObject({ text: 'Wrap long lines' });
  });

  it('uses element tokens as ids and keeps them for actions; static rows carry none', () => {
    const { entries } = projected();
    expect(entries.get('s7:5')).toMatchObject({ token: 's7:5', controlType: 'Button', actions: ['invoke'] });
    const text = [...entries.values()].find((entry) => entry.controlType === 'Text');
    expect(text?.token).toBeUndefined();
  });

  it('falls back to the elements parent chain without markdown', () => {
    const window = notepad();
    const { root } = project({ snapshotId: 's1', title: 'x', elements: window.elements, markdown: undefined, truncated: true, viewport: { width: 800, height: 600 } });
    expect(root.children?.[0]?.children?.find((child) => child.role === 'menubar')?.children?.[0]?.name).toBe('File');
    // Without the markdown, a label equal to the value is not taken for a name.
    expect(descendants(root).find((node) => node.role === 'textbox')?.name).toBe('Text editor');
  });

  it('keeps an unknown control type as its lower-cased name', () => {
    expect(roleOf('SemanticZoom')).toBe('semanticzoom');
    expect(roleOf('Edit')).toBe('textbox');
  });
});
