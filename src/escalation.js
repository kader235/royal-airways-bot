// escalation.js — Gestion du transfert vers un agent humain.
// En demo : on previent l'agent par message WhatsApp (effet "transfert en direct").
// En production : remplacer / completer par Chatwoot, un groupe d'agents, un email, etc.

import { sendText } from './whatsapp.js';

const MOTIFS_LISIBLES = {
  remboursement: 'Demande de remboursement',
  bagage_perdu: 'Bagage perdu ou endommage',
  litige: 'Litige / reclamation',
  paiement: 'Probleme de paiement',
  modification: 'Modification / annulation de reservation',
  info_absente: 'Information non disponible pour le bot',
  client_mecontent: 'Client mecontent',
  mineur_ou_pmr: 'Mineur non accompagne ou assistance speciale',
};

// Declenche l'escalade : previent l'agent configure.
// clientPhone : numero du client. userMessage : son dernier message. control : signal du bot.
export async function notifyAgent(clientPhone, userMessage, control) {
  const agentNumber = process.env.AGENT_WHATSAPP_NUMBER;
  if (!agentNumber) {
    console.warn('[escalation] AGENT_WHATSAPP_NUMBER non configure, pas de notification.');
    return;
  }

  const motif = MOTIFS_LISIBLES[control.motif] || control.motif || 'Non precise';

  const notif =
    `🟠 *Nouveau transfert client*\n\n` +
    `*Motif :* ${motif}\n` +
    `*Client :* +${clientPhone}\n` +
    `*Langue :* ${control.langue || 'fr'}\n\n` +
    `*Dernier message :*\n"${userMessage}"\n\n` +
    `Merci de reprendre la conversation avec ce client.`;

  const result = await sendText(agentNumber, notif);
  if (result.ok) {
    console.log(`[escalation] Agent notifie pour le client +${clientPhone} (${motif})`);
  } else {
    console.error('[escalation] Echec de la notification agent.');
  }
}
