// brain.js — Le "cerveau" du bot.
// Responsabilites : charger le system prompt + la base de connaissances,
// appeler l'API Claude, et separer la reponse client du signal de controle §CTRL§.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, '..', 'knowledge');

// --- Chargement du prompt au demarrage ---
// On lit les deux fichiers une seule fois et on injecte la base
// a l'emplacement du marqueur {{BASE_DE_CONNAISSANCES}}.
function buildSystemPrompt() {
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

const SYSTEM_PROMPT = buildSystemPrompt();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-4-7';

// --- Parsing du signal de controle ---
// Le bot termine chaque reponse par une ligne : §CTRL§{...json...}
// On separe le texte (a envoyer au client) du JSON (lu par le backend).
const CTRL_MARKER = '§CTRL§';

function parseControlSignal(rawText) {
  const idx = rawText.lastIndexOf(CTRL_MARKER);

  // Valeur par defaut si le signal manque ou est illisible :
  // on n'escalade pas, mais on le note pour le monitoring.
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
// history : tableau [{ role, content }] des messages precedents (sans le nouveau).
// userMessage : le nouveau message du client.
// Retourne { reply, control, controlOk }.
export async function generateReply(history, userMessage) {
  const messages = [
    ...history,
    { role: 'user', content: userMessage },
  ];

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  });

  // On concatene les blocs texte de la reponse.
  const rawText = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  return parseControlSignal(rawText);
}
