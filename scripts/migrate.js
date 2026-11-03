import { createDatabase } from '../src/database.js';

const db = await createDatabase(process.env.DATABASE_URL);
try {
  await db.migrate();
  console.log('Database schema is ready.');
} finally {
  await db.close();
}
