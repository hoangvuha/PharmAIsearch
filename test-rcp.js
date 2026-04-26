/**
 * test-rcp.js
 * Teste l'extraction rubrique 6.1 sur une sélection de médicaments
 * Usage : node test-rcp.js
 */

'use strict';

const http = require('http');
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data/pharmasearch.db'), { readonly: true });

// Sélectionner 30 médicaments variés avec lien RCP
const medicaments = db.prepare(`
  SELECT amp_id, nom_fr, spc_url_fr
  FROM sam2_specialites
  WHERE spc_url_fr != ''
    AND statut = 'AUTHORIZED'
  ORDER BY RANDOM()
  LIMIT 30
`).all();

console.log(`\n🧪 Test extraction rubrique 6.1 — ${medicaments.length} médicaments\n`);
console.log('═'.repeat(80));

let ok = 0, ko = 0, vide = 0;
let idx = 0;

function testerSuivant() {
  if (idx >= medicaments.length) {
    // Rapport final
    console.log('\n' + '═'.repeat(80));
    console.log(`\n📊 RÉSULTATS :`);
    console.log(`  ✅ Extraction réussie  : ${ok}/${medicaments.length}`);
    console.log(`  ⚠️  Rubrique vide/intro : ${vide}/${medicaments.length}`);
    console.log(`  ❌ Erreur              : ${ko}/${medicaments.length}`);
    console.log(`\n  Taux de succès : ${Math.round(ok/medicaments.length*100)}%\n`);
    db.close();
    return;
  }

  const med = medicaments[idx++];
  const nom = (med.nom_fr || '').substring(0, 45).padEnd(45);

  http.get(`http://localhost:3000/api/rcp?amp_id=${encodeURIComponent(med.amp_id)}`, (res) => {
    const chunks = [];
    res.on('data', d => chunks.push(d));
    res.on('end', () => {
      const html = Buffer.concat(chunks).toString();

      // Chercher le contenu de la rubrique 6.1
      const excipMatch = html.match(/class="excipient-line">([^<]{3,200})/);
      const notFound   = html.includes('class="not-found"');
      const erreur     = html.includes('class="err"') || html.includes('Extraction impossible');

      if (erreur) {
        const errMsg = (html.match(/Impossible[^<]{0,80}/) || ['?'])[0].substring(0,60);
        console.log(`❌ ${nom} | ${errMsg}`);
        ko++;
      } else if (notFound || !excipMatch) {
        console.log(`⚠️  ${nom} | Rubrique 6.1 non extraite`);
        vide++;
      } else {
        const excipients = excipMatch[1].substring(0, 60);
        console.log(`✅ ${nom} | ${excipients}`);
        ok++;
      }

      // Petit délai pour ne pas surcharger le serveur
      setTimeout(testerSuivant, 800);
    });
  }).on('error', (err) => {
    console.log(`❌ ${nom} | Connexion refusée — serveur démarré ?`);
    ko++;
    setTimeout(testerSuivant, 500);
  });
}

// Lancer le premier test
testerSuivant();
