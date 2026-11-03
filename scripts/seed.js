import { createDatabase } from '../src/database.js';

const db = await createDatabase(process.env.DATABASE_URL);
try {
  await db.migrate();
  await db.transaction(async (tx) => {
    await tx.query('SELECT id FROM app_lock WHERE id = 1 FOR UPDATE');
    const { rows } = await tx.query('SELECT count(*)::int AS count FROM slots');
    if (rows[0].count) {
      console.log('Slots already exist; seed skipped.');
      return;
    }
    const base = new Date();
    base.setUTCHours(9, 0, 0, 0);
    for (let day = 1; day <= 30; day++) {
      for (let index = 0; index < 6; index++) {
        const start = new Date(base.getTime() + day * 86400000 + index * 3600000);
        const end = new Date(start.getTime() + 1800000);
        await tx.query('INSERT INTO slots (id, provider, start_at, end_at) VALUES ($1, $2, $3, $4)',
          [`demo-${day}-${index}`, index % 2 ? 'Dr. Amara Okafor' : 'Dr. Daniel Adeyemi', start.toISOString(), end.toISOString()]);
      }
    }
    console.log('Created 180 appointment slots across the next 30 days.');
  });
} finally {
  await db.close();
}
