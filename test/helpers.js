import { createDatabase } from '../src/database.js';
import { createApp } from '../src/app.js';

export const key = 'test-api-key';
export async function fixture(url = 'pglite:') {
  const db = await createDatabase(url);
  await db.migrate();
  const app = createApp({ database: db, apiKey: key });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, base,
    request: async (path, { method = 'GET', body, headers = {}, auth = true, raw } = {}) => {
      const response = await fetch(`${base}${path}`, { method,
        headers: { ...(auth ? { 'X-API-Key': key } : {}), 'Content-Type': 'application/json', ...headers },
        body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      return { status: response.status, headers: response.headers, body: await response.json() };
    },
    close: async () => { await new Promise((resolve) => server.close(resolve)); await db.close(); },
  };
}

export function slots(count = 12) {
  return Array.from({ length: count }, (_, i) => ({
    id: `s${i + 1}`, provider: i % 2 ? 'Dr Ada' : 'Dr Ade',
    start: new Date(Date.now() + 86400000 + i * 1800000).toISOString(),
    end: new Date(Date.now() + 86400000 + (i + 1) * 1800000).toISOString(),
  }));
}
export const patient = (slot_id = 's1', email = 'ada@example.com') => ({ slot_id, name: 'Ada Obi', email });
