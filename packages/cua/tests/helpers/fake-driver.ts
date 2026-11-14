/**
 * A scripted Cua Driver that answers the Windows tools the engine calls with
 * the shapes `platform-windows` produces: `launch_app` and `list_windows`
 * structured content, and `get_window_state` with both `elements` and
 * `tree_markdown` and a PNG screenshot. Every call is recorded.
 */

import type { DriverClient, DriverToolResult } from '../../src/client.ts';
import type { DriverElement } from '../../src/nodes.ts';

export interface Call {
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface FakeWindow {
  windowId: number;
  title: string;
  zIndex: number;
  elements: DriverElement[];
  markdown: string;
}

/** A 1x1-header PNG of the given size: only the signature and IHDR, which is all the engine reads. */
export function fakePng(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return Buffer.from(bytes).toString('base64');
}

export class FakeDriver implements DriverClient {
  readonly calls: Call[] = [];
  readonly windows: FakeWindow[] = [];
  pid = 4242;
  snapshot = 1;
  running = false;
  shutdowns = 0;
  /** Scripted refusals: the next call of the tool answers with this error code. */
  readonly refuse = new Map<string, string>();

  async call(name: string, args: Readonly<Record<string, unknown>>, signal: AbortSignal): Promise<DriverToolResult> {
    if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    this.calls.push({ name, args });
    const refused = this.refuse.get(name);
    if (refused !== undefined) {
      this.refuse.delete(name);
      return { text: `${name} refused: ${refused}`, images: [], isError: true, errorCode: refused };
    }
    switch (name) {
      case 'get_screen_size':
        return ok({ width: 1920, height: 1080, scale_factor: 1 });
      case 'launch_app':
        this.running = true;
        return ok({ pid: this.pid, running: true, windows: [] });
      case 'kill_app':
        if (!this.running) return { text: 'no such process', images: [], isError: true, errorCode: 'not_found' };
        this.running = false;
        return ok({});
      case 'list_windows':
        return ok({
          windows: this.running
            ? this.windows.map((window) => ({
                window_id: window.windowId,
                pid: this.pid,
                title: window.title,
                app_name: 'Notepad',
                bounds: { x: 100, y: 100, width: 800, height: 600 },
                is_on_screen: true,
                z_index: window.zIndex,
              }))
            : [],
        });
      case 'get_window_state': {
        const window = this.windows.find((candidate) => candidate.windowId === args.window_id);
        if (window === undefined) return { text: 'window_not_found', images: [], isError: true, errorCode: 'window_not_found' };
        this.snapshot += 1;
        const id = `s${String(this.snapshot)}`;
        const png = { mimeType: 'image/png', dataBase64: fakePng(800, 600) };
        if (args.include_accessibility_tree === false) return { ...ok({ snapshot_id: id }), images: [png] };
        return {
          ...ok({
            pid: this.pid,
            window_id: window.windowId,
            snapshot_id: id,
            app_name: 'Notepad',
            window_title: window.title,
            tree_markdown: window.markdown,
            elements: window.elements.map((element) => ({ ...element, element_token: `${id}:${String(element.element_index)}` })),
            elements_complete: true,
          }),
          images: [png],
        };
      }
      default:
        return ok({});
    }
  }

  async shutdown(): Promise<void> {
    this.shutdowns += 1;
  }

  /** The calls of one tool. */
  of(name: string): Call[] {
    return this.calls.filter((call) => call.name === name);
  }
}

function ok(structured: Record<string, unknown>): DriverToolResult {
  return { text: 'ok', images: [], structuredJson: JSON.stringify(structured), isError: false };
}

/** A Notepad-like main window: a menu bar, an editor, a checkbox, a label, and a Save button. */
export function notepad(): FakeWindow {
  return {
    windowId: 1001,
    title: 'Untitled - Notepad',
    zIndex: 1,
    markdown: [
      '# Notepad (pid 4242) - Untitled - Notepad',
      '- [0] Window "Untitled - Notepad"',
      '  - [1] MenuBar "Application"',
      '    - [2] MenuItem "File" [actions=[expand]]',
      '  - Pane',
      '    - [3] Edit "Text editor" [value="hello" id=RichEditBox actions=[value]]',
      '    - Text "Wrap long lines"',
      '    - [4] CheckBox "Word wrap" [id=WrapToggle actions=[toggle]]',
      '  - [5] Button "Save" [id=SaveButton actions=[invoke]]',
      '  - [6] Button "Hidden" [actions=[invoke]]',
    ].join('\n'),
    elements: [
      { element_index: 0, role: 'Window', label: 'Untitled - Notepad', frame: { x: 0, y: 0, w: 800, h: 600 } },
      { element_index: 1, role: 'MenuBar', label: 'Application', parent_index: 0, frame: { x: 0, y: 30, w: 800, h: 20 } },
      { element_index: 2, role: 'MenuItem', label: 'File', parent_index: 1, actions: ['expand'], frame: { x: 0, y: 30, w: 40, h: 20 } },
      { element_index: 3, role: 'Edit', label: 'Text editor', value: 'hello', parent_index: 0, actions: ['value'], frame: { x: 0, y: 60, w: 800, h: 480 } },
      { element_index: 4, role: 'CheckBox', label: 'Word wrap', selected: false, parent_index: 0, actions: ['toggle'], frame: { x: 10, y: 550, w: 100, h: 20 } },
      { element_index: 5, role: 'Button', label: 'Save', parent_index: 0, actions: ['invoke'], frame: { x: 700, y: 560, w: 80, h: 30 } },
      { element_index: 6, role: 'Button', label: 'Hidden', parent_index: 0, actions: ['invoke'], frame: { x: 900, y: 900, w: 10, h: 10 } },
    ],
  };
}
