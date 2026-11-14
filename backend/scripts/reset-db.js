/**
 * Deletes and re-seeds the local SQLite database (demo data only).
 * Usage: npm run db:reset
 */
import { rmSync } from 'node:fs';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/database.js';
import { seedDatabase } from '../src/db/seed.js';
import { setToday, today } from '../src/lib/dates.js';

if (config.demoAnchorDate) setToday(config.demoAnchorDate);
for (const suffix of ['', '-wal', '-shm']) rmSync(`${config.databasePath}${suffix}`, { force: true });
const db = openDatabase(config.databasePath);
seedDatabase(db, { anchor: today() });
db.close();
console.log(`Database reset and seeded at ${config.databasePath} (anchor ${today()}).`);
