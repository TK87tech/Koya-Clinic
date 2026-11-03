import express from 'express';
import validator from 'validator';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const hash = (value) => createHash('sha256').update(value).digest();
const error = (status, message) => ({ status, body: { error: message } });
const emailIsValid = (value) => typeof value === 'string' && validator.isEmail(value);
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const iso = (value) => new Date(value).toISOString();
const bookingJson = (row) => ({ ...row, created_at: iso(row.created_at) });
const send = (res, result) => res.status(result.status).set(result.headers || {}).json(result.body);

// Object member order is irrelevant; field values (including whitespace) are not.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function encodeCursor(value, key) {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}

function decodeCursor(cursor, email, key) {
  if (typeof cursor !== 'string' || cursor.length > 2048) throw new Error('invalid cursor');
  const [payload, signature, extra] = cursor.split('.');
  const expected = createHmac('sha256', key).update(payload || '').digest('base64url');
  if (extra !== undefined || !signature || !timingSafeEqual(hash(signature), hash(expected))) throw new Error('invalid cursor');
  const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (value.email !== email || typeof value.at !== 'string' || typeof value.id !== 'string') throw new Error('invalid cursor');
  return value;
}

function validateBooking(body) {
  if (!isObject(body)) return 'request body must be an object';
  if (!nonempty(body.slot_id)) return 'slot_id is required';
  if (!nonempty(body.name)) return 'name is required';
  if (!nonempty(body.email)) return 'email is required';
  if (!emailIsValid(body.email.trim())) return 'email is invalid';
  return null;
}

function validateSlots(body) {
  if (!isObject(body) || !Array.isArray(body.slots)) return 'slots must be an array';
  const ids = new Set();
  for (const slot of body.slots) {
    if (!isObject(slot) || !nonempty(slot.id) || !nonempty(slot.provider)) {
      return 'each slot needs a nonempty id and provider';
    }
    const dateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
    if (typeof slot.start !== 'string' || typeof slot.end !== 'string' ||
        !dateTime.test(slot.start) || !dateTime.test(slot.end) ||
        !validator.isISO8601(slot.start, { strict: true }) || !validator.isISO8601(slot.end, { strict: true }) ||
        !Number.isFinite(Date.parse(slot.start)) || !Number.isFinite(Date.parse(slot.end)) ||
        Date.parse(slot.end) <= Date.parse(slot.start)) return 'slot start and end must be valid date-times, with end after start';
    if (ids.has(slot.id)) return 'slot ids must be unique';
    ids.add(slot.id);
  }
  return null;
}

export function createApp({ database, apiKey }) {
  if (!apiKey) throw new Error('API_KEY is required.');
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    });
    next();
  });
  app.use(express.static(publicDirectory, { index: 'index.html' }));
  app.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!timingSafeEqual(hash(req.get('X-API-Key') || ''), hash(apiKey))) {
      return res.status(401).json({ error: 'invalid or missing API key' });
    }
    next();
  });
  app.use(express.json({ limit: '128kb', strict: false }));

  app.get('/health', async (req, res) => {
    const db = await database;
    await db.query('SELECT 1 FROM app_lock WHERE id = 1');
    res.json({ status: 'ok' });
  });

  app.post('/reset', async (req, res) => {
    const message = validateSlots(req.body);
    if (message) return res.status(400).json({ error: message });
    const db = await database;
    await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
      await tx.query('DELETE FROM idempotency_keys');
      await tx.query('DELETE FROM booking_attempts');
      await tx.query('DELETE FROM bookings');
      await tx.query('DELETE FROM slots');
      for (const slot of req.body.slots) {
        await tx.query('INSERT INTO slots (id, provider, start_at, end_at) VALUES ($1, $2, $3, $4)',
          [slot.id, slot.provider, slot.start, slot.end]);
      }
    });
    res.json({ ok: true });
  });

  app.get('/slots', async (req, res) => {
    if (req.query.provider !== undefined && typeof req.query.provider !== 'string') {
      return res.status(400).json({ error: 'provider must be a string' });
    }
    const db = await database;
    const { rows } = await db.query(`SELECT s.*, NOT EXISTS (
      SELECT 1 FROM bookings b WHERE b.slot_id = s.id AND b.status = 'confirmed'
    ) AS available FROM slots s WHERE ($1::text IS NULL OR provider = $1)
      ORDER BY start_at, id`, [req.query.provider ?? null]);
    res.json({ slots: rows.map((s) => ({ id: s.id, provider: s.provider,
      start: iso(s.start_at), end: iso(s.end_at), available: s.available })) });
  });

  app.post('/bookings', async (req, res) => {
    const db = await database;
    const result = await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
      // Count failed requests and retries too, using a rolling database-clock window.
      // Requests without any usable email have no email identity to rate-limit.
      if (isObject(req.body) && nonempty(req.body.email)) {
        const emailHash = hash(req.body.email.trim().toLowerCase()).toString('hex');
        await tx.query("DELETE FROM booking_attempts WHERE attempted_at <= clock_timestamp() - interval '1 minute'");
        const { rows } = await tx.query(`SELECT count(*)::int AS attempts,
          GREATEST(1, CEIL(EXTRACT(EPOCH FROM (min(attempted_at) + interval '1 minute' - clock_timestamp()))))::int AS retry
          FROM booking_attempts WHERE email_hash = $1`, [emailHash]);
        if (rows[0].attempts >= 5) return {
          ...error(429, 'too many booking attempts for this email'),
          headers: { 'Retry-After': String(rows[0].retry) },
        };
        await tx.query('INSERT INTO booking_attempts (email_hash) VALUES ($1)', [emailHash]);
      }
      const idempotencyKey = req.get('Idempotency-Key');
      const fingerprint = hash(canonical(req.body)).toString('hex');
      if (idempotencyKey) {
        const { rows } = await tx.query('SELECT * FROM idempotency_keys WHERE key = $1', [idempotencyKey]);
        if (rows.length) {
          if (rows[0].fingerprint !== fingerprint) return error(422, 'Idempotency-Key was already used with a different body');
          return { status: rows[0].status, body: rows[0].response };
        }
      }
      const createBooking = async () => {
        const message = validateBooking(req.body);
        if (message) return error(400, message);
        const { rows } = await tx.query('SELECT *, start_at <= clock_timestamp() AS started FROM slots WHERE id = $1', [req.body.slot_id]);
        if (!rows.length) return error(404, 'slot not found');
        if (rows[0].started) return error(400, 'slot has already started');
        const existing = await tx.query("SELECT id FROM bookings WHERE slot_id = $1 AND status = 'confirmed'", [req.body.slot_id]);
        if (existing.rows.length) return error(409, 'slot already booked');
        const inserted = await tx.query(`INSERT INTO bookings (id, slot_id, name, email, status)
          VALUES ($1, $2, $3, $4, 'confirmed') RETURNING *`,
        [randomUUID(), req.body.slot_id, req.body.name.trim(), req.body.email.trim().toLowerCase()]);
        return { status: 201, body: bookingJson(inserted.rows[0]) };
      };
      const outcome = await createBooking();
      if (idempotencyKey) {
        await tx.query('INSERT INTO idempotency_keys (key, fingerprint, status, response) VALUES ($1, $2, $3, $4::jsonb)',
          [idempotencyKey, fingerprint, outcome.status, JSON.stringify(outcome.body)]);
      }
      return outcome;
    });
    send(res, result);
  });

  app.get('/bookings', async (req, res) => {
    const { email: rawEmail, limit: rawLimit, cursor } = req.query;
    if (typeof rawEmail !== 'string' || !emailIsValid(rawEmail.trim())) return res.status(400).json({ error: 'a valid email is required' });
    const email = rawEmail.trim().toLowerCase();
    if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^\d+$/.test(rawLimit))) return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
    const limit = rawLimit === undefined ? 10 : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return res.status(400).json({ error: 'limit must be an integer from 1 to 50' });
    let after;
    if (cursor !== undefined) {
      try { after = decodeCursor(cursor, email, apiKey); }
      catch { return res.status(400).json({ error: 'invalid cursor' }); }
    }
    const db = await database;
    const { rows } = await db.query(`SELECT *, created_at::text AS cursor_time FROM bookings
      WHERE email = $1 AND ($2::timestamptz IS NULL OR (created_at, id) > ($2::timestamptz, $3::text))
      ORDER BY created_at, id LIMIT $4`, [email, after?.at ?? null, after?.id ?? null, limit + 1]);
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    res.json({
      bookings: page.map(({ cursor_time, ...row }) => bookingJson(row)),
      next_cursor: rows.length > limit ? encodeCursor({ email, at: last.cursor_time, id: last.id }, apiKey) : null,
    });
  });

  app.get('/bookings/:id', async (req, res) => {
    const db = await database;
    const { rows } = await db.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'booking not found' });
    res.json(bookingJson(rows[0]));
  });

  app.delete('/bookings/:id', async (req, res) => {
    const db = await database;
    const result = await db.transaction(async (tx) => {
      await tx.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
      const { rows } = await tx.query('SELECT * FROM bookings WHERE id = $1', [req.params.id]);
      if (!rows.length) return error(404, 'booking not found');
      if (rows[0].status === 'cancelled') return error(409, 'booking already cancelled');
      const cancelled = await tx.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1 RETURNING *", [req.params.id]);
      return { status: 200, body: bookingJson(cancelled.rows[0]) };
    });
    send(res, result);
  });

  app.use((req, res) => res.status(404).json({ error: 'endpoint not found' }));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'request body is too large' });
    console.error('Request failed:', err.code || err.name);
    res.status(500).json({ error: 'internal server error' });
  });
  return app;
}
