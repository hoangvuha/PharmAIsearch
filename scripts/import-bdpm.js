const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

console.log('🚀 Démarrage de l\'importation BDPM...');

const db = new Database(path.join(__dirname, '../data/pharmasearch.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// Supprimer et recréer toutes les tables
db.exec(`
  DROP TABLE IF EXISTS search_index;
  DROP TABLE IF EXISTS compositions;
  DROP TABLE IF EXISTS conditions_prescription;
  DROP TABLE IF EXISTS specialites;

  CREATE TABLE specialites (
    cis TEXT PRIMARY KEY,
    nom TEXT NOT NULL,
    forme TEXT,
    voies TEXT,
    statut TEXT,
    commercialisation TEXT,
    source TEXT DEFAULT 'BDPM'
  );

  CREATE TABLE compositions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cis TEXT NOT NULL,
    substance TEXT,
    dosage TEXT,
    type_composant TEXT
  );

  CREATE TABLE conditions_prescription (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cis TEXT NOT NULL,
    condition TEXT
  );

  CREATE TABLE search_index (
    cis TEXT NOT NULL,
    nom TEXT,
    substance TEXT,
    voies TEXT,
    conditions TEXT
  );
`);

function lireFichier(nomFichier) {
  const filePath = path.join(__dirname, '../data', nomFichier);
  if (!fs.existsSync(filePath)) {
    console.error('❌ Fichier introuvable : ' + nomFichier);
    return [];
  }
  const contenu = fs.readFileSync(filePath, { encoding: 'latin1' });
  return contenu.split('\n').filter(l => l.trim()).map(l => l.split('\t'));
}

// --- IMPORT SPÉCIALITÉS ---
console.log('📋 Import des spécialités...');
const lignesSpec = lireFichier('CIS_bdpm.txt');
const insertSpec = db.prepare(`
  INSERT OR REPLACE INTO specialites (cis, nom, forme, voies, statut, commercialisation)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const importSpec = db.transaction((lignes) => {
  let count = 0;
  for (const col of lignes) {
    if (col.length >= 5) {
      insertSpec.run(
        col[0]?.trim() || '',
        col[1]?.trim() || '',
        col[2]?.trim() || '',
        col[3]?.trim() || '',
        col[4]?.trim() || '',
        col[6]?.trim() || ''
      );
      count++;
    }
  }
  return count;
});
const nbSpec = importSpec(lignesSpec);
console.log(`✅ ${nbSpec} spécialités importées`);

// --- IMPORT COMPOSITIONS ---
console.log('💊 Import des compositions...');
const lignesCompo = lireFichier('CIS_COMPO_bdpm.txt');
const insertCompo = db.prepare(`
  INSERT INTO compositions (cis, substance, dosage, type_composant)
  VALUES (?, ?, ?, ?)
`);
const importCompo = db.transaction((lignes) => {
  let count = 0;
  for (const col of lignes) {
    if (col.length >= 6) {
      insertCompo.run(
        col[0]?.trim() || '',
        col[3]?.trim() || '',
        col[4]?.trim() || '',
        col[5]?.trim() || ''
      );
      count++;
    }
  }
  return count;
});
const nbCompo = importCompo(lignesCompo);
console.log(`✅ ${nbCompo} compositions importées`);

// --- IMPORT CONDITIONS ---
console.log('📝 Import des conditions...');
const lignesCPD = lireFichier('CIS_CPD_bdpm.txt');
const insertCPD = db.prepare(`
  INSERT INTO conditions_prescription (cis, condition)
  VALUES (?, ?)
`);
const importCPD = db.transaction((lignes) => {
  let count = 0;
  for (const col of lignes) {
    if (col.length >= 2) {
      insertCPD.run(
        col[0]?.trim() || '',
        col[1]?.trim() || ''
      );
      count++;
    }
  }
  return count;
});
const nbCPD = importCPD(lignesCPD);
console.log(`✅ ${nbCPD} conditions importées`);

// --- CONSTRUCTION INDEX SIMPLE ---
console.log('🔍 Construction de l\'index de recherche...');
const insertIdx = db.prepare(`
  INSERT INTO search_index (cis, nom, substance, voies, conditions)
  VALUES (?, ?, ?, ?, ?)
`);

const allSpec = db.prepare('SELECT * FROM specialites').all();
const getSubst = db.prepare("SELECT GROUP_CONCAT(substance, ' | ') as s FROM compositions WHERE cis = ?");
const getCond = db.prepare("SELECT GROUP_CONCAT(condition, ' | ') as c FROM conditions_prescription WHERE cis = ?");

const buildIdx = db.transaction(() => {
  for (const s of allSpec) {
    const subst = getSubst.get(s.cis);
    const cond = getCond.get(s.cis);
    insertIdx.run(
      s.cis,
      s.nom || '',
      subst?.s || '',
      s.voies || '',
      cond?.c || ''
    );
  }
});
buildIdx();

// Index de performance
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_nom ON search_index(nom);
  CREATE INDEX IF NOT EXISTS idx_substance ON search_index(substance);
`);

const stats = db.prepare('SELECT COUNT(*) as n FROM search_index').get();
console.log(`\n🎉 Import terminé !`);
console.log(`   📦 ${nbSpec} spécialités`);
console.log(`   🔍 ${stats.n} entrées dans l'index`);

db.close();