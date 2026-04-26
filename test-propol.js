const db = require('better-sqlite3')('./data/pharmasearch.db', { readonly: true });
const rows = db.prepare(
  "SELECT amp_id, nom_fr, forme_fr, voies_fr, titulaire FROM sam2_specialites WHERE LOWER(nom_fr) LIKE '%propol%' ORDER BY nom_fr LIMIT 15"
).all();
rows.forEach(r => console.log(
  r.amp_id, '|', r.nom_fr, '|', r.forme_fr || '(vide)', '|', r.voies_fr || '(vide)', '|', r.titulaire || '(vide)'
));
db.close();
