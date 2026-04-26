const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'public', 'index.html');
let content = fs.readFileSync(filePath, 'utf8');

// Afficher le contexte exact autour de amp_id pour voir ce qui est réellement là
const i = content.indexOf('amp_id');
if (i > -1) console.log('Contexte brut:', JSON.stringify(content.substring(i, i+80)));

// Chercher toutes les variantes possibles de m.id et r.id corrompus
const patterns = [
  '[r.id](http://r.id)',
  '[m.id](http://m.id)',
  '[r.id](http://r.id/)',
  '[m.id](http://m.id/)',
];

let total = 0;
for (const bad of patterns) {
  const n = content.split(bad).length - 1;
  if (n > 0) {
    const good = bad.startsWith('[r') ? 'r.id' : 'm.id';
    content = content.split(bad).join(good);
    console.log('Corrige ' + n + 'x : ' + bad + ' -> ' + good);
    total += n;
  }
}

fs.writeFileSync(filePath, content, 'utf8');
console.log(total > 0 ? '✅ ' + total + ' correction(s)' : 'Rien à corriger — vérification contexte:');
const j = content.indexOf('amp_id');
if (j > -1) console.log('Après:', JSON.stringify(content.substring(j, j+80)));
