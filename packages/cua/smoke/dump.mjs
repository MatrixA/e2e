// Records what Cua Driver reports on this Windows machine, to check the
// engine's assumptions against the real driver: the tree_markdown row
// format, element frames against the screenshot size, and which process
// owns a packaged app's window (Calculator; it is closed afterwards, so
// close your own Calculator first). Writes smoke/dump.json, which holds the
// windows' titles and accessibility trees; nothing is sent anywhere.
//
//   pnpm --filter @e2e-dev/cua smoke:dump
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CuaDriver } from '@trycua/cua-driver';

const here = path.dirname(fileURLToPath(import.meta.url));
const driver = CuaDriver.create(undefined);
const out = { platform: process.platform, arch: process.arch, apps: {} };

async function call(name, args) {
  let result;
  try {
    result = await driver.callTool(name, JSON.stringify(args));
  } catch (error) {
    return { thrown: String(error?.message ?? error) };
  }
  return {
    isError: result.isError,
    errorCode: result.errorCode,
    text: result.text,
    structured: result.structuredJson ? JSON.parse(result.structuredJson) : undefined,
    images: result.images.map((image) => ({ mimeType: image.mimeType, ...pngSize(image) })),
  };
}

function pngSize(image) {
  if (image.mimeType !== 'image/png') return {};
  const bytes = Buffer.from(image.dataBase64, 'base64');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function probe(label, launchArgs) {
  const record = { launch: await call('launch_app', launchArgs) };
  const pid = record.launch.structured?.pid;
  out.apps[label] = record;
  if (typeof pid !== 'number') return;
  await sleep(3000);
  record.windowsForPid = await call('list_windows', { pid });
  const window = (record.windowsForPid.structured?.windows ?? []).find((candidate) => candidate.is_on_screen !== false);
  if (window === undefined) {
    // Where did the window go? Everything on screen, for a packaged app hosted elsewhere.
    record.allWindows = await call('list_windows', { on_screen_only: true });
  } else {
    record.state = await call('get_window_state', {
      pid,
      window_id: window.window_id,
      tree_format: 'both',
      include_screenshot: true,
      max_image_dimension: 0,
      max_elements: 1000,
    });
  }
  record.kill = await call('kill_app', { pid });
}

try {
  out.screen = await call('get_screen_size', {});
  await probe('winforms', {
    name: 'powershell.exe',
    additional_arguments: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', path.join(here, 'form.ps1')],
  });
  await probe('calculator', { aumid: 'Microsoft.WindowsCalculator_8wekyb3d8bbwe!App' });
} catch (error) {
  out.error = String(error?.stack ?? error);
} finally {
  writeFileSync(path.join(here, 'dump.json'), JSON.stringify(out, null, 2));
  await driver.shutdown();
  console.log(`wrote ${path.join(here, 'dump.json')}`);
}
