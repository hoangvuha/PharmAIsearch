// fix-index.js — corrige le bug r.id dans public/index.html
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

// Remplacer toutes les variantes du lien markdown r.id par r.id simple
const patterns = [
  /\[r\.id\]\(http:\/\/r\.id\)/g,
  /\[r\.id\]\([^)]*\)/g,
];

let count = 0;
for (const pat of patterns) {
  const before = content;
  content = content.replace(pat, 'r.id');
  if (content !== before) count++;
}

fs.writeFileSync(filePath, content, 'utf8');

// Vérification
if (content.includes('/api/rcp?amp_id=${encodeURIComponent(r.id)}')) {
  console.log('✅ Correction réussie — le bouton RCP pointe vers /api/rcp?amp_id=');
} else {
  console.log('❌ Correction échouée — vérification manuelle nécessaire');
  console.log('Contexte:', content.substring(content.indexOf('api/rcp') - 20, content.indexOf('api/rcp') + 60));
}
