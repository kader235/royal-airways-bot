// bookingLink.js — Generateur de deep link pour le moteur de reservation Royal Airways.
//
// Le moteur officiel booking.flyroyalairways.com accepte des deep links au format :
//   https://booking.flyroyalairways.com/flight-results/{FROM}-{TO}/{YYYY-MM-DD}/NA/{ADULTS}/{CHILDREN}/{INFANTS}
//
// Exemple :
//   https://booking.flyroyalairways.com/flight-results/NDJ-AEH/2026-06-15/NA/2/0/0
//
// Ce module convertit des noms de villes en codes IATA et construit l'URL finale.
// Le bot envoie cette URL au client, qui clique et arrive directement sur la page
// de paiement Royal Airways avec son vol pre-rempli.

// Mapping ville (variantes francaises courantes) -> code IATA.
// Toutes les cles sont en minuscules, sans accents, sans apostrophes.
const CITY_TO_IATA = {
  // N'Djamena
  "ndjamena": "NDJ",
  "n djamena": "NDJ",
  "njamena": "NDJ",
  "ndj": "NDJ",

  // Abeche
  "abeche": "AEH",
  "aeh": "AEH",

  // Amdjarass
  "amdjarass": "AMC",
  "amdjaras": "AMC",
  "amjarass": "AMC",
  "amc": "AMC",

  // Douala (international, Cameroun)
  "douala": "DLA",
  "dla": "DLA",

  // Lignes en reouverture
  "moundou": "MQQ",
  "mqq": "MQQ",
  "sarh": "SRH",
  "srh": "SRH",
  "faya": "FYT",
  "faya-largeau": "FYT",
  "faya largeau": "FYT",
  "fyt": "FYT",
  "am-timan": "AMT",
  "am timan": "AMT",
  "amtiman": "AMT",
  "amt": "AMT",
  "goz-beida": "GZB",
  "goz beida": "GZB",
  "gozbeida": "GZB",
  "gzb": "GZB",
};

// Convertit un nom de ville (libre) en code IATA, ou null si inconnu.
export function cityToIATA(city) {
  if (!city || typeof city !== 'string') return null;
  const normalized = city
    .toLowerCase()
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/\s+/g, ' ');
  return CITY_TO_IATA[normalized] || null;
}

// Verifie et normalise une date. Accepte YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY.
// Retourne YYYY-MM-DD ou null.
export function normalizeDate(dateStr) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const trimmed = dateStr.trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return trimmed;
    return null;
  }

  const match = trimmed.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (match) {
    const [, day, month, year] = match;
    const iso = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return iso;
  }
  return null;
}

// Construit l'URL de reservation Royal Airways a partir des criteres.
// Retourne { success, url?, summary?, error? }.
export function buildBookingURL({ from, to, date, adults = 1, children = 0, infants = 0 }) {
  const fromCode = cityToIATA(from) || (typeof from === 'string' ? from.toUpperCase() : null);
  const toCode = cityToIATA(to) || (typeof to === 'string' ? to.toUpperCase() : null);

  if (!fromCode || fromCode.length !== 3) {
    return {
      success: false,
      error: `Origine non reconnue : "${from}". Villes acceptees : N'Djamena, Abeche, Amdjarass, Douala.`,
    };
  }
  if (!toCode || toCode.length !== 3) {
    return {
      success: false,
      error: `Destination non reconnue : "${to}". Villes acceptees : N'Djamena, Abeche, Amdjarass, Douala.`,
    };
  }
  if (fromCode === toCode) {
    return {
      success: false,
      error: `L'origine et la destination doivent etre differentes (${fromCode}).`,
    };
  }

  const isoDate = normalizeDate(date);
  if (!isoDate) {
    return {
      success: false,
      error: `Date invalide : "${date}". Format attendu : JJ/MM/AAAA ou AAAA-MM-JJ.`,
    };
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const departDate = new Date(isoDate);
  if (departDate < today) {
    return {
      success: false,
      error: `La date ${isoDate} est dans le passe. Choisissez une date future.`,
    };
  }

  const a = parseInt(adults, 10);
  const c = parseInt(children, 10) || 0;
  const i = parseInt(infants, 10) || 0;

  if (isNaN(a) || a < 1) {
    return { success: false, error: `Au moins 1 adulte est requis.` };
  }
  if (a > 9 || c > 9 || i > 9) {
    return {
      success: false,
      error: `Trop de passagers (max 9 par categorie). Pour les groupes : +235 64 00 00 61.`,
    };
  }
  if (i > a) {
    return {
      success: false,
      error: `Le nombre de bebes (${i}) ne peut depasser le nombre d'adultes (${a}). Chaque bebe doit etre accompagne.`,
    };
  }

  const url = `https://booking.flyroyalairways.com/flight-results/${fromCode}-${toCode}/${isoDate}/NA/${a}/${c}/${i}`;

  return {
    success: true,
    url,
    summary: {
      from: fromCode,
      to: toCode,
      date: isoDate,
      adults: a,
      children: c,
      infants: i,
      totalPassengers: a + c + i,
    },
  };
}
