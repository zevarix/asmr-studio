import {test,expect} from '@playwright/test';
test('a fresh listening page has explicit playback, an empty-state explanation, and keyboard focus', async ({page}) => {
  await page.route('**/api/assets',route=>route.fulfill({status:200,json:[]}));
  await page.goto('/?scene=empty-ui-test');
  await expect(page.getByRole('heading',{name:'ASMR Studio'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start listening'})).toBeDisabled();
  await expect(page.getByRole('status')).toContainText('Idle');
  await expect(page.getByText(/Import audio to start building your session/i)).toBeVisible();
  const initial = await page.evaluate(() => ({inactivePreview:[...document.querySelectorAll('audio')].every(audio=>audio.paused&&!audio.autoplay&&!audio.getAttribute('src')),scrollWidth:document.documentElement.scrollWidth,innerWidth:innerWidth}));
  expect(initial.inactivePreview).toBe(true);
  expect(initial.scrollWidth).toBeLessThanOrEqual(initial.innerWidth);
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
});
test('the structural mixer fits phone widths without hiding master controls', async ({page}) => {
  await page.setViewportSize({width:375,height:780});
  await page.route('**/api/assets',route=>route.fulfill({status:200,json:[]}));
  await page.goto('/?scene=empty-ui-test');
  await expect(page.getByRole('slider',{name:'Master volume'})).toBeVisible();
  await expect(page.getByRole('button',{name:'Start listening'})).toBeVisible();
  const sizes = await page.evaluate(() => ({scrollWidth:document.documentElement.scrollWidth,innerWidth:innerWidth}));
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.innerWidth);
});
