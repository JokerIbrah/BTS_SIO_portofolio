/**
 * fetch-cert-fr.mjs
 * -----------------------------------------------------------------------------
 * Récupère les flux RSS du CERT-FR (ANSSI) et les écrit dans data/cert-fr.js,
 * sous la forme d'une simple affectation : window.CERT_FR_DATA = { ... }
 *
 * Ce format est volontairement un fichier .js et non un .json : la page le
 * charge avec une balise <script>, ce qui fonctionne partout, y compris quand
 * le fichier HTML est ouvert par double-clic (protocole file://), là où fetch()
 * serait bloqué par le navigateur.
 *
 * Ce script est exécuté par la GitHub Action .github/workflows/cert-fr.yml,
 * sur l'infrastructure gratuite de GitHub. Aucun serveur n'est nécessaire.
 *
 * Aucune dépendance externe : Node 20 fournit fetch() nativement et le parsing
 * RSS est fait à l'aide d'expressions régulières, suffisantes pour ce flux.
 *
 * Usage local : node scripts/fetch-cert-fr.mjs
 */

import { writeFile, mkdir } from 'node:fs/promises';

const FEEDS = [
  { url: 'https://www.cert.ssi.gouv.fr/alerte/feed/', type: 'alerte' },
  { url: 'https://www.cert.ssi.gouv.fr/avis/feed/', type: 'avis' },
  { url: 'https://www.cert.ssi.gouv.fr/actualite/feed/', type: 'actualite' },
  { url: 'https://www.cert.ssi.gouv.fr/cti/feed/', type: 'cti' },
  { url: 'https://www.cert.ssi.gouv.fr/ioc/feed/', type: 'ioc' },
  { url: 'https://www.cert.ssi.gouv.fr/dur/feed/', type: 'dur' }
];

const OUTPUT = 'data/cert-fr.js';
const MAX_ITEMS = 120;
const USER_AGENT =
  'Mozilla/5.0 (compatible; PortfolioBTSSIO/1.0; +https://jokeribrah.github.io/BTS_SIO_portofolio/)';

/* -------------------------------------------------------------------------- */
/* Outils de parsing                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Table des entités nommées rencontrées dans les flux du CERT-FR.
 * Le flux mélange des caractères accentués bruts, des entités numériques
 * (&#233;) et des entités nommées (&eacute;), y compris à l'intérieur des
 * blocs CDATA : il faut donc traiter les trois cas.
 */
const NAMED_ENTITIES = {
  nbsp: ' ', laquo: '«', raquo: '»', hellip: '…', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  agrave: 'à', Agrave: 'À', acirc: 'â', Acirc: 'Â', aelig: 'æ', AElig: 'Æ',
  ccedil: 'ç', Ccedil: 'Ç', egrave: 'è', Egrave: 'È', eacute: 'é', Eacute: 'É',
  ecirc: 'ê', Ecirc: 'Ê', euml: 'ë', Euml: 'Ë', icirc: 'î', Icirc: 'Î',
  iuml: 'ï', Iuml: 'Ï', ocirc: 'ô', Ocirc: 'Ô', oelig: 'œ', OElig: 'Œ',
  ouml: 'ö', Ouml: 'Ö', ugrave: 'ù', Ugrave: 'Ù', ucirc: 'û', Ucirc: 'Û',
  uuml: 'ü', Uuml: 'Ü', deg: '°', euro: '€', copy: '©', reg: '®',
  trade: '™', middot: '·', bull: '•', times: '×', szlig: 'ß',
  ntilde: 'ñ', aacute: 'á', iacute: 'í', oacute: 'ó', uacute: 'ú'
};

/** Décode les entités XML/HTML (numériques et nommées) et les blocs CDATA. */
function decodeEntities(str = '') {
  return str
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&(\w+);/g, (match, name) => {
      if (name === 'lt') return '<';
      if (name === 'gt') return '>';
      if (name === 'quot') return '"';
      if (name === 'apos') return "'";
      if (name === 'amp') return '&';
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
        ? NAMED_ENTITIES[name]
        : match;
    });
}

/** Retire les balises HTML et normalise les espaces. */
function stripTags(str = '') {
  return decodeEntities(str).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Extrait le contenu d'une balise dans un bloc <item>. */
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

/** Déduit le type de publication à partir de l'URL du bulletin. */
function typeFromLink(link = '') {
  const l = link.toLowerCase();
  if (l.includes('/alerte/')) return 'alerte';
  if (l.includes('/avis/')) return 'avis';
  if (l.includes('/actualite/')) return 'actualite';
  if (l.includes('/cti/')) return 'cti';
  if (l.includes('/ioc/')) return 'ioc';
  if (l.includes('/dur/')) return 'dur';
  return 'autre';
}

/** Récupère l'identifiant officiel, ex. CERTFR-2026-AVI-0712. */
function idFromLink(link = '') {
  const m = link.match(/CERTFR-\d{4}-[A-Z]{3}-\d+/i);
  return m ? m[0].toUpperCase() : '';
}

/** Le CERT-FR suffixe souvent ses titres par « (24 août 2026) ». */
function cleanTitle(title = '') {
  return title.replace(/\s*\((?:\d{1,2}\s+\S+\s+\d{4})\)\s*$/u, '').trim();
}

/** Transforme un flux RSS en tableau d'objets. */
function parseRss(xml, fallbackType) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  const items = [];

  for (const block of blocks) {
    const title = stripTags(tag(block, 'title'));
    const link = tag(block, 'link');
    if (!title || !link) continue;

    const detected = typeFromLink(link);
    const description = stripTags(tag(block, 'description'));

    items.push({
      title: cleanTitle(title),
      link,
      date: tag(block, 'pubDate'),
      description: description.length > 400 ? `${description.slice(0, 400)}…` : description,
      type: detected !== 'autre' ? detected : fallbackType,
      id: idFromLink(link)
    });
  }

  return items;
}

/* -------------------------------------------------------------------------- */
/* Récupération                                                               */
/* -------------------------------------------------------------------------- */

async function fetchFeed({ url, type }, attempt = 1) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/rss+xml, application/xml, text/xml' },
      signal: AbortSignal.timeout(20000)
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const items = parseRss(await res.text(), type);
    console.log(`  OK   ${url} -> ${items.length} bulletins`);
    return items;
  } catch (err) {
    if (attempt < 3) {
      console.log(`  ...  ${url} : ${err.message}, nouvelle tentative (${attempt + 1}/3)`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      return fetchFeed({ url, type }, attempt + 1);
    }
    console.error(`  KO   ${url} : ${err.message}`);
    return [];
  }
}

async function main() {
  console.log('Récupération des flux CERT-FR...');

  const results = await Promise.all(FEEDS.map((feed) => fetchFeed(feed)));

  // Fusion, dédoublonnage par lien, tri antéchronologique
  const seen = new Set();
  const items = results
    .flat()
    .filter((item) => {
      if (seen.has(item.link)) return false;
      seen.add(item.link);
      return true;
    })
    .sort((a, b) => {
      const ta = Date.parse(a.date) || 0;
      const tb = Date.parse(b.date) || 0;
      return tb - ta;
    })
    .slice(0, MAX_ITEMS);

  if (items.length === 0) {
    // On sort en erreur pour ne PAS écraser un cache valide par un fichier vide
    console.error('Aucun bulletin récupéré : le fichier existant est conservé.');
    process.exit(1);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    source: 'CERT-FR / ANSSI — https://www.cert.ssi.gouv.fr/',
    note: "Données publiques reprises à des fins de veille, avec lien vers la publication d'origine.",
    count: items.length,
    items
  };

  const header =
    '/* Bulletins CERT-FR embarques dans la page.\n' +
    '   Fichier regenere automatiquement par la GitHub Action "Veille CERT-FR".\n' +
    '   Ne pas editer a la main. */\n' +
    'window.CERT_FR_DATA = ';

  await mkdir('data', { recursive: true });
  await writeFile(OUTPUT, `${header}${JSON.stringify(payload, null, 2)};\n`, 'utf8');

  console.log(`Écrit : ${OUTPUT} (${items.length} bulletins)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
