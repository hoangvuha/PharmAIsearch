'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../data/pharmasearch.db'), { readonly: true });

function norm(str) {
  return (str || '').toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// ── RECHERCHE PRINCIPALE ──────────────────────────────────────────────────
function rechercher({ terms, operators, filter, sources }) {
  try {
    if (!terms || terms.length === 0) return [];

    const term0 = terms[0] && terms[0].trim();
    if (!term0) return [];

    const results = [];
    const seen = new Set();

    // Recherche SAM2 — uniquement sur nom_fr et nom_nl (PAS les PA)
    if (!sources || sources.includes('SAM2')) {
      const t = `%${norm(term0)}%`;

      const rows = db.prepare(`
        SELECT
          s.amp_id,
          s.nom_fr,
          s.nom_nl,
          s.forme_fr,
          s.voies_fr,
          s.statut,
          s.titulaire,
          s.spc_url_fr
        FROM sam2_specialites s
        WHERE
          LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
            s.nom_fr,
            'é','e'),'è','e'),'ê','e'),'à','a'),'ô','o'),'î','i'))
          LIKE ?
          OR
          LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
            s.nom_nl,
            'é','e'),'è','e'),'ê','e'),'à','a'),'ô','o'),'î','i'))
          LIKE ?
        ORDER BY s.nom_fr
        LIMIT 500
      `).all(t, t);

      // Filtre voie d'administration
      const voieMap = {
        PO: 'orale', IV: 'intraveineuse', IM: 'intramusculaire',
        IT: 'intrathécale', SC: 'sous-cutanée', TOP: 'cutanée', INH: 'inhalation'
      };
      const voieKw = filter && filter !== 'all' ? voieMap[filter] : null;

      for (const row of rows) {
        if (voieKw && !(row.voies_fr || '').toLowerCase().includes(voieKw)) continue;
        if (seen.has(row.amp_id)) continue;
        seen.add(row.amp_id);

        results.push({
          id:        row.amp_id,
          name:      row.nom_fr || row.nom_nl,
          name_nl:   row.nom_nl || '',
          forme:     row.forme_fr || '',
          voies:     row.voies_fr || '',
          statut:    row.statut || '',
          titulaire: row.titulaire || '',
          source:    'SAM2 (Belgique)',
          spc_url:   row.spc_url_fr || '',
          cbip_url:  'https://www.cbip.be/fr/keywords?q=' + encodeURIComponent(row.nom_fr || row.nom_nl) + '&type=trade_family'
        });
      }
    }

    // BDPM — désactivé temporairement (base en construction)
    if (sources && sources.includes('BDPM') && !sources.includes('SAM2')) {
      // Retourner un marqueur spécial pour signaler "under construction"
      return [{ _bdpm_construction: true }];
    }

    return results;

  } catch (err) {
    console.error('Erreur recherche:', err.message);
    return [];
  }
}

// ── AUTOCOMPLÉTION ────────────────────────────────────────────────────────
// mode = 'specialite' → noms uniquement (pour la case 1)
function suggerer(query, mode) {
  try {
    const q = norm(query);
    const resultats = [];
    const dejavu = new Set();

    // Noms de spécialités SAM2
    const rows = db.prepare(`
      SELECT DISTINCT nom_fr FROM sam2_specialites
      WHERE LOWER(nom_fr) LIKE ?
      ORDER BY nom_fr LIMIT 10
    `).all(`${q}%`);

    for (const r of rows) {
      if (!dejavu.has(r.nom_fr)) {
        resultats.push({ texte: r.nom_fr, type: 'specialite' });
        dejavu.add(r.nom_fr);
      }
    }

    // Si moins de 5 résultats, chercher aussi "contient"
    if (resultats.length < 5) {
      const rows2 = db.prepare(`
        SELECT DISTINCT nom_fr FROM sam2_specialites
        WHERE LOWER(nom_fr) LIKE ?
          AND LOWER(nom_fr) NOT LIKE ?
        ORDER BY nom_fr LIMIT 5
      `).all(`%${q}%`, `${q}%`);

      for (const r of rows2) {
        if (!dejavu.has(r.nom_fr)) {
          resultats.push({ texte: r.nom_fr, type: 'specialite' });
          dejavu.add(r.nom_fr);
        }
      }
    }

    return resultats.slice(0, 10);

  } catch (err) {
    console.error('Erreur suggestion:', err.message);
    return [];
  }
}

function getSpcUrl(nom) {
  try {
    const t = '%' + norm(nom) + '%';
    const row = db.prepare(`
      SELECT amp_id, spc_url_fr FROM sam2_specialites
      WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        nom_fr,'é','e'),'è','e'),'ê','e'),'à','a'),'ô','o'),'î','i'))
      LIKE ?
      AND spc_url_fr != ''
      ORDER BY LENGTH(nom_fr) ASC
      LIMIT 1
    `).get(t);
    return row ? { amp_id: row.amp_id, spc_url: row.spc_url_fr } : { amp_id: null, spc_url: '' };
  } catch (err) {
    return { amp_id: null, spc_url: '' };
  }
}

// ── RECHERCHE MULTIPLE (liste de médicaments) ────────────────────────────
// Stratégie hybride en 4 passes pour chaque ligne :
// 1. Correspondance exacte normalisée
// 2. Suppression du dosage (5mg/ml, 1g, etc.)
// 3. Suppression de la forme galénique (comprimé, solution, etc.)
// 4. Premier mot significatif uniquement

const FORMES = ['comprimé', 'comprimes', 'gelule', 'gélule', 'solution', 'injectable',
  'buvable', 'sirop', 'pommade', 'creme', 'crème', 'patch', 'suppositoire',
  'collyre', 'gouttes', 'spray', 'inhalation', 'poudre', 'sachet', 'suspension',
  'perfusion', 'lyophilisat', 'capsule', 'pelliculé', 'pellicule', 'effervescent'];

function nettoyerLigne(ligne) {
  let s = norm(ligne.trim());
  // Supprimer dosages : 5mg, 1g, 500mg/ml, 10%, etc.
  s = s.replace(/\d+[\d.,]*\s*(mg\/ml|mg|ml|mcg|µg|g|%|ui|iu|microg)(\s|$)/gi, ' ');
  // Supprimer nombres isolés
  s = s.replace(/\b\d+\b/g, ' ');
  // Supprimer formes galéniques
  for (const f of FORMES) s = s.replace(new RegExp('\\b' + f + '\\b', 'gi'), ' ');
  // Nettoyer espaces multiples
  return s.replace(/\s+/g, ' ').trim();
}

function rechercherUneMolecule(ligne) {
  const ligneNorm = norm(ligne.trim());

  // Passe 1 : correspondance exacte (LIKE %terme%)
  let rows = db.prepare(`
    SELECT amp_id, nom_fr, nom_nl, forme_fr, voies_fr, statut, titulaire, spc_url_fr
    FROM sam2_specialites
    WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
      nom_fr,'é','e'),'è','e'),'ê','e'),'à','a'),'ô','o'),'î','i'))
    LIKE ?
    ORDER BY LENGTH(nom_fr) ASC LIMIT 5
  `).all('%' + ligneNorm + '%');

  if (rows.length > 0) return { rows, passe: 1 };

  // Passe 2 : supprimer dosage + forme
  const ligneNettoye = nettoyerLigne(ligne);
  if (ligneNettoye.length >= 3) {
    rows = db.prepare(`
      SELECT amp_id, nom_fr, nom_nl, forme_fr, voies_fr, statut, titulaire, spc_url_fr
      FROM sam2_specialites
      WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        nom_fr,'é','e'),'è','e'),'ê','e'),'à','a'),'ô','o'),'î','i'))
      LIKE ?
      ORDER BY LENGTH(nom_fr) ASC LIMIT 5
    `).all('%' + ligneNettoye + '%');
    if (rows.length > 0) return { rows, passe: 2 };
  }

  // Passe 3 : premier mot significatif (≥4 chars)
  const mots = ligneNettoye.split(' ').filter(m => m.length >= 4);
  if (mots.length > 0) {
    rows = db.prepare(`
      SELECT amp_id, nom_fr, nom_nl, forme_fr, voies_fr, statut, titulaire, spc_url_fr
      FROM sam2_specialites
      WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        nom_fr,'é','e'),'è','e'),'ê','e'),'à','a'),'ô','o'),'î','i'))
      LIKE ?
      ORDER BY LENGTH(nom_fr) ASC LIMIT 8
    `).all(mots[0] + '%');
    if (rows.length > 0) return { rows, passe: 3 };
  }

  // Passe 4 : chaque mot séparément avec LIKE %mot%
  for (const mot of mots) {
    rows = db.prepare(`
      SELECT amp_id, nom_fr, nom_nl, forme_fr, voies_fr, statut, titulaire, spc_url_fr
      FROM sam2_specialites
      WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        nom_fr,'é','e'),'è','e'),'ê','e'),'à','a'),'ô','o'),'î','i'))
      LIKE ?
      ORDER BY LENGTH(nom_fr) ASC LIMIT 5
    `).all('%' + mot + '%');
    if (rows.length > 0) return { rows, passe: 4 };
  }

  return { rows: [], passe: 0 };
}

function rechercherListe(lignes) {
  const resultats = [];

  for (const ligne of lignes) {
    if (!ligne.trim()) continue;

    try {
      const { rows, passe } = rechercherUneMolecule(ligne);

      if (rows.length === 0) {
        resultats.push({
          query:   ligne.trim(),
          trouve:  false,
          message: 'Non trouvé dans SAM2 — essayez la recherche manuelle avec un terme simplifié'
        });
        continue;
      }

      // Formater les résultats trouvés
      const matches = rows.map(row => ({
        id:        row.amp_id,
        name:      row.nom_fr || row.nom_nl,
        name_nl:   row.nom_nl || '',
        forme:     row.forme_fr || '',
        voies:     row.voies_fr || '',
        statut:    row.statut || '',
        titulaire: row.titulaire || '',
        source:    'SAM2 (Belgique)',
        spc_url:   row.spc_url_fr || '',
        cbip_url:  'https://www.cbip.be/fr/keywords?q=' +
                   encodeURIComponent(row.nom_fr || row.nom_nl) + '&type=trade_family'
      }));

      resultats.push({
        query:   ligne.trim(),
        trouve:  true,
        passe,   // 1=exact, 2=sans dosage, 3=premier mot, 4=mot-clé
        matches
      });

    } catch (err) {
      resultats.push({
        query:   ligne.trim(),
        trouve:  false,
        message: 'Erreur lors de la recherche : ' + err.message
      });
    }
  }

  return resultats;
}

module.exports = { rechercher, suggerer, getSpcUrl, rechercherListe };

