// server.js — Point d'entree. Webhook WhatsApp Cloud API + orchestration.

import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';

import { generateReply } from './brain.js';
import { sendText, markAsRead } from './whatsapp.js';
import { notifyAgent } from './escalation.js';
import {
  getConversation,
  addMessage,
  markHandedOver,
  stats,
} from './store.js';

const app = express();

// IMPORTANT : on capture le corps brut pour verifier la signature Meta.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const PORT = process.env.PORT || 3000;

// --- Verification de la signature Meta (securite) ---
// Meta signe chaque requete entrante avec l'App Secret. On verifie
// que la requete vient bien de Meta et n'a pas ete falsifiee.
function verifySignature(req) {
  const appSecret = process.env.WHATSAPP_APP_SECRET;
  if (!appSecret) return true; // si non configure (demo locale), on laisse passer

  const signature = req.get('x-hub-signature-256');
  if (!signature || !req.rawBody) return false;

  const expected =
    'sha256=' +
    crypto.createHmac('sha256', appSecret).update(req.rawBody).digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
  } catch {
    return false;
  }
}

// --- Route de sante (utile pour Railway) ---
app.get('/', (_req, res) => {
  res.json({ status: 'ok', service: 'royal-airways-bot', ...stats() });
});

// --- 1) Verification du webhook (GET) ---
// Meta appelle cette route une fois, a la configuration, pour valider l'URL.
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log('[webhook] Verification reussie.');
    return res.status(200).send(challenge);
  }
  console.warn('[webhook] Echec de verification (token incorrect).');
  return res.sendStatus(403);
});

// --- 2) Reception des messages (POST) ---
app.post('/webhook', async (req, res) => {
  // On repond 200 immediatement : Meta exige une reponse rapide,
  // sinon il reessaie et on recoit des doublons. Le traitement se fait apres.
  res.sendStatus(200);

  if (!verifySignature(req)) {
    console.warn('[webhook] Signature invalide, requete ignoree.');
    return;
  }

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const value = change?.value;
    const message = value?.messages?.[0];

    // Pas un message texte entrant (ex : accuse de reception) => on ignore.
    if (!message || message.type !== 'text') return;

    const from = message.from; // numero du client (format international, sans +)
    const text = message.text?.body?.trim();
    if (!text) return;

    console.log(`[webhook] Message de +${from} : "${text}"`);

    // Marque comme lu (cosmetique, rend la demo naturelle).
    if (message.id) markAsRead(message.id);

    await handleIncoming(from, text);
  } catch (err) {
    console.error('[webhook] Erreur de traitement :', err);
  }
});

// --- Logique metier ---
async function handleIncoming(from, text) {
  const convo = getConversation(from);

  // Si un agent humain a deja pris le relais, le bot se met en retrait
  // pour ne pas parler par-dessus lui. On enregistre quand meme le message.
  if (convo.handedOver) {
    addMessage(from, 'user', text);
    console.log(`[bot] +${from} est en mode humain, le bot reste silencieux.`);
    return;
  }

  // Historique AVANT le nouveau message (brain.js ajoute le message courant).
  const history = convo.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  let result;
  try {
    result = await generateReply(history, text);
  } catch (err) {
    console.error('[bot] Erreur appel Claude :', err.message);
    await sendText(
      from,
      "Désolé, je rencontre un petit souci technique 🙏 Pouvez-vous réessayer dans un instant ? Vous pouvez aussi joindre notre service client au +235 64 00 00 61."
    );
    return;
  }

  const { reply, control } = result;

  // On enregistre l'echange dans l'historique.
  addMessage(from, 'user', text);
  addMessage(from, 'assistant', reply);

  // On envoie la reponse au client.
  await sendText(from, reply);

  // Si le bot a decide d'escalader, on previent un agent et on bascule
  // la conversation en mode humain.
  if (control.escalade) {
    markHandedOver(from);
    await notifyAgent(from, text, control);
  }
}

app.listen(PORT, () => {
  console.log(`[server] Royal Airways bot a l'ecoute sur le port ${PORT}`);
});
