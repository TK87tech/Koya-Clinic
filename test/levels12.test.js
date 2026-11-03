import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, slots, patient } from './helpers.js';

let f;
before(async () => { f = await fixture(); });
after(async () => { await f?.close(); });

test('Level 1: reset, chronological/provider slot listing, booking, persistent lookup', async () => {
  const data = slots();
  assert.equal((await f.request('/reset', { method: 'POST', body: { slots: [...data].reverse() } })).status, 200);
  const list = await f.request('/slots');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.slots.map((s) => s.id), data.map((s) => s.id));
  assert.ok(list.body.slots.every((s) => s.available));
  assert.equal((await f.request('/slots?provider=Dr%20Ade')).body.slots.length, 6);
  assert.equal((await f.request('/slots?provider=dr%20ade')).body.slots.length, 0);
  const created = await f.request('/bookings', { method: 'POST', body: patient() });
  assert.equal(created.status, 201);
  assert.equal(created.body.status, 'confirmed');
  assert.ok(created.body.id);
  assert.ok(Number.isFinite(Date.parse(created.body.created_at)));
  assert.deepEqual((await f.request(`/bookings/${created.body.id}`)).body, created.body);
  assert.equal((await f.request('/slots')).body.slots[0].available, false);
  assert.equal((await f.request('/bookings/missing')).status, 404);
  assert.equal((await f.request('/reset', { method: 'POST', body: { slots: [] } })).status, 200);
  assert.equal((await f.request(`/bookings/${created.body.id}`)).status, 404);
  assert.deepEqual((await f.request('/slots')).body, { slots: [] });
});

test('Level 2: every API route requires the exact key, before JSON parsing', async () => {
  for (const [method, path] of [['GET', '/slots'], ['POST', '/reset'], ['POST', '/bookings'], ['GET', '/bookings/x'], ['DELETE', '/bookings/x'], ['GET', '/bookings?email=a@b.com']]) {
    for (const headers of [{}, { 'X-API-Key': 'wrong' }]) {
      const result = await f.request(path, { method, auth: false, headers });
      assert.equal(result.status, 401);
      assert.equal(typeof result.body.error, 'string');
    }
  }
  assert.equal((await f.request('/bookings', { method: 'POST', auth: false, raw: '{bad' })).status, 401);
});

test('Level 2: missing, blank, wrongly typed and malformed details return JSON 400', async () => {
  await f.request('/reset', { method: 'POST', body: { slots: slots() } });
  let count = 0;
  for (const field of ['slot_id', 'name', 'email']) {
    for (const value of [undefined, '', '   ', null, 123, [], {}]) {
      const body = { ...patient('s1', `validation${count++}@example.com`), [field]: value };
      const result = await f.request('/bookings', { method: 'POST', body });
      assert.equal(result.status, 400, JSON.stringify(body));
      assert.equal(typeof result.body.error, 'string');
    }
  }
  for (const email of ['not-an-email', 'a@', '@b.com', 'a b@c.com', 'a@@b.com', 'a@b', 'a..b@example.com', '.ada@example.com', 'ada@example..com']) {
    assert.equal((await f.request('/bookings', { method: 'POST', body: patient('s1', email) })).status, 400);
  }
  for (const body of [null, [], 'string', 42]) {
    assert.equal((await f.request('/bookings', { method: 'POST', body })).status, 400);
  }
  assert.equal((await f.request('/bookings', { method: 'POST', raw: '{broken' })).status, 400);
  assert.equal((await f.request('/bookings', { method: 'POST', body: patient('s1', `${'x'.repeat(10000)}@example.com`) })).status, 400);
});

test('Level 2: trims name/email, lowercases email, rejects unknown and started slots', async () => {
  const data = slots();
  data.push({ id: 'past', provider: 'Dr Past', start: '2020-01-01T10:00:00Z', end: '2020-01-01T10:30:00Z' });
  await f.request('/reset', { method: 'POST', body: { slots: data } });
  assert.equal((await f.request('/bookings', { method: 'POST', body: patient('missing') })).status, 404);
  assert.equal((await f.request('/bookings', { method: 'POST', body: patient('past') })).status, 400);
  const result = await f.request('/bookings', { method: 'POST', body: { slot_id: 's1', name: '  Ada Obi  ', email: '  ADA@Example.COM  ' } });
  assert.equal(result.status, 201);
  assert.equal(result.body.name, 'Ada Obi');
  assert.equal(result.body.email, 'ada@example.com');
  assert.equal((await f.request('/slots')).body.slots[0].id, 'past');
});

test('Invalid reset is atomic and cannot erase existing slots', async () => {
  const data = slots(2);
  await f.request('/reset', { method: 'POST', body: { slots: data } });
  for (const body of [{}, { slots: [data[0], data[0]] }, { slots: [{ ...data[0], end: data[0].start }] }]) {
    assert.equal((await f.request('/reset', { method: 'POST', body })).status, 400);
    assert.equal((await f.request('/slots')).body.slots.length, 2);
  }
});

test('Public web page and assets load without exposing the API key', async () => {
  const response = await fetch(f.base);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Koya Clinic/);
  assert.ok(!html.includes('test-api-key'));
  assert.equal((await fetch(`${f.base}/app.js`)).status, 200);
  assert.equal((await fetch(`${f.base}/styles.css`)).status, 200);
});
