// brain.js — Le "cerveau" du bot.
// Responsabilites : charger le system prompt + la base de connaissances,
// injecter la date du jour ET les annonces actives, appeler l'API Claude,
// et separer la reponse client du signal de controle §CTRL§.
import { getActiveAnnouncementsForPrompt } from './announcementsFetcher.js';
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
    console.warn(
      '[brain] Attention : marqueur {{BASE_DE_CONNAISSANCES}} introuvable dans system_prompt.md'
    );
  }
  return systemTemplate.replace('{{BASE_DE_CONNAISSANCES}}', knowledge);
}

const SYSTEM_TEMPLATE = buildSystemTemplate();

// --- Date du jour au fuseau du Tchad (UTC+1, pas d'heure d'ete) ---
const JOURS = [
  'dimanche', 'lundi', 'mardi', 'mercredi',
  'jeudi', 'vendredi', 'samedi',
];
const MOIS = [
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
];

function dateTchad(offsetJours = 0) {
  const maintenant = new Date();
  const tchad = new Date(
    maintenant.getTime() + (1 * 60 * 60 * 1000) + (offsetJours * 24 * 60 * 60 * 1000)
  );
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
  for (let i = 0; i < 7; i++) {
    prochains.push('- ' + dateTchad(i).texte);
  }
  return [
    "Nous sommes aujourd'hui : " + aujourdhui.texte + ' (heure du Tchad).',
    'Demain sera : ' + demain.texte + '.',
    'Les 7 prochains jours :',
    prochains.join('\n'),
  ].join('\n');
}

// --- Construction du system prompt avec date ET annonces actives ---
// Note: cette fonction est devenue async car elle interroge l'API admin
// pour recuperer les annonces. Le fetcher a un cache de 1 minute donc
// l'impact perf est minimal (1 appel HTTP par minute au pire).
async function buildDatedSystemPrompt() {
  const dateBlock = buildDateBlock();

  // Recuperer les annonces actives depuis l'admin (avec cache integre)
  let annoncesBlock = 'Aucune annonce particuliere en ce moment.';
  try {
    annoncesBlock = await getActiveAnnouncementsForPrompt();
  } catch (err) {
    console.error('[brain] Echec recuperation annonces, on continue sans :', err.message);
  }

  // Injection des deux blocs dans le template
  let prompt = SYSTEM_TEMPLATE;

  if (prompt.includes('{{DATE_DU_JOUR}}')) {
    prompt = prompt.replace('{{DATE_DU_JOUR}}', dateBlock);
  } else {
    prompt = dateBlock + '\n\n' + prompt;
  }

  if (prompt.includes('{{ANNONCES_ACTIVES}}')) {
    prompt = prompt.replace('{{ANNONCES_ACTIVES}}', annoncesBlock);
  } else {
    // Si le marqueur n'est pas (encore) dans system_prompt.md, on l'ajoute en tete
    // pour que le bot tienne quand meme compte des annonces.
    prompt = annoncesBlock + '\n\n' + prompt;
    console.warn('[brain] Marqueur {{ANNONCES_ACTIVES}} absent du system_prompt.md, ajout en tete.');
  }

  return prompt;
}

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-7';

// --- Parsing du signal de controle ---
const CTRL_MARKER = '§CTRL§';

function parseControlSignal(rawText) {
  const idx = rawText.lastIndexOf(CTRL_MARKER);

  const fallback = {
    escalade: false,
    motif: null,
    langue: 'fr',
    intention: 'autre',
  };

  if (idx === -1) {
    return { reply: rawText.trim(), control: fallback, controlOk: false };
  }

  const reply = rawText.slice(0, idx).trim();
  const jsonPart = rawText.slice(idx + CTRL_MARKER.length).trim();

  try {
    const control = JSON.parse(jsonPart);
    return {
      reply,
      control: { ...fallback, ...control },
      controlOk: true,
    };
  } catch (err) {
    console.warn('[brain] Signal de controle illisible :', jsonPart);
    return { reply, control: fallback, controlOk: false };
  }
}

// --- Appel principal ---
export async function generateReply(history, userMessage) {
  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  // Build du system prompt (maintenant async car il interroge l'admin)
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