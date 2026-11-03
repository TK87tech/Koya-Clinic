import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { fixture, slots, key } from './helpers.js';

test('Browser: connect, choose a slot, book, view confirmation and look up reference on mobile', async () => {
  const f = await fixture();
  let browser;
  try {
    await f.request('/reset', { method: 'POST', body: { slots: slots() } });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(f.base);
    await page.getByLabel('Clinic API key').fill(key);
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await page.locator('.slot-button').first().waitFor();
    await page.locator('.slot-button').first().click();
    await page.getByLabel('Full name').fill('Browser Patient');
    await page.getByLabel('Email address', { exact: true }).fill('browser@example.com');
    await page.getByRole('button', { name: 'Confirm appointment' }).click();
    await page.locator('#confirmation:visible').waitFor();
    const id = await page.locator('#confirmation-id').textContent();
    assert.ok(id);
    assert.match(await page.locator('#confirmation-detail').textContent(), /Browser Patient/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByLabel('Email address or booking reference').fill(id);
    await page.getByRole('button', { name: 'Find bookings' }).click();
    await page.locator('.booking-row').waitFor();
    assert.match(await page.locator('.booking-row').textContent(), /Browser Patient/);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'mobile layout overflows');
    await page.getByRole('button', { name: 'Cancel visit', exact: true }).click();
    await page.getByRole('button', { name: 'Confirm cancellation?', exact: true }).click();
    await page.locator('.badge.cancelled').waitFor();
    assert.equal((await f.request(`/bookings/${id}`)).body.status, 'cancelled');
    await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
    assert.equal(await page.locator('#patient-name').inputValue(), '');
    assert.equal(await page.locator('.booking-row').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    await f.close();
  }
});
