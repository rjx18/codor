import { expect, test, type Page } from '@playwright/test';

// The tasks room seeds @planner with a durable six-item checklist (three states +
// explanation, >5 rows for the expansion control) and a task-free @idler. Live
// update and clearing run through the control port — no provider calls. Mutating
// tests run last so they cannot disturb the seeded rendering assertions.
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
  test('renders only nonempty lists with three redundant status states and an explanation', async ({ page }) => {
    await openTasks(page);
    const tasks = page.getByTestId('member-planner-tasks');
    await expect(tasks).toBeVisible();
    await expect(page.getByTestId('member-idler-tasks')).toHaveCount(0); // nonempty only

    // Text-redundant state, never color-only.
    await expect(tasks.getByText('Completed', { exact: true }).first()).toBeVisible();
    await expect(tasks.getByText('In progress', { exact: true }).first()).toBeVisible();
    await expect(tasks.getByText('Pending', { exact: true }).first()).toBeVisible();
    // In-progress shows the active form; completed content is muted and struck.
    await expect(tasks).toContainText('Wiring the refresh TTL config');
    await expect(tasks.locator('.nx-task.is-completed .nx-task-text')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(tasks.locator('.nx-tasklist-note')).toHaveText('Shipping the auth refactor');
  });

  test('collapses to five rows with a bounded, scrollable expansion', async ({ page }) => {
    await openTasks(page);
    const tasks = page.getByTestId('member-planner-tasks');
    await expect(tasks.locator('.nx-task')).toHaveCount(5); // six seeded, collapsed to five
    const toggle = page.getByTestId('member-planner-tasks-toggle');
    await expect(toggle).toHaveText('Show all 6');
    await toggle.click();
    await expect(tasks.locator('.nx-task')).toHaveCount(6);
    await expect(tasks.locator('.nx-tasklist.is-expanded')).toHaveCSS('max-height', '240px');
    await toggle.click();
    await expect(tasks.locator('.nx-task')).toHaveCount(5);
  });

  test('the toggle is keyboard operable and the checklist is axe-clean', async ({ page }) => {
    await openTasks(page);
    const toggle = page.getByTestId('member-planner-tasks-toggle');
    await toggle.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('member-planner-tasks').locator('.nx-task')).toHaveCount(6);

    const { default: AxeBuilder } = await import('@axe-core/playwright');
    const { violations } = await new AxeBuilder({ page }).analyze();
    expect(violations.map((violation) => `${violation.id}: ${violation.nodes[0]?.target[0]}`)).toEqual([]);
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
    await expect(page.getByTestId('member-planner-tasks')).toHaveCount(0); // empty clears the whole section
  });
});
