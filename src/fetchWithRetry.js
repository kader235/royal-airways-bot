// =============================================================
// FETCHER ROBUSTE — Pattern à utiliser pour announcements et routes
// =============================================================
// Améliorations :
//   - Timeout 90s (au lieu de 5s ou 30s par défaut)
//   - Retry automatique avec exponential backoff (1s, 3s, 9s)
//   - Logs détaillés pour debug
//   - Fallback gracieux si tout échoue (pas de crash)
// =============================================================

import fetch from 'node-fetch';

/**
 * Fetch HTTP avec timeout et retry automatique
 *
 * @param {string} url - URL à appeler
 * @param {object} options - Options de la requête fetch
 * @param {object} config - { name, maxRetries, timeoutMs }
 * @returns {Promise<object|null>} - Données JSON ou null si échec
 */
export async function fetchWithRetry(url, options = {}, config = {}) {
  const {
    name = 'unnamed',
    maxRetries = 3,
    timeoutMs = 90000, // 90 secondes pour réveiller Render Free Tier
  } = config;

  const delays = [1000, 3000, 9000]; // 1s, 3s, 9s entre essais

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      console.log(`[fetcher/${name}] Essai ${attempt + 1}/${maxRetries} : ${url}`);

      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const data = await response.json();
      console.log(`[fetcher/${name}] ✓ OK (essai ${attempt + 1})`);
      return data;

    } catch (error) {
      clearTimeout(timeoutId);

      const isLastAttempt = attempt === maxRetries - 1;
      const errorMsg = error.name === 'AbortError'
        ? `Timeout après ${timeoutMs / 1000}s`
        : error.message;

      console.log(`[fetcher/${name}] ✗ Essai ${attempt + 1} : ${errorMsg}`);

      if (isLastAttempt) {
        console.error(`[fetcher/${name}] ❌ Tous les essais ont échoué`);
        return null; // Fallback gracieux : pas de crash
      }

      const delay = delays[attempt];
      console.log(`[fetcher/${name}] ⏳ Nouvelle tentative dans ${delay / 1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return null;
}