import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, slots, patient } from './helpers.js';

test('Local database creates nested directories and retains bookings after database shutdown', async () => {
  const directory = resolve(`.data/persistence-${randomUUID()}`);
  const url = `pglite:${directory}/nested/database`;
  let f;
  try {
    f = await fixture(url);
    await f.request('/reset', { method: 'POST', body: { slots: slots() } });
    const options = { method: 'POST', body: patient(), headers: { 'Idempotency-Key': 'disk-retry' } };
    const created = await f.request('/bookings', options);
    assert.equal(created.status, 201);
    await f.close(); f = undefined;
    f = await fixture(url);
    assert.deepEqual((await f.request(`/bookings/${created.body.id}`)).body, created.body);
    assert.equal((await f.request('/slots')).body.slots[0].available, false);
    const retry = await f.request('/bookings', options);
    assert.equal(retry.status, 201);
    assert.deepEqual(retry.body, created.body);
    assert.equal((await f.db.query('SELECT count(*)::int AS count FROM booking_attempts')).rows[0].count, 2);
  } finally {
    await f?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
