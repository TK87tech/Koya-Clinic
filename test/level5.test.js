import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, slots, patient } from './helpers.js';

let f;
before(async () => { f = await fixture(); });
after(async () => { await f?.close(); });

test('Level 5: failures count, normalized emails share a limit, other emails are independent', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  const cases = [
    { ...patient(), name: '' },
    patient('missing'),
    patient('s1', ' ADA@EXAMPLE.COM '),
    patient('s1'),
    { ...patient(), slot_id: '' },
  ];
  const expected = [400, 404, 201, 409, 400];
  for (let i = 0; i < cases.length; i++) assert.equal((await f.request('/bookings', { method: 'POST', body: cases[i] })).status, expected[i]);
  const sixth = await f.request('/bookings', { method: 'POST', body: patient('s2', 'Ada@Example.com') });
  assert.equal(sixth.status, 429);
  assert.match(sixth.headers.get('Retry-After'), /^\d+$/);
  assert.ok(Number(sixth.headers.get('Retry-After')) >= 1);
  assert.ok(Number(sixth.headers.get('Retry-After')) <= 60);
  assert.equal((await f.request('/bookings', { method: 'POST', body: patient('s2', 'other@example.com') })).status, 201);
});

test('Level 5: simultaneous attempts cannot bypass the five-attempt limit', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots(20) } });
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
    f.request('/bookings', { method: 'POST', body: patient(`s${i + 1}`) })));
  assert.equal(results.filter((r) => r.status === 201).length, 5);
  assert.equal(results.filter((r) => r.status === 429).length, 15);
  assert.equal((await f.request('/bookings?email=ada@example.com')).body.bookings.length, 5);
});

test('Level 5: rolling window expires and a blocked request does not prolong it', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  for (let i = 0; i < 5; i++) await f.request('/bookings', { method: 'POST', body: patient('missing') });
  await f.db.query("UPDATE booking_attempts SET attempted_at = clock_timestamp() - interval '30 seconds'");
  const blocked = await f.request('/bookings', { method: 'POST', body: patient() });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('Retry-After')) <= 30);
  assert.equal((await f.db.query('SELECT count(*)::int AS total FROM booking_attempts')).rows[0].total, 5);
  // Advance stored attempts rather than slowing the suite down with a 60-second sleep.
  await f.db.query("UPDATE booking_attempts SET attempted_at = clock_timestamp() - interval '61 seconds'");
  assert.equal((await f.request('/bookings', { method: 'POST', body: patient() })).status, 201);
});

test('Level 5: idempotent retries are attempts, but never duplicate a booking', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  const options = { method: 'POST', body: patient(), headers: { 'Idempotency-Key': 'rate-retry' } };
  const first = await f.request('/bookings', options);
  for (let i = 0; i < 4; i++) {
    const replay = await f.request('/bookings', options);
    assert.equal(replay.status, 201);
    assert.deepEqual(replay.body, first.body);
  }
  assert.equal((await f.request('/bookings', options)).status, 429);
  await f.db.query("UPDATE booking_attempts SET attempted_at = clock_timestamp() - interval '61 seconds'");
  const retry = await f.request('/bookings', options);
  assert.equal(retry.status, 201);
  assert.deepEqual(retry.body, first.body);
  assert.equal((await f.request('/bookings?email=ada@example.com')).body.bookings.length, 1);
});

test('Level 5: reset clears attempt state; unauthorized requests do not consume attempts', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  for (let i = 0; i < 6; i++) assert.equal((await f.request('/bookings', { method: 'POST', body: patient(), auth: false })).status, 401);
  assert.equal((await f.request('/bookings', { method: 'POST', body: patient() })).status, 201);
  for (let i = 0; i < 5; i++) await f.request('/bookings', { method: 'POST', body: patient('missing') });
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  assert.equal((await f.request('/bookings', { method: 'POST', body: patient() })).status, 201);
});
