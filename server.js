import { createApp } from './src/app.js';
import { createDatabase } from './src/database.js';

const db = await createDatabase(process.env.DATABASE_URL);
await db.migrate();
const app = createApp({ database: db, apiKey: process.env.API_KEY });
const server = app.listen(Number(process.env.PORT) || 3000, () => {
  console.log(`Clinic booking is running at http://localhost:${server.address().port}`);
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(async () => { await db.close(); process.exit(0); }));
}
