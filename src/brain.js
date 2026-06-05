// brain.js — Le "cerveau" du bot.
// Charge le system prompt + base de connaissances, injecte date, annonces,
// lignes, tarifs et bagages en temps reel, puis appelle l'API Claude.
//
// V2.1 : parcours de reservation guidee + ordre de parsing corrige.
//        Claude peut emettre §LINK§{...} suivi de §CTRL§{...} en fin de reponse.
//        On parse §CTRL§ EN PREMIER (toujours en dernier dans le texte),
//        puis §LINK§ sur le reste.

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

// Extrait un JSON balance (avec accolades equilibrees) commence quelque part
// apres la position 'start' dans 'text'. Cherche la premiere '{' apres start,
// puis matche les accolades en tenant compte des chaines et de l'echappement.
// Retourne { json, endPos } ou null si pas trouve.
function extractBalancedJSON(text, start) {
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  let startedAt = -1;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\' && inString) {
      escapeNext = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (ch === '{') {
      if (startedAt === -1) startedAt = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && startedAt !== -1) {
        return { json: text.slice(startedAt, i + 1), endPos: i + 1 };
      }
    }
  }
  return null;
}

// Parse le signal §CTRL§{...} en FIN de texte.
// C'est TOUJOURS le dernier signal (le bot est instruit de le mettre a la fin).
function parseControlSignal(rawText) {
  const idx = rawText.lastIndexOf(CTRL_MARKER);
  const fallback = { escalade: false, motif: null, langue: 'fr', intention: 'autre' };
  if (idx === -1) return { reply: rawText.trim(), control: fallback, controlOk: false };

  const reply = rawText.slice(0, idx).trim();
  const extracted = extractBalancedJSON(rawText, idx + CTRL_MARKER.length);

  if (!extracted) {
    console.warn('[brain] Signal de controle sans JSON balance trouve.');
    return { reply, control: fallback, controlOk: false };
  }

  try {
    const control = JSON.parse(extracted.json);
    return { reply, control: { ...fallback, ...control }, controlOk: true };
  } catch (err) {
    console.warn('[brain] Signal de controle illisible :', extracted.json);
    return { reply, control: fallback, controlOk: false };
  }
}

// Parse le signal §LINK§{...} dans un texte.
// Retire le marqueur ET le JSON du texte, et retourne les criteres parses.
function parseBookingSignal(text) {
  const idx = text.indexOf(LINK_MARKER);
  if (idx === -1) return { text, bookingRequest: null };

  const extracted = extractBalancedJSON(text, idx + LINK_MARKER.length);

  if (!extracted) {
    console.warn('[brain] Signal §LINK§ mal forme (pas de JSON balance).');
    return {
      text: (text.slice(0, idx) + text.slice(idx + LINK_MARKER.length)).trim(),
      bookingRequest: null,
    };
  }

  const beforeMarker = text.slice(0, idx);
  const afterJSON = text.slice(extracted.endPos);
  const finalText = (beforeMarker + afterJSON).trim();

  try {
    const bookingRequest = JSON.parse(extracted.json);
    return { text: finalText, bookingRequest };
  } catch (err) {
    console.warn('[brain] JSON §LINK§ illisible :', extracted.json);
    return { text: finalText, bookingRequest: null };
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

  // === ORDRE DE PARSING CRITIQUE ===
  //
  // Claude emet en fin de reponse :
  //   ...texte...  §LINK§{...}  §CTRL§{...}
  //
  // On parse §CTRL§ EN PREMIER (lastIndexOf trouve le dernier marqueur)
  // pour le retirer du texte. Puis sur le texte restant, on parse §LINK§.

  // 1. Extraire et retirer §CTRL§ (s'il existe)
  const { reply: textWithoutCtrl, control, controlOk } = parseControlSignal(rawText);

  // 2. Sur le texte restant (sans §CTRL§), extraire et traiter §LINK§
  const { text: textWithoutLink, bookingRequest } = parseBookingSignal(textWithoutCtrl);
  let finalText = textWithoutLink;
  if (bookingRequest) {
    finalText = finalText + formatBookingLink(bookingRequest);
  }

  return {
    reply: finalText.trim(),
    control,
    controlOk,
  };
}
