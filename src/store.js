// store.js — Historique des conversations EN MEMOIRE (pour la demo).
// En production, remplacer par PostgreSQL : la structure (cle = numero) est la meme.

const conversations = new Map();

// Duree de vie d'une conversation inactive avant nettoyage (en ms).
const TTL_MS = 1000 * 60 * 60 * 24; // 24h

// Nombre max de messages gardes en historique par conversation
// (on borne pour ne pas faire grossir le prompt indefiniment).
const MAX_MESSAGES = 20;

function now() {
  return Date.now();
}

// Recupere la conversation d'un numero, ou en cree une nouvelle.
export function getConversation(phone) {
  let convo = conversations.get(phone);
  if (!convo) {
    convo = {
      phone,
      messages: [], // [{ role: 'user' | 'assistant', content: '...' }]
      handedOver: false, // true => un agent humain a pris le relais
      lastActivity: now(),
      createdAt: now(),
    };
    conversations.set(phone, convo);
  }
  convo.lastActivity = now();
  return convo;
}

// Ajoute un message a l'historique et borne la taille.
export function addMessage(phone, role, content) {
  const convo = getConversation(phone);
  convo.messages.push({ role, content });
  if (convo.messages.length > MAX_MESSAGES) {
    convo.messages = convo.messages.slice(-MAX_MESSAGES);
  }
  return convo;
}

// Marque une conversation comme reprise par un humain.
// Tant que c'est vrai, le bot se met en retrait (voir server.js).
export function markHandedOver(phone) {
  const convo = getConversation(phone);
  convo.handedOver = true;
  return convo;
}

// Rend la main au bot (un agent pourrait appeler ceci via un futur endpoint).
export function releaseToBot(phone) {
  const convo = getConversation(phone);
  convo.handedOver = false;
  return convo;
}

// Nettoyage periodique des conversations inactives.
function cleanup() {
  const cutoff = now() - TTL_MS;
  for (const [phone, convo] of conversations.entries()) {
    if (convo.lastActivity < cutoff) {
      conversations.delete(phone);
    }
  }
}

setInterval(cleanup, 1000 * 60 * 30); // toutes les 30 min

// Pour le debug / monitoring leger.
export function stats() {
  return {
    activeConversations: conversations.size,
    handedOver: [...conversations.values()].filter((c) => c.handedOver).length,
  };
}
