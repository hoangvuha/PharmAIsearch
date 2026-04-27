'use strict';

const express  = require('express');
const path     = require('path');
const https    = require('https');
const http     = require('http');
const PDFParser = require('pdf2json');

async function parsePdf(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1); // rawTextContent=1
    parser.on('pdfParser_dataReady', data => {
      let texte = '';
      try {
        const pages = data.Pages || [];
        for (const page of pages) {
          for (const text of page.Texts || []) {
            for (const r of text.R || []) {
              try {
                texte += decodeURIComponent(r.T);
              } catch(e) {
                texte += r.T;
              }
            }
            texte += ' ';
          }
          texte += '\n';
        }
      } catch(e) {
        console.error('Erreur parsing pages:', e.message);
      }
      console.log('PDF parsé:', (data.Pages||[]).length, 'pages,', texte.length, 'chars');
      resolve({ text: texte, pages: (data.Pages||[]).length });
    });
    parser.on('pdfParser_dataError', err => {
      reject(new Error(String(err.parserError || err)));
    });
    parser.parseBuffer(buffer);
  });
}
const Database = require('better-sqlite3');
const fs       = require('fs');

const { rechercher, suggerer, getSpcUrl, rechercherListe } = require('./scripts/search');

const app  = express();
const PORT = process.env.PORT || 3000;

// DB pour les requêtes directes dans server.js (page RCP)
function getServerDb() {
  const DB_VOLUME = '/data/pharmasearch.db';
  const DB_LOCAL  = path.join(__dirname, 'data/pharmasearch.db');
  const dbPath = process.env.RAILWAY_ENVIRONMENT
    ? (fs.existsSync(DB_VOLUME) ? DB_VOLUME : DB_LOCAL)
    : (process.env.DB_PATH || DB_LOCAL);
  return new Database(dbPath, { readonly: true });
}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Santé ──────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'PharmaSearch fonctionne ✅' });
});

// ── Recherche ──────────────────────────────────────────────────────────────
app.get('/api/search', (req, res) => {
  try {
    const terms     = JSON.parse(req.query.terms     || '[]');
    const operators = JSON.parse(req.query.operators || '[]');
    const filter    = req.query.filter  || 'all';
    const sources   = (req.query.sources || 'SAM2').split(',');
    if (!terms || terms.length === 0)
      return res.json({ results: [], message: 'Aucun terme de recherche' });
    const results = rechercher({ terms, operators, filter, sources });
    res.json({ results, count: results.length });
  } catch (err) {
    res.status(500).json({ results: [], error: err.message });
  }
});

// ── Autocomplétion ─────────────────────────────────────────────────────────
app.get('/api/suggest', (req, res) => {
  try {
    const q    = (req.query.q    || '').trim();
    const mode = (req.query.mode || 'specialite');
    if (q.length < 2) return res.json({ suggestions: [] });
    res.json({ suggestions: suggerer(q, mode) });
  } catch (err) {
    res.status(500).json({ suggestions: [] });
  }
});

// ── Recherche multiple (liste) ─────────────────────────────────────────────
app.post('/api/search-liste', (req, res) => {
  try {
    const { lignes } = req.body;
    if (!lignes || !Array.isArray(lignes) || lignes.length === 0) {
      return res.json({ resultats: [], error: 'Aucune ligne fournie' });
    }
    if (lignes.length > 50) {
      return res.json({ resultats: [], error: 'Maximum 50 médicaments par recherche' });
    }
    const resultats = rechercherListe(lignes);
    res.json({ resultats });
  } catch (err) {
    console.error('Erreur search-liste:', err.message);
    res.status(500).json({ resultats: [], error: err.message });
  }
});

// ── URL SPC ────────────────────────────────────────────────────────────────
app.get('/api/spc', (req, res) => {
  try {
    const nom = (req.query.nom || '').trim();
    if (!nom) return res.json({ amp_id: null, spc_url: '' });
    const result = getSpcUrl(nom);
    res.json(result);
  } catch (err) {
    res.json({ amp_id: null, spc_url: '' });
  }
});

// ── Helper : télécharger un PDF depuis une URL ────────────────────────────
function fetchPdf(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, { timeout: 15000 }, (response) => {
      if (response.statusCode !== 200) {
        return reject(new Error('HTTP ' + response.statusCode));
      }
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject).on('timeout', () => reject(new Error('Timeout')));
  });
}

// ── Helper : extraire la rubrique 6.1 du texte PDF ───────────────────────
function extraireExcipients(texte) {
  const t = texte.replace(/\r\n/g, ' ').replace(/\r/g, ' ').replace(/\n/g, ' ');

  // Pattern principal : entre "6.1 Liste des excipients" et "6.2"
  const patterns = [
    // Pattern exact observé dans les PDFs AFMPS
    /6[\s.]*1[\s.]*(?:Liste\s+des\s+excipients?|Excipients?)\s+([\s\S]{5,500}?)\s+6[\s.]*2[\s.]*/i,
    // Variante avec deux-points
    /6[\s.]*1[\s.]*(?:Liste\s+des\s+excipients?|Excipients?)\s*:?\s*([\s\S]{5,500}?)\s+6[\s.]*2/i,
    // Fallback : chercher après "excipients" jusqu'à "6.2"
    /excipients?\s*\n?\s*([\s\S]{5,400}?)\s+6[\s.]*2/i,
  ];

  for (const pat of patterns) {
    const match = t.match(pat);
    if (match && match[1] && match[1].trim().length > 2) {
      return match[1].trim();
    }
  }

  // Fallback large : extraire 500 chars après "6.1"
  const idx = t.search(/6[\s.]*1[\s.]*(Liste|Excipient)/i);
  if (idx !== -1) {
    const apres = t.indexOf('6.2', idx);
    if (apres !== -1 && apres - idx < 1000) {
      return t.substring(idx, apres).trim();
    }
    return t.substring(idx, Math.min(idx + 500, t.length)).trim();
  }

  return null;
}

// ── Endpoint principal : /api/rcp?amp_id=SAM... ou ?nom=Haldol ───────────
app.get('/api/rcp', async (req, res) => {
  let amp_id = (req.query.amp_id || '').trim();

  // Résolution par nom si amp_id absent
  if (!amp_id && req.query.nom) {
    const result = getSpcUrl(req.query.nom.trim());
    amp_id = result.amp_id || '';
  }

  if (!amp_id) return res.status(400).send('amp_id ou nom requis');

  // Récupérer les infos de la spécialité
  const spec = getServerDb().prepare(
    'SELECT nom_fr, forme_fr, titulaire, spc_url_fr FROM sam2_specialites WHERE amp_id = ?'
  ).get(amp_id);

  if (!spec || !spec.spc_url_fr) {
    return res.send(pageErreur(amp_id, spec ? spec.nom_fr : amp_id,
      'Aucun lien RCP disponible pour ce médicament dans la base SAM2.', null));
  }

  try {
    // Télécharger le PDF
    const pdfBuffer = await fetchPdf(spec.spc_url_fr);

    // Parser le PDF
    const data = await parsePdf(pdfBuffer);
    const texte = data.text;

    // Extraire la rubrique 6.1
    const section61 = extraireExcipients(texte);

    res.send(pageRcp(spec, amp_id, section61, texte));

  } catch (err) {
    console.error('Erreur RCP:', err.message);
    res.send(pageErreur(amp_id, spec.nom_fr,
      'Impossible de charger le RCP depuis l\'AFMPS : ' + err.message,
      spec.spc_url_fr));
  }
});

// ── Page HTML : affichage de la rubrique 6.1 ─────────────────────────────
function pageRcp(spec, amp_id, section61, texteComplet) {
  const nom = escHtml(spec.nom_fr || amp_id);
  const forme = escHtml(spec.forme_fr || '');
  const titulaire = escHtml(spec.titulaire || '');

  // Formater la section 6.1
  let excipientHtml = '';
  if (section61) {
    // Nettoyer et mettre en forme
    const lignes = section61
      .split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0);

    excipientHtml = lignes.map(l => {
      // Première ligne = titre de la rubrique
      if (l.match(/^6[\s.]+1/i)) {
        return `<div class="section-title">${escHtml(l)}</div>`;
      }
      // Lignes contenant ":" → probable titre/sous-section
      if (l.endsWith(':')) {
        return `<div class="subsection">${escHtml(l)}</div>`;
      }
      return `<div class="excipient-line">${escHtml(l)}</div>`;
    }).join('');
  } else {
    excipientHtml = `<div class="not-found">
      ⚠️ La rubrique 6.1 n'a pas pu être extraite automatiquement.<br>
      Consultez le PDF complet ci-dessous.
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>RCP — ${nom}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background:#f0f4f8; color:#1a202c; font-size:16px; }
  header { background:#1a365d; color:white; padding:16px 28px;
           display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; }
  .header-logo { font-family:'Arial Black',Impact,sans-serif; font-size:1.4rem;
                 font-weight:900; letter-spacing:2px; display:flex; align-items:baseline; }
  .header-logo .big { font-size:1.8rem; }
  .header-logo .ai { color:#4dd0e1; font-size:1.8rem; letter-spacing:1px; }
  .back-btn { background:rgba(255,255,255,0.15); border:2px solid rgba(255,255,255,0.4);
              color:white; padding:7px 14px; border-radius:8px; cursor:pointer;
              font-size:0.9rem; font-weight:600; text-decoration:none; }
  .back-btn:hover { background:rgba(255,255,255,0.25); }
  .container { max-width:860px; margin:28px auto; padding:0 20px; }
  .drug-card { background:white; border-radius:14px; padding:28px 32px;
               box-shadow:0 2px 16px rgba(0,0,0,0.09); margin-bottom:20px; }
  .drug-name { font-size:1.5rem; font-weight:700; color:#1a365d; margin-bottom:6px; }
  .drug-meta { font-size:0.95rem; color:#718096; margin-bottom:18px; }
  .drug-meta span { margin-right:16px; }
  .pdf-btn {
    display:inline-flex; align-items:center; gap:8px;
    padding:12px 22px; background:#e53e3e; color:white;
    border:none; border-radius:10px; font-size:1rem; font-weight:700;
    cursor:pointer; text-decoration:none; transition:background 0.2s;
    margin-bottom:8px;
  }
  .pdf-btn:hover { background:#c53030; }
  .pdf-rubrique-note {
    display:inline-block; background:#e53e3e; color:white;
    font-size:0.92rem; font-weight:700; padding:8px 16px;
    border-radius:8px; margin:10px 0 6px;
  }
  .pdf-note { font-size:0.82rem; color:#a0aec0; font-style:italic; }
  .section-card { background:white; border-radius:14px; padding:28px 32px;
                  box-shadow:0 2px 16px rgba(0,0,0,0.09); }
  .section-header { font-size:1.1rem; font-weight:700; color:#2d3748;
                    margin-bottom:18px; padding-bottom:12px;
                    border-bottom:2px solid #e2e8f0; display:flex;
                    align-items:center; gap:10px; }
  .section-title { font-size:1rem; font-weight:700; color:#1a365d;
                   margin:0 0 12px; padding:8px 12px;
                   background:#ebf4ff; border-radius:8px; }
  .subsection { font-size:0.95rem; font-weight:600; color:#2d3748;
                margin:12px 0 6px; }
  .excipient-line { font-size:1rem; color:#2d3748; padding:5px 0 5px 12px;
                    border-left:3px solid #f6e05e; margin:4px 0;
                    line-height:1.5; }
  .not-found { background:#fffbeb; border:2px solid #f6ad55; border-radius:10px;
               padding:18px; color:#744210; font-size:0.95rem; line-height:1.6; }
  .disclaimer { background:#fff0f0; border:2px solid #fed7d7; border-radius:10px;
                padding:14px 18px; margin-top:18px; font-size:0.85rem;
                color:#742a2a; line-height:1.6; }
  footer { text-align:center; padding:24px; font-size:0.82rem;
           color:#a0aec0; margin-top:20px; line-height:1.8; }
  @media(max-width:600px) {
    .drug-card, .section-card { padding:18px 16px; }
    .drug-name { font-size:1.2rem; }
  }
</style>
</head>
<body>
<header>
  <div class="header-logo"><span class="big">P</span>HARM<span class="ai">AI</span><span class="big">S</span>EARCH</div>
  <a href="https://pharmaisearch.com" class="back-btn">← Accueil</a>
</header>

<div class="container">
  <div class="drug-card">
    <div class="drug-name">${nom}</div>
    <div class="drug-meta">
      ${forme ? `<span>💊 ${forme}</span>` : ''}
      ${titulaire ? `<span>🏭 ${titulaire}</span>` : ''}
      <span>🇧🇪 SAM2 (AFMPS)</span>
    </div>

    <a href="${escHtml(spec.spc_url_fr)}" target="_blank" class="pdf-btn">
      📥 Notice complète — PDF officiel AFMPS
    </a>
    <div class="pdf-rubrique-note">
      📌 Dans le PDF : aller directement à la <strong>rubrique 6.1 — Liste des excipients</strong>
    </div>
    <div class="pdf-note">Source officielle AFMPS — s'ouvre dans un nouvel onglet</div>
  </div>

  <div class="section-card">
    <div class="section-header">
      🧪 Rubrique 6.1 — Liste des excipients
    </div>
    ${excipientHtml}

    <div class="disclaimer">
      🚨 <strong>Information extraite automatiquement du RCP officiel AFMPS.</strong><br>
      Vérifiez toujours les données sur le <a href="${escHtml(spec.spc_url_fr)}" target="_blank" style="color:#2b6cb0;font-weight:700;">PDF officiel AFMPS</a> avant toute décision clinique.
      PharmAIsearch ne se substitue pas au jugement professionnel.
    </div>
  </div>
</div>

<footer>
  PharmAIsearch — Données SAM2 (AFMPS) — Sources publiques officielles<br>
  Cet outil ne constitue pas un conseil médical. Usage réservé aux professionnels de santé.<br>
  <strong>* AFMPS</strong> — Agence Fédérale des Médicaments et des Produits de Santé
</footer>
</body>
</html>`;
}

// ── Page d'erreur ────────────────────────────────────────────────────────
function pageErreur(amp_id, nom, message, spcUrl) {
  // Récupérer le statut depuis la DB pour personnaliser le message
  let statut = '';
  try {
    const row = getServerDb().prepare(
      'SELECT statut FROM sam2_specialites WHERE amp_id = ?'
    ).get(amp_id);
    statut = row ? (row.statut || '') : '';
  } catch (e) {
    statut = '';
  }

  // Récupérer la date de mise à jour de la base SAM2
  // (basée sur la date de modification du fichier .db sur le disque)
  let dateMaj = '';
  try {
    const fsLocal = require('fs');
    const pathLocal = require('path');
    const DB_VOLUME = '/data/pharmasearch.db';
    const DB_LOCAL  = pathLocal.join(__dirname, 'data/pharmasearch.db');
    const dbPath = process.env.RAILWAY_ENVIRONMENT
      ? (fsLocal.existsSync(DB_VOLUME) ? DB_VOLUME : DB_LOCAL)
      : (process.env.DB_PATH || DB_LOCAL);
    const stat = fsLocal.statSync(dbPath);
    const d = stat.mtime;
    const jj = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const aaaa = d.getFullYear();
    dateMaj = `${jj}/${mm}/${aaaa}`;
  } catch (e) {
    dateMaj = '';
  }

  // Construire le message personnalisé selon le statut
  let messageStatut = '';
  switch (statut) {
    case 'REVOKED':
      messageStatut = 'Ce médicament a été <strong>retiré du marché belge</strong> (autorisation révoquée par l\'AFMPS).';
      break;
    case 'SUSPENDED':
      messageStatut = 'L\'autorisation de mise sur le marché de ce médicament est <strong>suspendue</strong>.';
      break;
    case 'WITHDRAWN':
      messageStatut = 'Ce médicament a fait l\'objet d\'un <strong>arrêt de commercialisation</strong>.';
      break;
    case 'AUTHORIZED':
      messageStatut = 'La notice n\'est pas disponible directement dans la base SAM2 pour ce médicament.';
      break;
    case '':
      messageStatut = escHtml(message || 'Information non disponible.');
      break;
    default:
      messageStatut = `Statut du médicament : <code>${escHtml(statut)}</code>.`;
  }

  const dateNote = dateMaj
    ? `<span class="date-note">(d'après notre base SAM2 mise à jour le ${dateMaj})</span>`
    : '';

  return `<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>RCP — ${escHtml(nom || amp_id)}</title>
<style>
  body{font-family:-apple-system,sans-serif;background:#f0f4f8;color:#1a202c;font-size:16px;margin:0;}
  header{background:#1a365d;color:white;padding:16px 28px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;}
  .header-logo{font-family:'Arial Black',Impact,sans-serif;font-size:1.4rem;font-weight:900;letter-spacing:2px;display:flex;align-items:baseline;}
  .big{font-size:1.8rem;}
  .ai{color:#4dd0e1;font-size:1.8rem;letter-spacing:1px;}
  .back-btn{background:rgba(255,255,255,0.15);border:2px solid rgba(255,255,255,0.4);color:white;padding:7px 14px;border-radius:8px;cursor:pointer;font-size:0.9rem;font-weight:600;text-decoration:none;}
  .back-btn:hover{background:rgba(255,255,255,0.25);}
  .container{max-width:860px;margin:40px auto;padding:0 20px;}
  .err{background:white;border-radius:14px;padding:32px;box-shadow:0 2px 16px rgba(0,0,0,0.09);}
  .err h2{color:#c53030;margin:0 0 12px;font-size:1.3rem;}
  .drug-name{font-size:1.4rem;font-weight:700;color:#1a365d;margin-bottom:18px;padding-bottom:14px;border-bottom:2px solid #e2e8f0;}
  .err p{color:#4a5568;line-height:1.7;margin:0 0 14px;}
  .date-note{display:block;margin-top:8px;font-size:0.82rem;color:#a0aec0;font-style:italic;}
  .sources-intro{margin-top:22px;color:#2d3748;font-weight:600;}
  .btn-row{display:flex;gap:14px;flex-wrap:wrap;margin-top:14px;}
  .src-btn{display:inline-flex;align-items:center;gap:8px;padding:13px 22px;color:white;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;text-decoration:none;transition:opacity 0.2s;flex:1;justify-content:center;min-width:200px;}
  .src-btn:hover{opacity:0.88;}
  .src-afmps{background:#1a365d;}
  .src-cbip{background:#2b6cb0;}
  .pdf-btn{display:inline-flex;align-items:center;gap:8px;padding:12px 22px;background:#e53e3e;color:white;border:none;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer;text-decoration:none;margin-top:14px;}
  .pdf-btn:hover{background:#c53030;}
  footer{text-align:center;padding:24px;font-size:0.82rem;color:#a0aec0;line-height:1.7;}
</style></head>
<body>
<header>
  <div class="header-logo"><span class="big">P</span>HARM<span class="ai">AI</span><span class="big">S</span>EARCH</div>
  <a href="https://pharmaisearch.com" class="back-btn">← Accueil</a>
</header>
<div class="container">
  <div class="err">
    <h2>⚠️ Notice non disponible</h2>
    <div class="drug-name">${escHtml(nom || amp_id)}</div>
    <p>${messageStatut} ${dateNote}</p>
    ${spcUrl ? `<p><a href="${escHtml(spcUrl)}" target="_blank" rel="noopener" class="pdf-btn">📥 Ouvrir le PDF officiel AFMPS directement</a></p>` : ''}
    <div class="sources-intro">Pour vérifier le statut le plus récent et consulter la notice, référez-vous aux sources officielles :</div>
    <div class="btn-row">
      <a href="https://www.afmps.be/fr" target="_blank" rel="noopener" class="src-btn src-afmps">🔍 Recherche AFMPS</a>
      <a href="https://www.cbip.be/fr" target="_blank" rel="noopener" class="src-btn src-cbip">📋 Consulter le CBIP</a>
    </div>
  </div>
</div>
<footer>
  PharmAIsearch — Données SAM2 (AFMPS) — Sources publiques officielles<br>
  Cet outil ne constitue pas un conseil médical. Usage réservé aux professionnels de santé.
</footer>
</body></html>`;
}
function escHtml(str) {
  return (str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Multi-recherche ────────────────────────────────────────────────────────
app.get('/api/multi-search', (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json({ query: q, result: null });

    // Normaliser : retirer dosage et forme pour garder le nom de base
    function normStr(s) {
      return (s || '').toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    }

    const qNorm = normStr(q);

    // Essai 1 : correspondance exacte sur nom_fr
    let row = getServerDb().prepare(`
      SELECT amp_id, nom_fr, forme_fr, voies_fr, statut, titulaire, spc_url_fr
      FROM sam2_specialites
      WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        nom_fr,'é','e'),'è','e'),'ê','e'),'à','a'),'ô','o'),'î','i'))
      = ?
      AND statut = 'AUTHORIZED'
      LIMIT 1
    `).get(qNorm);

    // Essai 2 : correspondance partielle — le nom de la DB commence par q
    if (!row) {
      row = getServerDb().prepare(`
        SELECT amp_id, nom_fr, forme_fr, voies_fr, statut, titulaire, spc_url_fr
        FROM sam2_specialites
        WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
          nom_fr,'é','e'),'è','e'),'ê','e'),'à','a'),'ô','o'),'î','i'))
        LIKE ?
        AND statut = 'AUTHORIZED'
        ORDER BY LENGTH(nom_fr) ASC
        LIMIT 1
      `).get(qNorm + '%');
    }

    // Essai 3 : q contient le nom (recherche dans les deux sens)
    if (!row) {
      row = getServerDb().prepare(`
        SELECT amp_id, nom_fr, forme_fr, voies_fr, statut, titulaire, spc_url_fr
        FROM sam2_specialites
        WHERE LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
          nom_fr,'é','e'),'è','e'),'ê','e'),'à','a'),'ô','o'),'î','i'))
        LIKE ?
        AND statut = 'AUTHORIZED'
        ORDER BY LENGTH(nom_fr) ASC
        LIMIT 1
      `).get('%' + qNorm + '%');
    }

    res.json({ query: q, result: row || null });
  } catch (err) {
    console.error('Erreur multi-search:', err.message);
    res.json({ query: req.query.q || '', result: null });
  }
});

// ── Debug : voir le texte brut du PDF ────────────────────────────────────
app.get('/api/rcp-debug', async (req, res) => {
  const amp_id = (req.query.amp_id || '').trim();
  const spec = getServerDb().prepare('SELECT spc_url_fr FROM sam2_specialites WHERE amp_id = ?').get(amp_id);
  if (!spec || !spec.spc_url_fr) return res.send('Pas de lien');
  try {
    const buf = await fetchPdf(spec.spc_url_fr);
    const data = await parsePdf(buf);
    // Chercher la zone autour de "6.1" et "6.2"
    const t = data.text;
    const i61 = t.search(/6[\s.]*1[\s.]*(Liste|Excipient)/i);
    const i62 = t.search(/6[\s.]*2[\s.]*(Incompatibilit|Nature)/i);
    const debut = Math.max(0, i61 - 50);
    const fin   = i62 > 0 ? Math.min(i62 + 100, t.length) : Math.min(i61 + 1000, t.length);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send('=== i61=' + i61 + ' i62=' + i62 + ' ===\n\n' + t.substring(debut, fin));
  } catch(e) {
    res.send('Erreur: ' + e.message);
  }
});

app.listen(PORT, () => {
  console.log(`PharmaSearch démarré sur http://localhost:${PORT}`);
  console.log(`Base SAM2 (19 763 spécialités belges) ✅`);
  console.log(`Extraction RCP AFMPS (rubrique 6.1) ✅`);
});
