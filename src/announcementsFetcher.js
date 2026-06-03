// src/announcementsFetcher.js
//
// Module a ajouter au projet royal-airways-bot.
// Recupere depuis l'admin API : annonces actives + lignes + tarifs + bagages.
// Cache court (1 min) pour ne pas faire 4 appels HTTP par message.
//
// Variables d'env attendues :
//   ADMIN_API_URL  - ex: https://royal-airways-admin-api.onrender.com
//   BOT_SYNC_KEY   - la meme cle secrete que cote admin

const ADMIN_API_URL = process.env.ADMIN_API_URL;
const BOT_SYNC_KEY = process.env.BOT_SYNC_KEY;

// Cache par endpoint pour eviter d'appeler les 4 routes a chaque message.
const CACHE_TTL_MS = 60_000; // 1 minute
const cache = {
  announcements: { data: null, fetchedAt: 0 },
  routes:        { data: null, fetchedAt: 0 },
  fares:         { data: null, fetchedAt: 0 },
  knowledge:     { data: null, fetchedAt: 0 },
};

// ============================================================
// Fonction de fetch generique avec cache
// ============================================================

async function fetchEndpoint(name, path) {
  const now = Date.now();
  if (cache[name].data && (now - cache[name].fetchedAt) < CACHE_TTL_MS) {
    return cache[name].data;
  }

  if (!ADMIN_API_URL || !BOT_SYNC_KEY) {
    console.warn(`[fetcher/${name}] ADMIN_API_URL ou BOT_SYNC_KEY absent.`);
    return null;
  }

  try {
    const res = await fetch(`${ADMIN_API_URL}${path}`, {
      headers: { 'X-Bot-Key': BOT_SYNC_KEY },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.error(`[fetcher/${name}] HTTP ${res.status}`);
      return cache[name].data;
    }
    const data = await res.json();
    cache[name] = { data, fetchedAt: now };
    return data;
  } catch (err) {
    console.error(`[fetcher/${name}] Erreur fetch :`, err.message);
    return cache[name].data;
  }
}

// ============================================================
// ANNONCES
// ============================================================

export async function getActiveAnnouncements() {
  const data = await fetchEndpoint('announcements', '/bot-sync/announcements');
  return data || { announcements: [], count: 0 };
}

export async function getActiveAnnouncementsForPrompt() {
  const data = await getActiveAnnouncements();
  if (!data.announcements || data.announcements.length === 0) {
    return 'Aucune annonce particuliere en ce moment.';
  }
  const lines = ['Annonces actives en ce moment :', ''];
  for (const a of data.announcements) {
    const prefix = a.priority === 'urgent' ? '[URGENT] ' : '- ';
    lines.push(`${prefix}${a.title}`);
    lines.push(a.description);
    const until = new Date(a.valid_until).toLocaleDateString('fr-FR', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    lines.push(`Valable jusqu'au ${until}.`);
    lines.push('');
  }
  return lines.join('\n').trim();
}

// ============================================================
// LIGNES
// ============================================================

const DAYS = ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'];

export async function getRoutesForPrompt() {
  const data = await fetchEndpoint('routes', '/bot-sync/routes');
  if (!data || !data.routes || data.routes.length === 0) {
    return 'Aucune ligne enregistree actuellement.';
  }

  const dom = data.routes.filter((r) => !r.is_international);
  const intl = data.routes.filter((r) => r.is_international);
  const lines = ['Lignes operees par Royal Airways :', ''];

  if (dom.length > 0) {
    lines.push('Vols domestiques :');
    for (const r of dom) {
      const days = (r.operating_days || []).sort().map((d) => DAYS[d]).join('/');
      const stops = r.stops && r.stops.length > 0 ? ` (via ${r.stops.join(', ')})` : '';
      const daysPart = days ? ` — opere ${days}` : '';
      lines.push(`- ${r.origin} <-> ${r.destination}${stops}${daysPart}`);
      if (r.notes) lines.push(`  ${r.notes}`);
    }
    lines.push('');
  }

  if (intl.length > 0) {
    lines.push('Vols internationaux :');
    for (const r of intl) {
      const days = (r.operating_days || []).sort().map((d) => DAYS[d]).join('/');
      const stops = r.stops && r.stops.length > 0 ? ` (via ${r.stops.join(', ')})` : '';
      const daysPart = days ? ` — opere ${days}` : '';
      lines.push(`- ${r.origin} <-> ${r.destination}${stops}${daysPart}`);
      if (r.notes) lines.push(`  ${r.notes}`);
    }
  }

  return lines.join('\n').trim();
}

// ============================================================
// TARIFS
// ============================================================

const FARE_CLASS_LABEL = {
  eco: 'Eco',
  business: 'Affaires',
  premium: 'Premium',
};

function formatPrice(n, currency) {
  const formatted = new Intl.NumberFormat('fr-FR').format(n);
  return `${formatted} ${currency || 'XAF'}`;
}

export async function getFaresForPrompt() {
  const data = await fetchEndpoint('fares', '/bot-sync/fares');
  if (!data || !data.fares || data.fares.length === 0) {
    return 'Aucun tarif de reference disponible actuellement. Renvoie systematiquement les clients vers flyroyalairways.com ou +235 64 00 00 61.';
  }

  // Group by route
  const byRoute = {};
  for (const f of data.fares) {
    const key = `${f.origin} <-> ${f.destination}`;
    if (!byRoute[key]) byRoute[key] = [];
    byRoute[key].push(f);
  }

  const lines = ['Tarifs de reference (a partir de) :', ''];
  for (const [route, fares] of Object.entries(byRoute)) {
    lines.push(`- ${route}`);
    for (const f of fares) {
      const cls = FARE_CLASS_LABEL[f.fare_class] || f.fare_class;
      lines.push(`  ${cls} : a partir de ${formatPrice(f.starting_price, f.currency)}`);
      if (f.notes) lines.push(`    (${f.notes})`);
    }
  }
  lines.push('');
  lines.push('Important : ces prix sont des points de depart. Le tarif final depend de la date, du remplissage et de la classe choisie. Pour le prix exact, oriente vers flyroyalairways.com ou +235 64 00 00 61.');

  return lines.join('\n').trim();
}

// ============================================================
// BAGAGES & DOCUMENTS (knowledge)
// ============================================================

const CATEGORY_LABEL = {
  bagages: 'Bagages',
  documents: 'Documents de voyage',
  enregistrement: 'Enregistrement',
  assistance: 'Assistance speciale',
  contact: 'Contact et horaires',
  autre: 'Divers',
};

export async function getKnowledgeForPrompt() {
  const data = await fetchEndpoint('knowledge', '/bot-sync/knowledge');
  if (!data || !data.entries || data.entries.length === 0) {
    return 'Aucune information complementaire de reference actuellement.';
  }

  // Group by category
  const byCat = {};
  for (const e of data.entries) {
    if (!byCat[e.category]) byCat[e.category] = [];
    byCat[e.category].push(e);
  }

  const lines = ['Informations de reference :', ''];
  for (const [cat, entries] of Object.entries(byCat)) {
    lines.push(`## ${CATEGORY_LABEL[cat] || cat}`);
    for (const e of entries) {
      lines.push(`- ${e.title}`);
      lines.push(`  ${e.content}`);
    }
    lines.push('');
  }

  return lines.join('\n').trim();
}
