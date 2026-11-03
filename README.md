# Koya Clinic — booking API & web app

A clinic booking app implementing all five levels of the [Koya assessment contract](https://koyaacademy.com/assessment-api). Express serves the JSON API, PostgreSQL stores every booking, and a responsive vanilla-JavaScript page provides booking, confirmation, lookup, pagination, and cancellation.

**Handoff status:** implemented and locally tested. HTTPS deployment is prepared for Vercel + Neon but has not been performed. Hosting account access was deferred during the handoff.

## Run locally

Requires **Node.js 22.9+** (Node 24 recommended).

```sh
npm ci
```

The supplied, ignored `.env.local` contains a generated local API key and `DATABASE_URL=pglite:./.data/local`. If starting from a fresh copy, copy `.env.example` to `.env.local` and set your own random `API_KEY`.

```sh
npm run db:seed
npm start
```

Open **http://localhost:3000** and enter the `API_KEY` from `.env.local`. Choose a practitioner/date/time, enter your name and email, and confirm. The confirmation includes a booking reference. Use **My bookings** to search by email or reference and cancel appointments.

- Local PGlite is an actual embedded PostgreSQL engine; `.data/local` persists across requests and restarts. Run only one local server against that directory.
- `npm run db:seed` adds 180 future demo slots only when the slot table is empty. It never replaces bookings or an existing schedule.
- `npm start` applies the idempotent schema migration before starting. `npm run dev` adds file watching.
- The API key is entered by the user and kept only in tab memory. It is not embedded in frontend code or stored in browser storage.
- This is an assessment/demo clinic. It does not send emails. All users with the shared assessment API key have the contract’s full API access, including `/reset`.

## Implemented contract

All API requests require `X-API-Key`. JSON errors are always `{"error":"message"}`. The public web page and its static assets do not require that header.

| Method | Endpoint | Behavior |
| --- | --- | --- |
| POST | `/reset` | Atomically replaces slots and clears bookings, idempotency records, and rate-limit state; past slots are accepted. |
| GET | `/slots?provider=Dr%20Ade` | Every slot, earliest first, with `available`; optional exact provider match. |
| POST | `/bookings` | Creates a confirmed booking; returns `201`. |
| GET | `/bookings/:id` | Returns a booking or `404`. |
| DELETE | `/bookings/:id` | Cancels and frees its slot; `404` if missing, `409` if already cancelled. |
| GET | `/bookings?email=ada@example.com&limit=10&cursor=...` | Case-insensitive email filter; oldest-first keyset pagination; final `next_cursor` is `null`. |
| GET | `/health` | Authenticated database connectivity check. |

### Book an appointment

```http
POST /bookings
Content-Type: application/json
X-API-Key: YOUR_API_KEY
Idempotency-Key: YOUR_UNIQUE_REQUEST_KEY

{"slot_id":"s1","name":" Ada Obi ","email":" ADA@example.com "}
```

```json
{
  "id": "generated-uuid",
  "slot_id": "s1",
  "name": "Ada Obi",
  "email": "ada@example.com",
  "status": "confirmed",
  "created_at": "2026-11-03T10:00:00.000Z"
}
```

### Error semantics

- **401**: missing or wrong key, checked before body parsing.
- **400**: missing/empty/invalid booking fields, malformed JSON, a started slot, invalid pagination parameters, or invalid reset input.
- **404**: missing slot or booking.
- **409**: a confirmed booking already occupies the slot, or the booking is already cancelled.
- **422**: the idempotency key was previously used with a different JSON body.
- **429**: more than five booking attempts for a normalized email in a rolling 60-second window; `Retry-After` is a positive whole number of seconds.

## Correctness decisions

### Double-booking and cancellation

All mutation transactions lock the singleton `app_lock` row using `SELECT ... FOR UPDATE`. This keeps reset, booking, cancellation, idempotency, and rate limiting consistent across independent API instances and connection pools. A **partial unique index** on confirmed bookings per slot also enforces the invariant directly in PostgreSQL.

The short, global write lock favors correctness and simplicity for the assessment’s clinic workload. Reads remain concurrent. High-throughput deployments could use finer-grained locks with consistent lock ordering.

### Retry safety

The booking and its stored response commit in the same transaction. Replaying an idempotency key returns the original HTTP status and JSON body, including failures. JSON object-member order does not matter; field values do. Replays after cancellation still return the original create response; `GET /bookings/:id` shows current status. Reset intentionally clears this history.

### Pagination

Queries use `(created_at, id)` keyset pagination, preserving full PostgreSQL timestamp precision inside the cursor. Cursors are signed, bound to the normalized email, and stable when timestamps tie. Both confirmed and cancelled bookings are included. Limits range from 1 to 50, defaulting to 10.

### Rate limiting

Every authenticated booking attempt with a nonempty string email is counted before validation and idempotency replay, including failures and retries. This applies the spec’s “at most 5 attempts” rule even to retries: a sixth retry receives `429`; once its window expires, the same key still replays the original response. Requests without an identifiable email cannot consume a per-email quota. Unauthorized requests do not consume it.

The limiter uses PostgreSQL’s clock and stored timestamps. Rejected `429` attempts do not extend the waiting window. Expired attempt rows are pruned. Other emails are independent.

## Verification

```sh
npx playwright install chromium
npm test
npm run check
```

The suite covers all five levels, malformed input, atomic reset, concurrent slot booking, duplicate cancellation, idempotent races, failure replay, pagination with microsecond/tied timestamps, rate-window expiry, and desktop/mobile browser flows. It also starts a temporary native PostgreSQL server to test independent app instances and connection pools, then removes that test cluster.

To run the multi-instance PostgreSQL checks alone:

```sh
npm run test:postgres
```

Optionally set `TEST_DATABASE_URL` to a **dedicated disposable test database**; this suite calls `/reset` on it. Never use the submission database for this test. When that variable is absent, the embedded test server runs on a random loopback port. Embedded PostgreSQL needs a normal non-root user on Linux.

For non-destructive checks against a running local or deployed app, set `BASE_URL` and `API_KEY`, then run:

```sh
npm run smoke
```

## Deploy: Vercel + Neon

1. Create a free Neon project/database. Copy the **pooled** PostgreSQL connection string with `sslmode=require`.
2. Replace `DATABASE_URL` in `.env.local` with that connection string. Keep `API_KEY` set to your chosen secret. Never commit `.env.local`.
3. Initialize and seed the database:

   ```sh
   npm run db:migrate
   npm run db:seed
   ```

4. Sign into Vercel and link a project from this directory:

   ```sh
   npx vercel login
   npx vercel link
   ```

5. In the Vercel project’s environment variables, set **Production** values for `DATABASE_URL` (Neon pooled URL) and `API_KEY`. Alternatively use the interactive commands below; paste each value only at its prompt:

   ```sh
   npx vercel env add DATABASE_URL production
   npx vercel env add API_KEY production
   ```

6. Deploy:

   ```sh
   npx vercel --prod
   ```

   `vercel.json` serves `public/` and rewrites the exact API paths to `api/index.js`. Use Node 24 in project settings. Production must use external PostgreSQL; the app rejects a PGlite URL on Vercel. Schema changes are applied explicitly with `db:migrate`, not on every cold start.

7. Ensure the **production deployment** is publicly reachable over HTTPS (disable Vercel deployment protection for that URL if enabled). The API itself remains protected with `X-API-Key`.
8. Set `BASE_URL` in `.env.local` to the resulting `https://...vercel.app` URL and run `npm run smoke`. Then use the page to book, look up, and cancel one demo appointment. Do this **before submission**.
9. Submit the HTTPS base URL and API key through the assessment’s submission channel. State that Levels 1–5 are implemented. The web page is at the base URL; `/slots` and `/bookings` are directly beneath it.
10. After submission, keep the Vercel deployment and Neon database active and unchanged until contacted. Do not run reset, reseed, redeploy, rotate the key, or delete the database during that period.

## Files

```text
api/index.js          Vercel function entrypoint
src/app.js            API routes, authentication, validation and transactions
src/database.js       PostgreSQL/PGlite adapters and schema
public/               Responsive booking web page
scripts/              Migration, non-destructive seed and smoke checks
test/                 API, concurrency, browser and native PostgreSQL checks
server.js             Local server entrypoint
vercel.json           HTTPS hosting/function routing configuration
```
