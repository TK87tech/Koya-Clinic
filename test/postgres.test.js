import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'node:net';
import { fixture, slots, patient } from './helpers.js';

async function freePort() {
  const server = createServer();
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

test('PostgreSQL: independent app instances share atomic booking, retry and rate-limit state', { timeout: 90000 }, async (t) => {
  let cluster;
  let first;
  let second;
  let url = process.env.TEST_DATABASE_URL;
  try {
    if (!url) {
      const { default: EmbeddedPostgres } = await import('embedded-postgres');
      await mkdir(resolve('.data'), { recursive: true });
      const port = await freePort();
      const password = randomUUID();
      cluster = new EmbeddedPostgres({ databaseDir: resolve(`.data/postgres-test-${randomUUID()}`),
        user: 'postgres', password, port, persistent: false, autoRehydrateSymlinks: true,
        // Synchronous test I/O avoids orphaned PG18 I/O workers on Windows shutdown.
        postgresFlags: ['-h', '127.0.0.1', '-c', 'io_method=sync'], onLog: () => {}, onError: (error) => console.error(error) });
      await cluster.initialise();
      await cluster.start();
      url = `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`;
    }
    first = await fixture(url);
    second = await fixture(url);
    const reset = () => first.request('/reset', { method: 'POST', body: { slots: slots(30) } });

    await t.test('two independent connection pools produce only one winner', async () => {
      await reset();
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) =>
        (i % 2 ? first : second).request('/bookings', { method: 'POST', body: patient('s1', `race${i}@example.com`) })));
      assert.equal(results.filter((r) => r.status === 201).length, 1);
      assert.equal(results.filter((r) => r.status === 409).length, 29);
    });

    await t.test('idempotency response and booking commit atomically across instances', async () => {
      await reset();
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) =>
        (i % 2 ? first : second).request('/bookings', { method: 'POST', body: patient(), headers: { 'Idempotency-Key': 'distributed' } })));
      for (const result of results) {
        assert.equal(result.status, 201);
        assert.deepEqual(result.body, results[0].body);
      }
      assert.equal((await first.request('/bookings?email=ada@example.com')).body.bookings.length, 1);
    });

    await t.test('rate limit counts failed attempts across instances without a race', async () => {
      await reset();
      const results = await Promise.all(Array.from({ length: 20 }, (_, i) =>
        (i % 2 ? first : second).request('/bookings', { method: 'POST', body: patient('missing') })));
      assert.equal(results.filter((r) => r.status === 404).length, 5);
      assert.equal(results.filter((r) => r.status === 429).length, 15);
    });

    await t.test('booking, retry and rate-limit state survive app shutdown and new connections', async () => {
      await reset();
      const options = { method: 'POST', body: patient(), headers: { 'Idempotency-Key': 'restart' } };
      const created = await first.request('/bookings', options);
      for (let i = 0; i < 3; i++) await second.request('/bookings', options);
      await first.close(); first = undefined;
      await second.close(); second = undefined;
      first = await fixture(url);
      assert.deepEqual((await first.request(`/bookings/${created.body.id}`)).body, created.body);
      const replay = await first.request('/bookings', options);
      assert.equal(replay.status, 201);
      assert.deepEqual(replay.body, created.body);
      assert.equal((await first.request('/bookings', options)).status, 429);
      assert.equal((await first.request(`/bookings/${created.body.id}`, { method: 'DELETE' })).status, 200);
      assert.equal((await first.request('/slots')).body.slots[0].available, true);
    });
  } finally {
    await first?.close();
    await second?.close();
    await cluster?.stop();
  }
});
