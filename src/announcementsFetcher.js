// =============================================================
// announcementsFetcher.js — Version robuste compatible
// =============================================================
// Garde getActiveAnnouncementsForPrompt utilisé par brain.js
// Ajoute timeout 90s + retry + cache
// =============================================================

import { fetchWithRetry } from './fetchWithRetry.js';

const ADMIN_API_URL = process.env.ADMIN_API_URL || 'https://royal-airways-admin-api.onrender.com';
const ENDPOINT = `${ADMIN_API_URL}/api/announcements/active`;

let cachedAnnouncements = [];
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Récupère les annonces actives, avec cache et fallback
 */
export async function fetchAnnouncements() {
  const now = Date.now();

  if (cachedAnnouncements.length > 0 && (now - lastFetchTime) < CACHE_TTL) {
    return cachedAnnouncements;
  }

  const data = await fetchWithRetry(
    ENDPOINT,
    {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
    },
    {
      name: 'announcements',
      maxRetries: 3,
      timeoutMs: 90000,
    }
  );

  // Selon la structure de réponse : data.announcements OU data directement
  let announcements = null;
  if (data) {
    if (Array.isArray(data.announcements)) announcements = data.announcements;
    else if (Array.isArray(data)) announcements = data;
  }

  if (announcements) {
    cachedAnnouncements = announcements;
    lastFetchTime = now;
    console.log(`[fetcher/announcements] ${announcements.length} annonces chargées`);
    return announcements;
  }

  if (cachedAnnouncements.length > 0) {
    console.warn(`[fetcher/announcements] ⚠ Utilisation du cache expiré`);
    return cachedAnnouncements;
  }

  console.warn(`[fetcher/announcements] ⚠ Aucune annonce disponible`);
  return [];
}

/**
 * COMPATIBILITÉ : retourne les annonces formatées pour injection dans le prompt
 * (fonction utilisée par brain.js)
 */
export async function getActiveAnnouncementsForPrompt() {
  const announcements = await fetchAnnouncements();

  if (!announcements || announcements.length === 0) {
    return '';
  }

  // Formatage pour injection dans le system prompt
  const formatted = announcements
    .map((a, i) => {
      // Adaptation selon la structure : titre/title, message/content, etc.
      const title = a.titre || a.title || a.nom || `Annonce ${i + 1}`;
      const content = a.message || a.content || a.contenu || a.texte || '';
      return `- ${title} : ${content}`;
    })
    .join('\n');

  return `\n\n## ANNONCES ACTIVES\n${formatted}\n`;
}