import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, slots, patient } from './helpers.js';

let f;
before(async () => { f = await fixture(); });
after(async () => { await f?.close(); });

test('Level 4: concurrent identical retries return the exact original 201 and booking ID', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  const results = await Promise.all(Array.from({ length: 4 }, () => f.request('/bookings', {
    method: 'POST', body: patient(), headers: { 'Idempotency-Key': 'same-request' },
  })));
  for (const result of results) {
    assert.equal(result.status, 201);
    assert.deepEqual(result.body, results[0].body);
  }
  const list = await f.request('/bookings?email=ADA@example.com');
  assert.equal(list.body.bookings.length, 1);
  assert.equal(list.body.next_cursor, null);
});

test('Level 4: reordered JSON replays; different body conflicts; cancelled response is still replayed', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  const headers = { 'Idempotency-Key': 'persistent-key' };
  const created = await f.request('/bookings', { method: 'POST', body: patient(), headers });
  const reordered = await f.request('/bookings', { method: 'POST', body: { email: 'ada@example.com', name: 'Ada Obi', slot_id: 's1' }, headers });
  assert.deepEqual(reordered.body, created.body);
  assert.equal((await f.request('/bookings', { method: 'POST', body: patient('s2'), headers })).status, 422);
  await f.request(`/bookings/${created.body.id}`, { method: 'DELETE' });
  const replayed = await f.request('/bookings', { method: 'POST', body: patient(), headers });
  assert.equal(replayed.status, 201);
  assert.deepEqual(replayed.body, created.body);
  assert.equal((await f.request(`/bookings/${created.body.id}`)).body.status, 'cancelled');
  assert.equal((await f.request('/slots')).body.slots[0].available, true);
});

test('Level 4: failed response is replayable and reset clears idempotency records', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  const headers = { 'Idempotency-Key': 'failed-key' };
  const body = patient('not-found');
  const failure = await f.request('/bookings', { method: 'POST', body, headers });
  const retry = await f.request('/bookings', { method: 'POST', body, headers });
  assert.equal(failure.status, 404);
  assert.equal(retry.status, 404);
  assert.deepEqual(retry.body, failure.body);
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  assert.equal((await f.request('/bookings', { method: 'POST', body: patient(), headers })).status, 201);
});

test('Level 4: stable cursor pagination handles microseconds, tied timestamps, and cancellation', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  // Seed a historical list directly so rate limiting does not affect pagination testing.
  for (let i = 0; i < 11; i++) {
    await f.db.query(`INSERT INTO bookings (id, slot_id, name, email, status, created_at)
      VALUES ($1, $2, 'Ada', 'ada@example.com', $3, $4)`,
    [`b${String(i).padStart(2, '0')}`, `s${i + 1}`, i === 3 ? 'cancelled' : 'confirmed',
      i < 5 ? '2026-01-01 00:00:00.123456+00' : '2026-01-01 00:00:00.123789+00']);
  }
  const defaultPage = await f.request('/bookings?email=ADA@EXAMPLE.COM');
  assert.equal(defaultPage.body.bookings.length, 10);
  assert.ok(defaultPage.body.next_cursor);
  const seen = [];
  let cursor;
  do {
    const query = new URLSearchParams({ email: 'ADA@EXAMPLE.COM', limit: '2' });
    if (cursor) query.set('cursor', cursor);
    const result = await f.request(`/bookings?${query}`);
    assert.equal(result.status, 200);
    seen.push(...result.body.bookings.map((b) => b.id));
    cursor = result.body.next_cursor;
  } while (cursor);
  assert.equal(cursor, null);
  assert.deepEqual(seen, Array.from({ length: 11 }, (_, i) => `b${String(i).padStart(2, '0')}`));
  assert.deepEqual((await f.request('/bookings?email=unknown@example.com')).body, { bookings: [], next_cursor: null });
  assert.equal((await f.request(`/bookings?email=other@example.com&cursor=${defaultPage.body.next_cursor}`)).status, 400);
  assert.equal((await f.request('/bookings?email=ada@example.com&cursor=garbage')).status, 400);
  for (const limit of ['0', '-1', '51', '1.5', 'abc', '', '1e1']) {
    assert.equal((await f.request(`/bookings?email=ada@example.com&limit=${limit}`)).status, 400, limit);
  }
  assert.equal((await f.request('/bookings?email=ada@example.com&limit=1&limit=2')).status, 400);
  assert.equal((await f.request('/bookings')).status, 400);
});
