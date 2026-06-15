// =============================================================
// announcementsFetcher.js — Version robuste
// =============================================================
// Récupère les annonces actives depuis le backend admin Royal Airways
// Patch : timeout 90s + retry 3x + fallback gracieux
// =============================================================

import { fetchWithRetry } from './fetchWithRetry.js';

const ADMIN_API_URL = process.env.ADMIN_API_URL || 'https://royal-airways-admin-api.onrender.com';
const ENDPOINT = `${ADMIN_API_URL}/api/announcements/active`;

let cachedAnnouncements = []; // Cache mémoire pour fallback
let lastFetchTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Récupère les annonces actives, avec cache et fallback
 * @returns {Promise<Array>} Tableau des annonces (vide si tout échoue)
 */
export async function fetchAnnouncements() {
  const now = Date.now();

  // Utiliser le cache si récent
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

  if (data && Array.isArray(data.announcements)) {
    cachedAnnouncements = data.announcements;
    lastFetchTime = now;
    console.log(`[fetcher/announcements] ${data.announcements.length} annonces chargées`);
    return data.announcements;
  }

  // Fallback : retourner le dernier cache connu, même expiré
  if (cachedAnnouncements.length > 0) {
    console.warn(`[fetcher/announcements] ⚠ Utilisation du cache expiré (${cachedAnnouncements.length} annonces)`);
    return cachedAnnouncements;
  }

  console.warn(`[fetcher/announcements] ⚠ Aucune annonce disponible (backend HS)`);
  return [];
}