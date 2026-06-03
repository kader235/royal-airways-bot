// brain.js — Le "cerveau" du bot.
// Charge le system prompt + base de connaissances, injecte date, annonces,
// lignes, tarifs et bagages en temps reel, puis appelle l'API Claude.

import {
  getActiveAnnouncementsForPrompt,
  getRoutesForPrompt,
  getFaresForPrompt,
  getKnowledgeForPrompt,
} from './announcementsFetcher.js';
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

export async function generateReply(history, userMessage) {
  const messages = [...history, { role: 'user', content: userMessage }];
  const systemPrompt = await buildDatedSystemPrompt();

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: systemPrompt,
    messages,
  });

  const rawText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return parseControlSignal(rawText);
}
