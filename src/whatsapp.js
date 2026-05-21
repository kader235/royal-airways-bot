// whatsapp.js — Adaptateur d'envoi vers la WhatsApp Cloud API (Meta).
// Un seul role : envoyer un message texte a un numero. La reception
// se fait via le webhook dans server.js.

const GRAPH_VERSION = process.env.GRAPH_API_VERSION || 'v21.0';

function endpoint() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  return `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`;
}

// Envoie un message texte simple a un destinataire (numero au format international, sans +).
export async function sendText(to, body) {
  const token = process.env.WHATSAPP_TOKEN;

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { preview_url: false, body },
  };

  try {
    const res = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`[whatsapp] Echec envoi a ${to} (${res.status}) :`, errText);
      return { ok: false, status: res.status, error: errText };
    }

    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    console.error('[whatsapp] Exception lors de l\'envoi :', err.message);
    return { ok: false, error: err.message };
  }
}

// Marque un message entrant comme "lu" (les deux coches bleues).
// Optionnel mais ca rend la demo plus naturelle.
export async function markAsRead(messageId) {
  const token = process.env.WHATSAPP_TOKEN;
  try {
    await fetch(endpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch (err) {
    // Non bloquant : si le marquage echoue, on continue.
    console.warn('[whatsapp] Marquage lu echoue :', err.message);
  }
}
