import { test, expect } from '@playwright/test';

test.describe('ROM Manager UI', () => {

  test('homepage loads without white screen', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.app-layout')).toBeVisible({ timeout: 15000 });
    const text = await page.locator('body').innerText();
    expect(text.length).toBeGreaterThan(0);
  });

  test('sidebar renders with collections after loading', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
    await expect(page.locator('.sidebar')).toBeVisible({ timeout: 5000 });
    // Sidebar should show something (collections or nav items)
    const navCount = await page.locator('.nav-item, .sidebar a, .sidebar button').count();
    expect(navCount).toBeGreaterThan(0);
  });

  test('clicking first collection navigates to game list', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
    const navItems = page.locator('.nav-item');
    const count = await navItems.count();
    test.skip(count === 0, 'No collections to click');
    await navItems.first().click();
    await page.waitForTimeout(3000);
    // Either browser (game list) or collection detail should appear
    const browser = page.locator('.browser');
    const detail = page.locator('.detail-header, .detail-section');
    await expect(browser.or(detail).first()).toBeVisible({ timeout: 10000 });
  });

  test('browse view shows games on load', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(5000);
    // Default view is browse — should show games or empty state
    const browser = page.locator('.browser');
    await expect(browser).toBeVisible({ timeout: 10000 });
  });

  test('search input is functional', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
    const searchInput = page.locator('.search-input');
    await expect(searchInput).toBeVisible({ timeout: 5000 });
    await searchInput.fill('1941');
    const val = await searchInput.inputValue();
    expect(val).toBe('1941');
  });

  test('view mode buttons toggle list/grid', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(3000);
    const viewBtns = page.locator('.view-btn');
    const count = await viewBtns.count();
    expect(count).toBeGreaterThanOrEqual(2);
    // Click second view button (should switch view mode)
    if (count >= 2) {
      await viewBtns.nth(1).click();
      await page.waitForTimeout(500);
    }
  });

  test('game grid cards render images', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(5000);
    const cards = page.locator('.grid-card');
    const count = await cards.count();
    if (count > 0) {
      // Cards should have images
      const imgs = page.locator('.grid-card img');
      expect(await imgs.count()).toBeGreaterThan(0);
    }
  });

  test('game list view renders rows', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(5000);
    // Switch to list view (first view button)
    const listBtn = page.locator('.view-btn').first();
    await listBtn.click();
    await page.waitForTimeout(1000);
    const items = page.locator('.list-item');
    const count = await items.count();
    if (count > 0) {
      // List items should have text
      const text = await items.first().innerText();
      expect(text.length).toBeGreaterThan(0);
    }
  });

});
