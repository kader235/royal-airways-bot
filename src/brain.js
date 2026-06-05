// brain.js — Le "cerveau" du bot.
// Charge le system prompt + base de connaissances, injecte date, annonces,
// lignes, tarifs et bagages en temps reel, puis appelle l'API Claude.
//
// V2 : ajout du parcours de reservation guidee. Claude peut emettre un signal
// §LINK§{...} a la fin de sa reponse, qui declenche la generation d'un deep link
// vers booking.flyroyalairways.com avec les criteres pre-remplis.

import {
  getActiveAnnouncementsForPrompt,
  getRoutesForPrompt,
  getFaresForPrompt,
  getKnowledgeForPrompt,
} from './announcementsFetcher.js';
import { buildBookingURL } from './bookingLink.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');

// --- Chargement du prompt au demarrage ---
function buildSystemTemplate() {
  const systemTemplate = fs.readFileSync(
    path.join(KNOWLEDGE_DIR, 'system_prompt.md'),
    'utf-8'
  );
  const knowledge = fs.readFileSync(
    path.join(KNOWLEDGE_DIR, 'base_connaissances.md'),
    'utf-8'
  );
  if (!systemTemplate.includes('{{BASE_DE_CONNAISSANCES}}')) {
    console.warn('[brain] Marqueur {{BASE_DE_CONNAISSANCES}} introuvable.');
  }
  return systemTemplate.replace('{{BASE_DE_CONNAISSANCES}}', knowledge);
}

const SYSTEM_TEMPLATE = buildSystemTemplate();

// --- Date du jour au fuseau du Tchad (UTC+1) ---
const JOURS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];

function dateTchad(offsetJours = 0) {
  const maintenant = new Date();
  const tchad = new Date(maintenant.getTime() + (1 * 60 * 60 * 1000) + (offsetJours * 24 * 60 * 60 * 1000));
  const jour = JOURS[tchad.getUTCDay()];
  const num = tchad.getUTCDate();
  const mois = MOIS[tchad.getUTCMonth()];
  const annee = tchad.getUTCFullYear();
  return { jour, texte: jour + ' ' + num + ' ' + mois + ' ' + annee };
}

function buildDateBlock() {
  const aujourdhui = dateTchad(0);
  const demain = dateTchad(1);
  const prochains = [];
  for (let i = 0; i < 7; i++) prochains.push('- ' + dateTchad(i).texte);
  return [
    "Nous sommes aujourd'hui : " + aujourdhui.texte + ' (heure du Tchad).',
    'Demain sera : ' + demain.texte + '.',
    'Les 7 prochains jours :',
    prochains.join('\n'),
  ].join('\n');
}

// --- Construction du system prompt avec tous les blocs dynamiques ---
async function buildDatedSystemPrompt() {
  const dateBlock = buildDateBlock();

  // Recuperation parallele des 4 blocs (cache de 1 min dans le fetcher)
  const [annoncesBlock, routesBlock, faresBlock, knowledgeBlock] = await Promise.all([
    getActiveAnnouncementsForPrompt().catch((e) => {
      console.error('[brain] Annonces :', e.message);
      return 'Aucune annonce disponible.';
    }),
    getRoutesForPrompt().catch((e) => {
      console.error('[brain] Routes :', e.message);
      return 'Aucune ligne disponible.';
    }),
    getFaresForPrompt().catch((e) => {
      console.error('[brain] Tarifs :', e.message);
      return 'Aucun tarif disponible.';
    }),
    getKnowledgeForPrompt().catch((e) => {
      console.error('[brain] Knowledge :', e.message);
      return 'Aucune info complementaire disponible.';
    }),
  ]);

  let prompt = SYSTEM_TEMPLATE;

  // Helper pour injecter un bloc avec fallback (ajout en tete si marqueur absent)
  function inject(marker, block) {
    if (prompt.includes(marker)) {
      prompt = prompt.replace(marker, block);
    } else {
      console.warn(`[brain] Marqueur ${marker} absent du system_prompt.md, ajout en tete.`);
      prompt = block + '\n\n' + prompt;
    }
  }

  inject('{{DATE_DU_JOUR}}', dateBlock);
  inject('{{ANNONCES_ACTIVES}}', annoncesBlock);
  inject('{{LIGNES_ACTUELLES}}', routesBlock);
  inject('{{TARIFS_ACTUELS}}', faresBlock);
  inject('{{BAGAGES_ET_DOCS}}', knowledgeBlock);

  return prompt;
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-7';
const CTRL_MARKER = '§CTRL§';
const LINK_MARKER = '§LINK§';

// Parse le signal de controle §CTRL§{json} a la fin de la reponse.
function parseControlSignal(rawText) {
  const idx = rawText.lastIndexOf(CTRL_MARKER);
  const fallback = { escalade: false, motif: null, langue: 'fr', intention: 'autre' };
  if (idx === -1) return { reply: rawText.trim(), control: fallback, controlOk: false };

  const reply = rawText.slice(0, idx).trim();
  const jsonPart = rawText.slice(idx + CTRL_MARKER.length).trim();
  try {
    const control = JSON.parse(jsonPart);
    return { reply, control: { ...fallback, ...control }, controlOk: true };
  } catch (err) {
    console.warn('[brain] Signal de controle illisible :', jsonPart);
    return { reply, control: fallback, controlOk: false };
  }
}

// Parse le signal de reservation §LINK§{json} dans la reponse.
// Retire le marqueur du texte, et si valide, retourne les criteres de booking.
function parseBookingSignal(text) {
  const idx = text.indexOf(LINK_MARKER);
  if (idx === -1) return { text, bookingRequest: null };

  // Cherche la fin du JSON (premiere accolade fermante en fin de ligne ou en fin)
  const afterMarker = text.slice(idx + LINK_MARKER.length);

  // Strategie simple : on cherche la fin du JSON en comptant les accolades
  let depth = 0;
  let endPos = -1;
  let started = false;
  for (let i = 0; i < afterMarker.length; i++) {
    const ch = afterMarker[i];
    if (ch === '{') {
      depth++;
      started = true;
    } else if (ch === '}') {
      depth--;
      if (started && depth === 0) {
        endPos = i + 1;
        break;
      }
    }
  }

  if (endPos === -1) {
    console.warn('[brain] Signal §LINK§ mal forme (pas de } final)');
    return { text: text.slice(0, idx).trim(), bookingRequest: null };
  }

  const jsonStr = afterMarker.slice(0, endPos).trim();
  const cleanText = (text.slice(0, idx) + afterMarker.slice(endPos)).trim();

  try {
    const bookingRequest = JSON.parse(jsonStr);
    return { text: cleanText, bookingRequest };
  } catch (err) {
    console.warn('[brain] JSON §LINK§ illisible :', jsonStr);
    return { text: cleanText, bookingRequest: null };
  }
}

// Genere le bloc texte a ajouter a la reponse quand un lien est demande.
function formatBookingLink(bookingRequest) {
  console.log('[booking] Demande de lien :', JSON.stringify(bookingRequest));

  const result = buildBookingURL({
    from: bookingRequest.from,
    to: bookingRequest.to,
    date: bookingRequest.date,
    adults: bookingRequest.adults,
    children: bookingRequest.children || 0,
    infants: bookingRequest.infants || 0,
  });

  if (!result.success) {
    console.log('[booking] Echec :', result.error);
    return `\n\n⚠️ Impossible de generer le lien : ${result.error}\n\nPour finaliser votre reservation, contactez le service client au +235 64 00 00 61 ou rendez-vous sur flyroyalairways.com`;
  }

  console.log('[booking] Lien genere :', result.url);

  // Format passagers lisible
  const passagers = [];
  if (result.summary.adults > 0) passagers.push(`${result.summary.adults} adulte${result.summary.adults > 1 ? 's' : ''}`);
  if (result.summary.children > 0) passagers.push(`${result.summary.children} enfant${result.summary.children > 1 ? 's' : ''}`);
  if (result.summary.infants > 0) passagers.push(`${result.summary.infants} bebe${result.summary.infants > 1 ? 's' : ''}`);

  return `\n\n✈️ *Lien de reservation Royal Airways :*\n${result.url}\n\n📋 ${result.summary.from} → ${result.summary.to} · ${result.summary.date} · ${passagers.join(', ')}\n\nCliquez sur le lien pour choisir votre classe et payer en ligne sur le site officiel.`;
}

export async function generateReply(history, userMessage) {
  const messages = [...history, { role: 'user', content: userMessage }];
  const systemPrompt = await buildDatedSystemPrompt();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  let rawText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  // 1. Extraire et traiter le signal §LINK§ (parcours reservation)
  const { text: textAfterLink, bookingRequest } = parseBookingSignal(rawText);
  rawText = textAfterLink;
  if (bookingRequest) {
    rawText = rawText + formatBookingLink(bookingRequest);
  }

  // 2. Extraire le signal §CTRL§ (comme avant)
  return parseControlSignal(rawText);
}
