/**
 * set-db-dates.js
 * À ajouter à la fin de import-sam2.js ET import-bdpm.js
 * pour enregistrer automatiquement la date d'import dans la base.
 *
 * Utilisation standalone :
 *   node scripts/set-db-dates.js sam2
 *   node scripts/set-db-dates.js bdpm
 */

const Database = require('better-sqlite3');
const path     = require('path');

const db  = new Database(path.join(__dirname, '../data/pharmasearch.db'));
const key = process.argv[2] === 'bdpm' ? 'bdpm_import_date' : 'sam2_import_date';
const today = new Date().toLocaleDateString('fr-BE', { day: '2-digit', month: '2-digit', year: 'numeric' });

db.exec(`CREATE TABLE IF NOT EXISTS db_meta (key TEXT PRIMARY KEY, value TEXT)`);
db.prepare(`INSERT OR REPLACE INTO db_meta (key, value) VALUES (?, ?)`).run(key, today);
db.close();

console.log(`✅ Date d'import enregistrée : ${key} = ${today}`);