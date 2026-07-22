import { expect, test, type Page } from '@playwright/test';

// The tasks room seeds @planner with a durable six-item checklist (three states +
// explanation, >5 rows for the expansion control) and a task-free @idler. Live
// update, duplicate delivery, clearing, and a different-native-session are driven
// through the control port — no provider calls. Each test resets the fixture first
// so a mutating test cannot disturb a later one.
const TASKS = '/?room=tasks&token=next-e2e-token';
const CONTROL = `http://127.0.0.1:${process.env.CODOR_NEXT_E2E_CONTROL_PORT ?? '28138'}`;

async function control(path: string): Promise<void> {
  const res = await fetch(`${CONTROL}${path}`, { method: 'POST' });
  if (!res.ok) throw new Error(`${path} failed: ${await res.text()}`);
}

async function openTasks(page: Page): Promise<void> {
  await page.goto(TASKS);
  await expect(page.getByTestId('timeline')).toBeVisible();
  await expect(page.getByTestId('connection')).toHaveText(/Connected/);
}

test.describe('member task checklist', () => {
  test.beforeEach(async () => {
    await control('/tasks-reset');
  });

  test('renders only nonempty lists with three redundant status states and an explanation', async ({ page }) => {
    await openTasks(page);
    const tasks = page.getByTestId('member-planner-tasks');
    await expect(tasks).toBeVisible();
    await expect(page.getByTestId('member-idler-tasks')).toHaveCount(0); // nonempty only

    await expect(tasks.getByText('Completed', { exact: true }).first()).toBeVisible();
    await expect(tasks.getByText('In progress', { exact: true }).first()).toBeVisible();
    await expect(tasks.getByText('Pending', { exact: true }).first()).toBeVisible();
    await expect(tasks).toContainText('Wiring the refresh TTL config'); // in-progress active form
    await expect(tasks.locator('.nx-task.is-completed .nx-task-text')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(tasks.locator('.nx-tasklist-note')).toHaveText('Shipping the auth refactor');
  });

  test('collapses to five rows with a bounded, scrollable expansion', async ({ page }) => {
    await openTasks(page);
    const tasks = page.getByTestId('member-planner-tasks');
    await expect(tasks.locator('.nx-task')).toHaveCount(5);
    const toggle = page.getByTestId('member-planner-tasks-toggle');
    await expect(toggle).toHaveText('Show all 6');
    await toggle.click();
    await expect(tasks.locator('.nx-task')).toHaveCount(6);
    await expect(tasks.locator('.nx-tasklist.is-expanded')).toHaveCSS('max-height', '240px');
    await toggle.click();
    await expect(tasks.locator('.nx-task')).toHaveCount(5);
  });

  test('the toggle is keyboard operable', async ({ page }) => {
    await openTasks(page);
    const toggle = page.getByTestId('member-planner-tasks-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('member-planner-tasks').locator('.nx-task')).toHaveCount(6);
  });

  test('renders inside the responsive context dialog at mobile width', async ({ page }) => {
    // At mobile width the desktop connection pill is hidden; wait on the timeline and
    // the responsive context trigger instead, then let the list assertion auto-wait.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(TASKS);
    await expect(page.getByTestId('timeline')).toBeVisible();
    await page.getByTestId('mobile-kebab').click();
    const sheet = page.getByTestId('mobile-context');
    await expect(sheet.getByTestId('member-planner-tasks')).toBeVisible();
    await expect(sheet.getByTestId('member-planner-tasks').locator('.nx-task')).toHaveCount(5);
  });

  for (const scheme of ['light', 'dark'] as const) {
    test(`renders and is axe-clean in ${scheme} mode`, async ({ page }) => {
      await page.emulateMedia({ colorScheme: scheme });
      await openTasks(page);
      const tasks = page.getByTestId('member-planner-tasks');
      await expect(tasks).toBeVisible();
      await expect(tasks.getByText('In progress', { exact: true }).first()).toBeVisible();

      const { default: AxeBuilder } = await import('@axe-core/playwright');
      const { violations } = await new AxeBuilder({ page }).analyze();
      expect(violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target[0]}`)).toEqual([]);
    });
  }

  test('a duplicate delivery neither changes nor duplicates the list', async ({ page }) => {
    await openTasks(page);
    const tasks = page.getByTestId('member-planner-tasks');
    await expect(tasks.locator('.nx-task')).toHaveCount(5);
    await control('/tasks-duplicate'); // identical update — store no-op, no frame
    await expect(tasks.locator('.nx-task')).toHaveCount(5);
    await page.getByTestId('member-planner-tasks-toggle').click();
    await expect(tasks.locator('.nx-task')).toHaveCount(6); // still six, not twelve
  });

  test('updates live, persists across reload, and clears on an authoritative empty', async ({ page }) => {
    await openTasks(page);
    const tasks = page.getByTestId('member-planner-tasks');
    await control('/tasks-live');
    await expect(tasks).toContainText('Deleting the legacy cookie path'); // live upsert, no reload

    await page.reload();
    await expect(page.getByTestId('connection')).toHaveText(/Connected/);
    await expect(page.getByTestId('member-planner-tasks')).toContainText('Deleting the legacy cookie path'); // durable

    await control('/tasks-clear');
    await expect(page.getByTestId('member-planner-tasks')).toHaveCount(0);
  });

  test('clears the whole section when the native session changes', async ({ page }) => {
    await openTasks(page);
    await expect(page.getByTestId('member-planner-tasks')).toBeVisible();
    await control('/tasks-new-session'); // different session_ref clears the projection
    await expect(page.getByTestId('member-planner-tasks')).toHaveCount(0);
  });
});
