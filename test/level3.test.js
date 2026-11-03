import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, slots, patient } from './helpers.js';

let f;
before(async () => { f = await fixture(); });
after(async () => { await f?.close(); });

test('Level 3: 25 simultaneous requests produce exactly one confirmed booking', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  const results = await Promise.all(Array.from({ length: 25 }, (_, i) =>
    f.request('/bookings', { method: 'POST', body: patient('s1', `person${i}@example.com`) })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 24);
  const count = await f.db.query("SELECT count(*)::int AS total FROM bookings WHERE slot_id = 's1' AND status = 'confirmed'");
  assert.equal(count.rows[0].total, 1);
});

test('Level 3: cancellation frees the slot, persists, and cannot happen twice', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  const created = await f.request('/bookings', { method: 'POST', body: patient() });
  const path = `/bookings/${created.body.id}`;
  const results = await Promise.all([f.request(path, { method: 'DELETE' }), f.request(path, { method: 'DELETE' })]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await f.request(path)).body.status, 'cancelled');
  assert.equal((await f.request('/slots')).body.slots[0].available, true);
  const replacement = await f.request('/bookings', { method: 'POST', body: patient('s1', 'next@example.com') });
  assert.equal(replacement.status, 201);
  assert.notEqual(replacement.body.id, created.body.id);
  assert.equal((await f.request('/bookings/missing', { method: 'DELETE' })).status, 404);
});

test('Level 3: database constraint protects against writers bypassing the API', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  await f.request('/bookings', { method: 'POST', body: patient() });
  await assert.rejects(f.db.query("INSERT INTO bookings (id, slot_id, name, email, status) VALUES ('bypass', 's1', 'Other', 'other@example.com', 'confirmed')"),
    (error) => error.code === '23505');
});
