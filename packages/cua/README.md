# @e2e-dev/cua

Windows desktop engine for [e2e](https://e2e.com): Win32, WPF, WinUI,
Electron, and Tauri apps, read and driven through UI Automation with
[Cua Driver](https://github.com/trycua/cua/tree/main/libs/cua-driver).

```ts
// e2e.config.ts
import type { E2EConfig } from 'e2e';
import { cua } from '@e2e-dev/cua';

export default {
  targets: [{ name: 'notepad', engine: cua(), app: { bundleId: 'notepad.exe' } }],
} satisfies E2EConfig;
```

```ts
// tests/notepad.e2e.ts
import { expect } from 'e2e';
import { test } from '@e2e-dev/cua';

test('a note takes text', async ({ app, screen, desktop }) => {
  await app.open();
  await screen.getByRole('textbox', { name: 'Text editor' }).fill('Hello from e2e');
  await expect(screen.getByRole('textbox', { name: 'Text editor' })).toHaveValue('Hello from e2e');
  await desktop.hotkey('Control+s');
});
```

Run the tests in an interactive Windows session (a console or RDP login).
The [Windows guide](https://e2e.com/docs/windows) covers app names, the
`desktop` fixture, options, and what differs from the web.

## Smoke test on Windows

From a clone of this repository, in an interactive Windows session:

```bash
pnpm install
pnpm build
pnpm --filter @e2e-dev/cua smoke        # two tests against a WinForms window (smoke/form.ps1)
pnpm --filter @e2e-dev/cua smoke:dump   # writes smoke/dump.json: what Cua Driver reports on this machine
```

`smoke:dump` launches and then closes the WinForms window and Calculator. Close
your own Calculator first. The dump holds window titles and accessibility
trees and stays on the machine.

## License

Apache-2.0. Cua Driver is MIT licensed.
