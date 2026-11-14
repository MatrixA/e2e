import { expect } from 'e2e';
import { test } from '../../dist/index.js';

test('a WinForms window through screen, expect, and the desktop fixture', async ({ app, screen, desktop }) => {
  await app.open();
  expect((await desktop.window()).title).toBe('e2e smoke');

  const name = screen.getByTestId('NameField');
  await expect(name).toBeVisible();
  await name.fill('Ada');
  await expect(name).toHaveValue('Ada');

  const agree = screen.getByRole('checkbox', { name: 'I agree' });
  await expect(agree).not.toBeChecked();
  await agree.check();
  await expect(agree).toBeChecked();

  await screen.getByRole('button', { name: 'Greet' }).click();
  await expect(screen.getByText('Hello, Ada!')).toBeVisible();

  await desktop.locator('type=Edit id=NameField').fill('');
  await name.pressSequentially('Grace');
  await expect(name).toHaveValue('Grace');
  await desktop.hotkey('Alt+F4');
});

test('an unchecked box blocks the greeting', async ({ app, screen }) => {
  await app.open();
  await screen.getByRole('button', { name: 'Greet' }).click();
  await expect(screen.getByText('Please agree first')).toBeVisible();
});
