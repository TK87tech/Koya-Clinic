import { createApp } from '../src/app.js';
import { createDatabase } from '../src/database.js';

let appPromise;
export default async function handler(req, res) {
  try {
    if (!appPromise) {
      appPromise = (async () => {
        if (!process.env.API_KEY) throw new Error('API_KEY is required.');
        const database = await createDatabase(process.env.DATABASE_URL);
        return createApp({ database, apiKey: process.env.API_KEY });
      })().catch((error) => { appPromise = undefined; throw error; });
    }
    const app = await appPromise;
    return app(req, res);
  } catch {
    res.setHeader('Cache-Control', 'no-store');
    res.status(503).json({ error: 'service temporarily unavailable' });
  }
}
