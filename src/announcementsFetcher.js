// src/announcementsFetcher.js
//
// Module a ajouter au projet royal-airways-bot.
// Recupere les annonces actives depuis l'admin API, avec un cache court (1 min)
// pour ne pas faire 1 appel HTTP par message recu.
//
// Variables d'env attendues dans le projet bot :
//   ADMIN_API_URL   - ex: https://royal-airways-admin-api.onrender.com
//   BOT_SYNC_KEY    - la meme cle secrete que cote admin
//
// Usage dans brain.js (ou ton fichier qui construit le system prompt) :
//
//   import { getActiveAnnouncementsForPrompt } from './announcementsFetcher.js';
//
//   const announcementsText = await getActiveAnnouncementsForPrompt();
//   const systemPrompt = baseSystemPrompt
//     .replace('{{DATE_DU_JOUR}}', ...)
//     .replace('{{ANNONCES_ACTIVES}}', announcementsText);

const ADMIN_API_URL = process.env.ADMIN_API_URL;
const BOT_SYNC_KEY = process.env.BOT_SYNC_KEY;

// Cache simple en memoire (par instance Render). Suffisant car le bot tourne en single instance.
let cache = { data: null, fetchedAt: 0 };
const CACHE_TTL_MS = 60_000; // 1 minute. Equilibre frais/perf.

// ============================================================
// API publique du module
// ============================================================

/**
 * Recupere les annonces actives, avec cache.
 * Retourne un objet { announcements: [...], count: n }.
 * En cas d'erreur reseau, retourne le dernier cache valide ou un objet vide.
 */
export async function getActiveAnnouncements() {
  const now = Date.now();
  if (cache.data && (now - cache.fetchedAt) < CACHE_TTL_MS) {
    return cache.data;
  }

  if (!ADMIN_API_URL || !BOT_SYNC_KEY) {
    console.warn('[announcementsFetcher] ADMIN_API_URL ou BOT_SYNC_KEY absent, on ignore les annonces.');
    return { announcements: [], count: 0 };
  }

  try {
    const res = await fetch(`${ADMIN_API_URL}/bot-sync/announcements`, {
      headers: { 'X-Bot-Key': BOT_SYNC_KEY },
      // timeout court pour ne pas bloquer le bot si l'admin est lente
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      console.error('[announcementsFetcher] HTTP', res.status);
      return cache.data || { announcements: [], count: 0 };
    }
    const data = await res.json();
    cache = { data, fetchedAt: now };
    return data;
  } catch (err) {
    console.error('[announcementsFetcher] Erreur fetch :', err.message);
    return cache.data || { announcements: [], count: 0 };
  }
}

/**
 * Retourne un texte formate pour etre injecte dans le system prompt du bot.
 * Format lisible par le LLM, avec hierarchie (urgent en premier).
 *
 * Exemple de sortie :
 *
 *   Annonces actives en ce moment :
 *
 *   [URGENT] Vol RA208 N'Djamena → Abéché reporté
 *   Décollage 14:30 au lieu de 09:15, raison technique.
 *   Valable jusqu'au 24 mai 2026.
 *
 *   - Ligne Douala complète ce week-end
 *   Aucune place disponible vendredi et dimanche.
 *   Valable du 23 au 26 mai.
 */
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

    const until = new Date(a.valid_until);
    const untilStr = until.toLocaleDateString('fr-FR', {
      day: 'numeric', month: 'long', year: 'numeric',
    });
    lines.push(`Valable jusqu'au ${untilStr}.`);
    lines.push('');
  }

  return lines.join('\n').trim();
}
