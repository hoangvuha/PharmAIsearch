'use strict';

/**
 * import-sam2.js  v6
 * Ajout : spc_url_fr (lien RCP PDF AFMPS) extrait depuis <SpcLink><ns2:Fr>
 * dans les blocs <ns4:Ampp> — on prend la première URL valide par AMP.
 *
 * SAX strict=false → tags en MAJUSCULES
 * Usage : node scripts/import-sam2.js
 */

const fs       = require('fs');
const path     = require('path');
const sax      = require('sax');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, '../data/sam2');
const DB_PATH  = path.join(__dirname, '../data/pharmasearch.db');

function findXml(prefix) {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.xml'));
  if (!files.length) throw new Error('Aucun fichier ' + prefix + '*.xml dans ' + DATA_DIR);
  return path.join(DATA_DIR, files[0]);
}

// ── DB ────────────────────────────────────────────────────────────────────
console.log('📂 Ouverture de la base de données...');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -64000');

console.log('🏗️  Recréation des tables SAM2...');
db.exec(`
  DROP TABLE IF EXISTS sam2_search_index;
  DROP TABLE IF EXISTS sam2_compositions;
  DROP TABLE IF EXISTS sam2_specialites;

  CREATE TABLE sam2_specialites (
    amp_id      TEXT PRIMARY KEY,
    nom_fr      TEXT,
    nom_nl      TEXT,
    forme_fr    TEXT,
    voies_fr    TEXT,
    statut      TEXT,
    titulaire   TEXT,
    spc_url_fr  TEXT
  );

  CREATE TABLE sam2_compositions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    amp_id       TEXT NOT NULL,
    substance_fr TEXT,
    dosage       TEXT,
    unite        TEXT,
    is_excipient INTEGER DEFAULT 0
  );

  CREATE TABLE sam2_search_index (
    amp_id     TEXT NOT NULL,
    nom_fr     TEXT,
    substances TEXT,
    excipients TEXT,
    voies_fr   TEXT
  );
`);

const insertSpec  = db.prepare(`INSERT OR REPLACE INTO sam2_specialites
  (amp_id,nom_fr,nom_nl,forme_fr,voies_fr,statut,titulaire,spc_url_fr)
  VALUES (?,?,?,?,?,?,?,?)`);
const insertCompo = db.prepare(`INSERT INTO sam2_compositions
  (amp_id,substance_fr,dosage,unite,is_excipient) VALUES (?,?,?,?,?)`);

console.log('💊 Lecture du fichier AMP (1.5 GB — patience ~3-6 min)...');
console.log('═══════════════════════════════════════════════════════════');

const ampFile = findXml('AMP-');
const parser  = sax.createStream(false, { lowercase: false, trim: true });

// ── État ──────────────────────────────────────────────────────────────────
const stack = [];
let txt = '';

let amp            = null;
let inAmpData      = false;
let inName         = false;
let inPrescName    = false;  // PRESCRIPTIONNAMEFAMHP
let inAmpComponent = false;
let voiesCourantes = [];
let inRouteNs5Name = false;

// Pour SpcLink — dans NS4:AMPP
let inAmpp       = false;
let inSpcLink    = false;
let inAmppData   = false;

let ingr        = null;
let inSubst     = false;
let inSubstName = false;

let nbSpec = 0, nbPA = 0, nbExcip = 0, nbSpc = 0;
let lastLog = Date.now();
let batchSpec = [], batchCompo = [];
const BATCH = 1000;

function peek(offset) { return stack[stack.length - offset] || ''; }

function flushBatches(force) {
  if (force || batchSpec.length >= BATCH) {
    db.transaction(function() { for (var i = 0; i < batchSpec.length; i++) insertSpec.run(batchSpec[i]); })();
    nbSpec += batchSpec.length;
    batchSpec = [];
  }
  if (force || batchCompo.length >= BATCH) {
    db.transaction(function() { for (var i = 0; i < batchCompo.length; i++) insertCompo.run(batchCompo[i]); })();
    batchCompo = [];
  }
  if (Date.now() - lastLog > 3000) {
    process.stdout.write('\r   ' + nbSpec + ' spécialités | ' + nbPA + ' PA | ' + nbExcip + ' excipients | ' + nbSpc + ' RCP links...   ');
    lastLog = Date.now();
  }
}

// ── opentag ───────────────────────────────────────────────────────────────
parser.on('opentag', function(node) {
  var tag = node.name;
  stack.push(tag);
  txt = '';

  if (tag === 'NS4:AMP') {
    amp = {
      amp_id:     node.attributes.CODE || node.attributes.code || '',
      nom_fr:     '',
      nom_nl:     '',
      forme_fr:   '',
      voies_fr:   '',
      statut:     '',
      titulaire:  '',
      spc_url_fr: ''
    };
    inAmpData      = false;
    inAmpComponent = false;
    inAmpp         = false;
    voiesCourantes = [];
  }

  // NS4:DATA fils direct de NS4:AMP
  if (tag === 'NS4:DATA' && peek(2) === 'NS4:AMP') {
    inAmpData = true;
  }

  if (tag === 'NAME' && inAmpData) {
    inName = true;
  }

  // PRESCRIPTIONNAMEFAMHP = nom complet avec forme + voie + conditionnement
  if (tag === 'PRESCRIPTIONNAMEFAMHP' && inAmpData) {
    inPrescName = true;
  }

  if (tag === 'NS4:AMPCOMPONENT') {
    inAmpComponent = true;
  }

  if (tag === 'NS5:NAME' && peek(2) === 'NS4:ROUTEOFADMINISTRATION') {
    inRouteNs5Name = true;
  }

  // ── NS4:AMPP → contient le SpcLink ───────────────────────────────────
  if (tag === 'NS4:AMPP') {
    inAmpp = true;
  }

  // NS4:DATA dans NS4:AMPP
  if (tag === 'NS4:DATA' && inAmpp && peek(2) === 'NS4:AMPP') {
    inAmppData = true;
  }

  // SPCLINK dans NS4:DATA de NS4:AMPP
  if (tag === 'SPCLINK' && inAmppData) {
    inSpcLink = true;
  }

  // Ingrédient
  if (tag === 'NS4:REALACTUALINGREDIENT') {
    ingr = { type: '', substance_fr: '', dosage: '', unite: '' };
    inSubst     = false;
    inSubstName = false;
  }

  if (tag === 'NS4:SUBSTANCE' && ingr !== null) {
    inSubst     = true;
    inSubstName = false;
  }

  if (tag === 'NS5:NAME' && inSubst) {
    inSubstName = true;
  }
});

// ── text ──────────────────────────────────────────────────────────────────
parser.on('text',  function(t) { txt = t; });
parser.on('cdata', function(t) { txt = t; });

// ── closetag ──────────────────────────────────────────────────────────────
parser.on('closetag', function(tag) {
  stack.pop();

  if (!amp) { txt = ''; return; }

  // Nom
  if (inName) {
    if (tag === 'NS2:FR' && txt && !amp.nom_fr) amp.nom_fr = txt;
    if (tag === 'NS2:NL' && txt && !amp.nom_nl) amp.nom_nl = txt;
    if (tag === 'NAME') inName = false;
  }

  if (tag === 'OFFICIALNAME' && inAmpData && txt && !amp.nom_fr) amp.nom_fr = txt;
  if (tag === 'STATUS'       && inAmpData && txt && !amp.statut)  amp.statut = txt;

  // Forme galénique + conditionnement depuis PrescriptionNameFamhp
  if (inPrescName) {
    if (tag === 'NS2:FR' && txt && !amp.forme_fr) amp.forme_fr = txt;
    if (tag === 'PRESCRIPTIONNAMEFAMHP') inPrescName = false;
  }

  if (tag === 'NS4:DATA' && peek(1) === 'NS4:AMP') inAmpData = false;

  // Voie
  if (inRouteNs5Name) {
    if (tag === 'NS2:FR' && txt && voiesCourantes.indexOf(txt) === -1) voiesCourantes.push(txt);
    if (tag === 'NS5:NAME') inRouteNs5Name = false;
  }

  if (tag === 'NS4:AMPCOMPONENT') {
    if (voiesCourantes.length && !amp.voies_fr) amp.voies_fr = voiesCourantes.join(' | ');
    inAmpComponent = false;
  }

  // ── SpcLink : capturer la première URL FR valide par AMP ─────────────
  if (inSpcLink) {
    if (tag === 'NS2:FR' && txt && !amp.spc_url_fr) {
      // Vérifier que c'est bien une URL (commence par http)
      if (txt.indexOf('http') === 0) {
        amp.spc_url_fr = txt;
        nbSpc++;
      }
    }
    if (tag === 'SPCLINK') inSpcLink = false;
  }

  if (tag === 'NS4:DATA' && inAmpp && inAmppData) inAmppData = false;
  if (tag === 'NS4:AMPP') { inAmpp = false; inAmppData = false; inSpcLink = false; }

  // Ingrédient
  if (ingr !== null) {
    if (tag === 'TYPE'              && txt) ingr.type = txt;
    if (tag === 'STRENGTHDESCRIPTION' && txt && !ingr.dosage) ingr.dosage = txt;

    if (inSubstName) {
      if (tag === 'NS2:FR'  && txt && !ingr.substance_fr) ingr.substance_fr = txt;
      if (tag === 'NS5:NAME') inSubstName = false;
    }
    if (tag === 'NS4:SUBSTANCE') inSubst = false;

    if (tag === 'NS4:REALACTUALINGREDIENT') {
      if (ingr.substance_fr) {
        var isExcip = ingr.type === 'EXCIPIENT' ? 1 : 0;
        batchCompo.push([amp.amp_id, ingr.substance_fr, ingr.dosage, ingr.unite, isExcip]);
        if (isExcip) nbExcip++; else nbPA++;
        flushBatches(false);
      }
      ingr = null; inSubst = false; inSubstName = false;
    }
  }

  // Fermeture AMP → sauvegarder
  if (tag === 'NS4:AMP') {
    if (amp.nom_fr || amp.nom_nl) {
      batchSpec.push([
        amp.amp_id,
        amp.nom_fr    || amp.nom_nl,
        amp.nom_nl    || amp.nom_fr,
        amp.forme_fr,
        amp.voies_fr,
        amp.statut,
        amp.titulaire,
        amp.spc_url_fr
      ]);
      flushBatches(false);
    }
    amp = null;
  }

  txt = '';
});

parser.on('error', function() {
  if (parser._parser) {
    parser._parser.error = null;
    try { parser._parser.resume(); } catch(e) {}
  }
});

// ── Lancement ─────────────────────────────────────────────────────────────
var startTime = Date.now();
fs.createReadStream(ampFile, { encoding: 'utf8' }).pipe(parser);

parser.on('end', function() {
  flushBatches(true);

  console.log('\n\n⚡ Construction de l\'index de recherche SAM2...');
  db.exec('DELETE FROM sam2_search_index;');

  var allAmps  = db.prepare('SELECT amp_id, nom_fr, voies_fr FROM sam2_specialites').all();
  var getSubst = db.prepare("SELECT GROUP_CONCAT(substance_fr, ' | ') as s FROM sam2_compositions WHERE amp_id=? AND is_excipient=0");
  var getExcip = db.prepare("SELECT GROUP_CONCAT(substance_fr, ' | ') as e FROM sam2_compositions WHERE amp_id=? AND is_excipient=1");
  var insIdx   = db.prepare('INSERT INTO sam2_search_index (amp_id,nom_fr,substances,excipients,voies_fr) VALUES (?,?,?,?,?)');

  db.transaction(function() {
    for (var i = 0; i < allAmps.length; i++) {
      var s  = allAmps[i];
      var su = getSubst.get(s.amp_id);
      var ex = getExcip.get(s.amp_id);
      insIdx.run(s.amp_id, s.nom_fr || '', su && su.s || '', ex && ex.e || '', s.voies_fr || '');
    }
  })();

  db.exec([
    'CREATE INDEX IF NOT EXISTS idx_sam2_nom        ON sam2_search_index(nom_fr)',
    'CREATE INDEX IF NOT EXISTS idx_sam2_excipients  ON sam2_search_index(excipients)',
    'CREATE INDEX IF NOT EXISTS idx_sam2_substances  ON sam2_search_index(substances)',
    'CREATE INDEX IF NOT EXISTS idx_sam2_compo_sub   ON sam2_compositions(substance_fr)',
    'CREATE INDEX IF NOT EXISTS idx_sam2_compo_amp   ON sam2_compositions(amp_id)',
    'CREATE INDEX IF NOT EXISTS idx_sam2_compo_type  ON sam2_compositions(is_excipient)'
  ].join(';'));

  var stats = {
    spec:    db.prepare('SELECT COUNT(*) as n FROM sam2_specialites').get().n,
    pa:      db.prepare('SELECT COUNT(*) as n FROM sam2_compositions WHERE is_excipient=0').get().n,
    excip:   db.prepare('SELECT COUNT(*) as n FROM sam2_compositions WHERE is_excipient=1').get().n,
    spc:     db.prepare("SELECT COUNT(*) as n FROM sam2_specialites WHERE spc_url_fr != ''").get().n,
    exemple: db.prepare("SELECT nom_fr, spc_url_fr FROM sam2_specialites WHERE spc_url_fr != '' LIMIT 1").get()
  };

  var elapsed = Math.round((Date.now() - startTime) / 1000);

  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          Import SAM2 v6 terminé ! 🎉               ║');
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  Spécialités         : ' + String(stats.spec).padEnd(29)  + '║');
  console.log('║  Principes actifs    : ' + String(stats.pa).padEnd(29)    + '║');
  console.log('║  Excipients          : ' + String(stats.excip).padEnd(29) + '║');
  console.log('║  Liens RCP (SpcLink) : ' + String(stats.spc).padEnd(29)   + '║');
  console.log('║  Durée               : ' + String(elapsed+'s').padEnd(29) + '║');
  console.log('╚══════════════════════════════════════════════════════╝');

  if (stats.exemple) {
    console.log('\n✅ Exemple RCP :', stats.exemple.nom_fr);
    console.log('   URL :', stats.exemple.spc_url_fr);
  }
  if (stats.spc === 0) {
    console.log('\n⚠️  Aucun lien RCP trouvé — vérifier le tag SPCLINK dans le XML');
  }

  db.close();
});
