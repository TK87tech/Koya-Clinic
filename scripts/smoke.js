import assert from 'node:assert/strict';

const base = process.env.BASE_URL;
assert.ok(base && process.env.API_KEY, 'Set BASE_URL and API_KEY first.');
const page = await fetch(base);
assert.equal(page.status, 200);
assert.match(await page.text(), /Koya Clinic/);
const unauthorized = await fetch(`${base}/slots`);
assert.equal(unauthorized.status, 401);
for (const path of ['/health', '/slots']) {
  const response = await fetch(`${base}${path}`, { headers: { 'X-API-Key': process.env.API_KEY } });
  assert.equal(response.status, 200, path);
  const body = await response.json();
  if (path === '/slots') assert.ok(Array.isArray(body.slots));
  console.log(`${path}: OK`);
}
console.log('Frontend/auth/database smoke checks passed. No data was changed.');
