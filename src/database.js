import pg from 'pg';
import { mkdir } from 'node:fs/promises';

export const schema = `
  CREATE TABLE IF NOT EXISTS app_lock (
    id integer PRIMARY KEY CHECK (id = 1)
  );
  INSERT INTO app_lock (id) VALUES (1) ON CONFLICT DO NOTHING;
  CREATE TABLE IF NOT EXISTS slots (
    id text PRIMARY KEY,
    provider text NOT NULL,
    start_at timestamptz NOT NULL,
    end_at timestamptz NOT NULL CHECK (end_at > start_at)
  );
  CREATE TABLE IF NOT EXISTS bookings (
    id text PRIMARY KEY,
    slot_id text NOT NULL REFERENCES slots(id),
    name text NOT NULL,
    email text NOT NULL,
    status text NOT NULL CHECK (status IN ('confirmed', 'cancelled')),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE INDEX IF NOT EXISTS bookings_person ON bookings (email, created_at, id);
  CREATE UNIQUE INDEX IF NOT EXISTS one_confirmed_booking_per_slot
    ON bookings (slot_id) WHERE status = 'confirmed';
  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key text PRIMARY KEY,
    fingerprint text NOT NULL,
    status integer NOT NULL,
    response jsonb NOT NULL
  );
  CREATE TABLE IF NOT EXISTS booking_attempts (
    id bigserial PRIMARY KEY,
    email_hash text NOT NULL,
    attempted_at timestamptz NOT NULL DEFAULT clock_timestamp()
  );
  CREATE INDEX IF NOT EXISTS booking_attempts_email ON booking_attempts (email_hash, attempted_at);
  CREATE INDEX IF NOT EXISTS booking_attempts_expiry ON booking_attempts (attempted_at);
`;

export async function createDatabase(url) {
  if (!url) throw new Error('DATABASE_URL is required. See .env.example.');
  if (url.startsWith('pglite:')) {
    if (process.env.VERCEL) throw new Error('Vercel requires an external PostgreSQL database.');
    const { PGlite } = await import('@electric-sql/pglite');
    const directory = url.slice(7);
    if (directory) await mkdir(directory, { recursive: true });
    const client = new PGlite(directory || undefined);
    await client.waitReady;
    return {
      query: (sql, params) => client.query(sql, params),
      migrate: () => client.exec(schema),
      transaction: (fn) => client.transaction(fn),
      close: () => client.close(),
    };
  }
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 10000,
    allowExitOnIdle: true,
  });
  pool.on('error', () => console.error('Idle database connection failed.'));
  return {
    query: (sql, params) => pool.query(sql, params),
    migrate: async () => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(726031)');
        await client.query(schema);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    transaction: async (fn) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
