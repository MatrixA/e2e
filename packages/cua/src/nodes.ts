/**
 * Projects one Cua Driver `get_window_state` snapshot of a Windows window
 * onto the contract's semantic tree.
 *
 * The driver reports two views of the same UI Automation walk: `elements`,
 * the actionable rows, each with a snapshot-bound `element_token`, a frame
 * in the window screenshot's pixels, and its parent row; and
 * `tree_markdown`, every row of the walk indented by depth, where an
 * actionable row carries its `[index]` and its automation id (`id=...`) and
 * a static row (a label's text) carries only its control type and name.
 * The tree is built from the markdown's nesting, so static text sits where
 * the app put it and `getByText` finds it; each indexed row takes its data
 * from `elements`. Without usable markdown the tree is the `elements`
 * parent chain alone.
 *
 * A node's id is its element token (`<snapshot>:<index>`): unique for the
 * window's lifetime, and stale the moment the driver replaces the snapshot,
 * which is exactly when the runner must re-resolve. Static rows get ids of
 * their own and no token; they can be read, not acted on.
 */

import type { SemanticNode } from 'e2e/engine';

/** The id of the observation root: the window. Stable across snapshots, as the viewport swipe requires. */
export const ROOT_ID = 'window';

/** One row of the driver's structured `elements`, as the engine reads it. */
export interface DriverElement {
  readonly element_index: number;
  readonly role: string;
  readonly element_token?: string;
  readonly label?: string;
  readonly value?: string;
  readonly enabled?: boolean;
  readonly selected?: boolean;
  readonly actions?: readonly string[];
  readonly parent_index?: number;
  readonly frame?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** What `get_window_state` returned, as the engine reads it. */
export interface WindowSnapshot {
  readonly snapshotId: string;
  readonly title: string;
  readonly elements: readonly DriverElement[];
  readonly markdown: string | undefined;
  readonly truncated: boolean;
  /** The screenshot's pixel size, which is the viewport rects are measured in. */
  readonly viewport: { readonly width: number; readonly height: number };
}

/** What the engine keeps about one node of the newest projection, to act on it. */
export interface NodeEntry {
  readonly node: SemanticNode;
  /** The driver's element token; absent for a static row. */
  readonly token?: string;
  /** UI Automation control type, as the driver reports it. */
  readonly controlType: string;
  /** The UIA patterns the driver found (`invoke`, `toggle`, `value`, `expand`, `scroll`). */
  readonly actions: readonly string[];
}

/** One projected snapshot. */
export interface Projection {
  readonly root: SemanticNode;
  readonly entries: ReadonlyMap<string, NodeEntry>;
  readonly truncated: boolean;
}

/** UI Automation control types onto the role vocabulary. A type not listed keeps its lower-cased name. */
const ROLES: Readonly<Record<string, string>> = {
  Button: 'button',
  SplitButton: 'button',
  Calendar: 'grid',
  CheckBox: 'checkbox',
  ComboBox: 'combobox',
  Edit: 'textbox',
  Hyperlink: 'link',
  Image: 'img',
  List: 'list',
  ListItem: 'listitem',
  Menu: 'menu',
  MenuBar: 'menubar',
  MenuItem: 'menuitem',
  ProgressBar: 'progressbar',
  RadioButton: 'radio',
  ScrollBar: 'scrollbar',
  Slider: 'slider',
  Spinner: 'spinbutton',
  StatusBar: 'status',
  Tab: 'tablist',
  TabItem: 'tab',
  Text: 'text',
  ToolBar: 'toolbar',
  AppBar: 'toolbar',
  ToolTip: 'tooltip',
  Tree: 'tree',
  TreeItem: 'treeitem',
  Group: 'group',
  Pane: 'group',
  Custom: 'generic',
  DataGrid: 'grid',
  DataItem: 'row',
  Table: 'table',
  Header: 'rowgroup',
  HeaderItem: 'columnheader',
  Document: 'document',
  Window: 'window',
  TitleBar: 'banner',
  Separator: 'separator',
  Thumb: 'generic',
};

/** Roles whose `selected` is a toggle's state: checked, not selected. */
const CHECKABLE = new Set(['checkbox', 'radio', 'switch']);
/** Roles whose `selected` is a selection item's state. */
const SELECTABLE = new Set(['listitem', 'tab', 'treeitem', 'row', 'option', 'menuitem']);
/** Roles whose value is the text a person typed or picked. */
const VALUED = new Set(['textbox', 'combobox', 'slider', 'spinbutton', 'progressbar', 'document']);

/** The contract role of a UI Automation control type. */
export function roleOf(controlType: string): string {
  return ROLES[controlType] ?? controlType.toLowerCase();
}

/** One row of `tree_markdown`. */
interface MarkdownRow {
  readonly depth: number;
  readonly index?: number;
  readonly controlType: string;
  readonly name?: string;
  readonly value?: string;
  readonly automationId?: string;
}

const ATTRIBUTE_KEYS = ['value="', 'id=', 'help="', 'enabled=', 'actions=['];
const INDEXED_ROW = /^- \[(\d+)\] (\S+)(.*)$/;
const STATIC_ROW = /^- (\S+)(.*)$/;

/**
 * Parses the driver's markdown rows; rows that do not have the row shape
 * (headers, notes) are skipped. Indexed rows read
 * `- [N] Type "name" [value="v" id=Auto enabled=false actions=[invoke]]`,
 * static rows `- Type "name" = "value"`.
 */
export function parseMarkdown(markdown: string): MarkdownRow[] {
  const rows: MarkdownRow[] = [];
  for (const raw of markdown.split('\n')) {
    const indent = /^ */.exec(raw)?.[0].length ?? 0;
    const line = raw.slice(indent).trimEnd();
    const indexed = INDEXED_ROW.exec(line);
    if (indexed !== null) {
      const [, index, controlType = '', rest = ''] = indexed;
      const { name, attributes } = splitIndexedRest(rest);
      const automationId = /(?:^| )id=([^\s\]]+)/.exec(attributes)?.[1];
      rows.push({
        depth: indent / 2,
        index: Number(index),
        controlType,
        ...(name === undefined ? {} : { name }),
        ...(automationId === undefined ? {} : { automationId }),
      });
      continue;
    }
    const plain = STATIC_ROW.exec(line);
    if (plain === null) continue;
    const [, controlType = '', rest = ''] = plain;
    const valued = /^ "(.*)" = "(.*)"$/.exec(rest);
    const named = valued === null ? /^ "(.*)"$/.exec(rest) : null;
    const name = valued?.[1] ?? named?.[1];
    const value = valued?.[2];
    rows.push({
      depth: indent / 2,
      controlType,
      ...(name === undefined ? {} : { name }),
      ...(value === undefined ? {} : { value }),
    });
  }
  return rows;
}

/** The name and the bracketed attributes after an indexed row's control type. */
function splitIndexedRest(rest: string): { name?: string; attributes: string } {
  if (!rest.startsWith(' "')) {
    return { attributes: rest.startsWith(' [') && rest.endsWith(']') ? rest.slice(2, -1) : '' };
  }
  let end = -1;
  for (const key of ATTRIBUTE_KEYS) {
    const at = rest.indexOf(`" [${key}`);
    if (at > 0 && (end < 0 || at < end)) end = at;
  }
  if (end > 0) return { name: rest.slice(2, end), attributes: rest.slice(end + 3, rest.endsWith(']') ? -1 : undefined) };
  return { name: rest.endsWith('"') ? rest.slice(2, -1) : rest.slice(2), attributes: '' };
}

/** A node under construction: its fields, what the engine keeps, and its children in document order. */
interface Built {
  readonly node: Omit<SemanticNode, 'children'>;
  readonly entry: Omit<NodeEntry, 'node'>;
  readonly children: Built[];
}

/** Projects one snapshot. */
export function project(snapshot: WindowSnapshot): Projection {
  const byIndex = new Map(snapshot.elements.map((element) => [element.element_index, element]));
  const rows = snapshot.markdown === undefined ? [] : parseMarkdown(snapshot.markdown);
  const usable = rows.some((row) => row.index !== undefined && byIndex.has(row.index));
  const built = usable ? fromMarkdown(snapshot, rows, byIndex) : fromElements(snapshot);
  const entries = new Map<string, NodeEntry>();
  const freeze = (item: Built): SemanticNode => {
    const node: SemanticNode = item.children.length === 0 ? item.node : { ...item.node, children: item.children.map(freeze) };
    entries.set(node.ref.id, { ...item.entry, node });
    return node;
  };
  const children = built.map(freeze);
  const root: SemanticNode = {
    ref: { id: ROOT_ID, revision: '' },
    role: 'window',
    ...(snapshot.title === '' ? {} : { name: snapshot.title }),
    rect: { x: 0, y: 0, width: snapshot.viewport.width, height: snapshot.viewport.height },
    ...(children.length === 0 ? {} : { children }),
  };
  return { root, entries, truncated: snapshot.truncated };
}

/** The tree from the markdown's nesting; elements the markdown left out hang off their parent row. */
function fromMarkdown(snapshot: WindowSnapshot, rows: readonly MarkdownRow[], byIndex: ReadonlyMap<number, DriverElement>): Built[] {
  const top: Built[] = [];
  const stack: { depth: number; item: Built | undefined }[] = [];
  const placed = new Map<number, Built>();
  rows.forEach((row, position) => {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= row.depth) stack.pop();
    const element = row.index === undefined ? undefined : byIndex.get(row.index);
    const item = element !== undefined ? fromElement(snapshot, element, row) : staticRow(snapshot, row, position);
    // A nameless static row (a layout pane) is structure only: its children
    // attach to the nearest row above it that was kept.
    if (item !== undefined) {
      const parent = [...stack].reverse().find((frame) => frame.item !== undefined)?.item;
      if (parent === undefined) top.push(item);
      else parent.children.push(item);
      if (element !== undefined) placed.set(element.element_index, item);
    }
    stack.push({ depth: row.depth, item });
  });
  for (const element of snapshot.elements) {
    if (placed.has(element.element_index)) continue;
    const item = fromElement(snapshot, element, undefined);
    const parent = element.parent_index === undefined ? undefined : placed.get(element.parent_index);
    if (parent === undefined) top.push(item);
    else parent.children.push(item);
    placed.set(element.element_index, item);
  }
  return top;
}

/** The tree from the elements' parent chain alone. */
function fromElements(snapshot: WindowSnapshot): Built[] {
  const items = new Map(snapshot.elements.map((element) => [element.element_index, fromElement(snapshot, element, undefined)]));
  const top: Built[] = [];
  for (const element of snapshot.elements) {
    const item = items.get(element.element_index)!;
    const parent = element.parent_index === undefined ? undefined : items.get(element.parent_index);
    if (parent === undefined || parent === item) top.push(item);
    else parent.children.push(item);
  }
  return top;
}

/** One actionable row. */
function fromElement(snapshot: WindowSnapshot, element: DriverElement, row: MarkdownRow | undefined): Built {
  const role = roleOf(element.role);
  const value = element.value === undefined || element.value === '' ? undefined : element.value;
  // `label` falls back to the value, then the automation id: the markdown row's
  // name is the accessible name proper; without a row, a label equal to the value is not one.
  const name = row !== undefined ? row.name : element.label !== value ? element.label : undefined;
  const automationId = row?.automationId;
  const states: Record<string, boolean> = {};
  if (element.enabled === false) states.disabled = true;
  if (element.selected !== undefined) {
    if (CHECKABLE.has(role) || (role === 'button' && element.actions?.includes('toggle') === true)) states.checked = element.selected;
    else if (SELECTABLE.has(role)) states.selected = element.selected;
  }
  const rect = element.frame === undefined ? undefined : { x: element.frame.x, y: element.frame.y, width: element.frame.w, height: element.frame.h };
  if (rect !== undefined && isHidden(rect, snapshot.viewport)) states.hidden = true;
  const id = element.element_token ?? `${snapshot.snapshotId}:${element.element_index}`;
  return {
    node: {
      ref: { id, revision: '' },
      role,
      ...(name === undefined || name === '' ? {} : { name }),
      ...(role === 'text' && name !== undefined && name !== '' ? { text: name } : {}),
      ...(value !== undefined && VALUED.has(role) ? { value } : {}),
      ...(automationId === undefined ? {} : { testId: automationId }),
      ...(Object.keys(states).length === 0 ? {} : { states }),
      ...(rect === undefined ? {} : { rect }),
      attributes: { controlType: element.role, ...(automationId === undefined ? {} : { automationId }) },
    },
    entry: {
      ...(element.element_token === undefined ? {} : { token: element.element_token }),
      controlType: element.role,
      actions: element.actions ?? [],
    },
    children: [],
  };
}

/** One static row: text a person reads. Rows with no name are structure only. */
function staticRow(snapshot: WindowSnapshot, row: MarkdownRow, position: number): Built | undefined {
  if (row.name === undefined || row.name === '') return undefined;
  const role = roleOf(row.controlType);
  return {
    node: {
      ref: { id: `${snapshot.snapshotId}:s${position}`, revision: '' },
      role,
      name: row.name,
      text: row.name,
      ...(row.value === undefined || !VALUED.has(role) ? {} : { value: row.value }),
      attributes: { controlType: row.controlType },
    },
    entry: { controlType: row.controlType, actions: [] },
    children: [],
  };
}

/** A node with no area, or wholly outside the window, is not visible. */
function isHidden(rect: { x: number; y: number; width: number; height: number }, viewport: { width: number; height: number }): boolean {
  if (rect.width <= 0 || rect.height <= 0) return true;
  return rect.x + rect.width <= 0 || rect.y + rect.height <= 0 || rect.x >= viewport.width || rect.y >= viewport.height;
}

/** Every node of a tree in document order, the root's descendants only. */
export function descendants(root: SemanticNode): SemanticNode[] {
  const out: SemanticNode[] = [];
  const walk = (node: SemanticNode): void => {
    for (const child of node.children ?? []) {
      out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** The centre of a node's box, in the window screenshot's pixels. */
export function centreOf(node: SemanticNode): { x: number; y: number } | undefined {
  if (node.rect === undefined) return undefined;
  return { x: node.rect.x + node.rect.width / 2, y: node.rect.y + node.rect.height / 2 };
}
