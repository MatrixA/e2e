import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { E2EConfig } from 'e2e';
import { cua } from '../dist/index.js';

const form = path.join(path.dirname(fileURLToPath(import.meta.url)), 'form.ps1');

/** A live smoke run on a Windows desktop: `pnpm --filter @e2e-dev/cua smoke` after a build. */
export default {
  targets: [
    {
      name: 'winforms',
      engine: cua({ window: 'e2e smoke' }),
      app: {
        bundleId: 'powershell.exe',
        launchArguments: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', form],
      },
    },
  ],
  workers: 1,
} satisfies E2EConfig;
