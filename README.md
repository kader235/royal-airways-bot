# Bot WhatsApp — Royal Airways

Assistant WhatsApp officiel de Royal Airways : répond aux clients 24h/24 avec un ton chaleureux et fiable, et **transfère vers un agent humain** quand la demande est sensible (remboursement, litige, bagage perdu, etc.).

Le bot ne répond **qu'avec les informations réelles** de Royal Airways (jamais de prix ou d'horaire inventé) : c'est sa garantie de fiabilité.

---

## 1. Comment ça marche (vue d'ensemble)

```
Client WhatsApp
      │
      ▼
WhatsApp Cloud API (Meta)
      │  (webhook HTTPS)
      ▼
Serveur Node/Express  ──►  Claude (cerveau + base de connaissances)
      │
      ├─► Réponse renvoyée au client
      │
      └─► Si escalade : notification à un agent humain
```

Le bot termine chaque réponse par un signal de contrôle interne (`§CTRL§{...}`) que le serveur lit pour décider d'escalader, puis **retire** avant d'envoyer le message au client. Ce signal n'est jamais visible par l'utilisateur.

---

## 2. Structure du projet

```
royal-airways-bot/
├── knowledge/
│   ├── system_prompt.md       ← comportement du bot (stable)
│   └── base_connaissances.md  ← faits Royal Airways (à mettre à jour souvent)
├── src/
│   ├── server.js        ← webhook WhatsApp + orchestration
│   ├── brain.js         ← appel Claude + parsing du signal §CTRL§
│   ├── whatsapp.js      ← envoi de messages via la Cloud API
│   ├── escalation.js    ← notification agent humain
│   └── store.js         ← historique des conversations (en mémoire)
├── .env.example         ← modèle de configuration (à copier en .env)
├── package.json
└── README.md
```

**Pour mettre à jour les infos du bot** (tarifs, horaires, nouvelle ligne…), éditez `knowledge/base_connaissances.md` puis redéployez. Aucune autre modification n'est nécessaire.

---

## 3. Prérequis à réunir AVANT de commencer

### Côté Meta / WhatsApp
1. Un **compte Facebook**.
2. Un compte **Meta for Developers** (developers.facebook.com).
3. Un **Meta Business Portfolio** (business.facebook.com).
4. Une **app Meta** de type *Business* avec le **produit WhatsApp** ajouté.
5. Un **numéro de téléphone dédié** (capable de recevoir SMS/appel, **pas déjà utilisé sur WhatsApp**).
6. La **vérification d'entreprise** : pas nécessaire pour la démo, mais à lancer en parallèle pour la production (2 à 10 jours).

### Côté IA
7. Une **clé API Anthropic** (console.anthropic.com) avec un peu de crédit.

### Côté infrastructure
8. **Node.js 18+** et **npm**.
9. Un compte **Railway** (railway.app) et un compte **GitHub** pour le déploiement.

---

## 4. Configuration Meta pas à pas

### 4.1 Créer l'app et activer WhatsApp
1. Sur developers.facebook.com → **Mes apps** → **Créer une app** → type **Business**.
2. Dans l'app, ajoutez le produit **WhatsApp** → **Configurer**.
3. Meta crée automatiquement un **numéro de test** et un **WhatsApp Business Account** de test. Vous pouvez l'utiliser pour un tout premier essai (max 5 destinataires), mais pour 5–10 testeurs, enregistrez votre **vrai numéro** (voir 4.4).

### 4.2 Récupérer les identifiants
Dans **WhatsApp → Configuration de l'API**, notez :
- **Phone Number ID** → `WHATSAPP_PHONE_NUMBER_ID`
- **WhatsApp Business Account ID** → `WHATSAPP_BUSINESS_ACCOUNT_ID`

Dans **Paramètres de l'app → Général** :
- **Clé secrète** (App Secret) → `WHATSAPP_APP_SECRET`

### 4.3 Générer un token PERMANENT (important)
Le token affiché par défaut **expire en 24h**. Pour un token permanent :
1. Allez sur business.facebook.com → **Paramètres** → **Utilisateurs** → **Utilisateurs système**.
2. Créez un *utilisateur système* (rôle Admin).
3. **Générer un nouveau token** → sélectionnez votre app → cochez les permissions `whatsapp_business_messaging` et `whatsapp_business_management`.
4. Copiez le token → `WHATSAPP_TOKEN`. **Ce token ne s'affiche qu'une fois**, conservez-le.

### 4.4 Enregistrer le vrai numéro
Dans **WhatsApp → Configuration de l'API → Ajouter un numéro** : suivez les étapes (Meta envoie un code par SMS/appel). Une fois validé, le **Phone Number ID** de ce numéro remplace celui du numéro de test.

### 4.5 Inventer le Verify Token
Choisissez une chaîne secrète quelconque (ex. `royal-airways-2026-xyz`). Mettez-la dans `WHATSAPP_VERIFY_TOKEN`. Vous la ressaisirez à l'identique côté Meta (étape 6.3).

---

## 5. Configuration locale et test rapide

```bash
# 1. Installer les dépendances
npm install

# 2. Créer le fichier de configuration
cp .env.example .env
# puis ouvrez .env et remplissez les 7 valeurs

# 3. Lancer en local
npm run dev
```

Le serveur démarre sur le port 3000. La route `GET /` doit répondre `{"status":"ok",...}`.

> En local, Meta ne peut pas atteindre votre machine directement. Pour un test local complet, utilisez un tunnel (ngrok). Mais pour une démo qui tourne en continu, déployez sur Railway (section 6).

---

## 6. Déploiement sur Railway (recommandé pour la démo)

### 6.1 Mettre le code sur GitHub
```bash
git init
git add .
git commit -m "Bot WhatsApp Royal Airways - version demo"
# créez un dépôt sur github.com puis :
git remote add origin <url-de-votre-depot>
git push -u origin main
```

### 6.2 Déployer
1. Sur railway.app → **New Project** → **Deploy from GitHub repo** → choisissez le dépôt.
2. Railway détecte Node.js et lance `npm start` automatiquement.
3. Dans l'onglet **Variables**, ajoutez **toutes** les variables du `.env` (sauf `PORT`, géré par Railway).
4. Dans **Settings → Networking → Generate Domain** : Railway vous donne une URL HTTPS publique stable, par exemple `https://royal-airways-bot-production.up.railway.app`.

### 6.3 Connecter le webhook à Meta
1. Dans l'app Meta → **WhatsApp → Configuration** → section **Webhook** → **Modifier**.
2. **URL de rappel** : votre URL Railway suivie de `/webhook`
   → `https://votre-app.up.railway.app/webhook`
3. **Jeton de vérification** : la valeur exacte de `WHATSAPP_VERIFY_TOKEN`.
4. **Vérifier et enregistrer** : Meta appelle votre serveur ; si tout est bon, la coche verte apparaît.
5. Dans **Champs du webhook**, abonnez-vous à **messages**.

---

## 7. Tester de bout en bout

1. Ajoutez les numéros de vos testeurs (si numéro de test) ou assurez-vous que le numéro est actif (vrai numéro).
2. Depuis un téléphone testeur, envoyez « Bonjour » au numéro WhatsApp du bot.
3. Le bot doit répondre chaleureusement en quelques secondes.

**Scénarios de démo à montrer au client :**
- « Je peux prendre combien de bagages ? » → réponse précise (15 kg / 30 kg / 5 kg cabine).
- « Quels documents pour aller à Douala ? » → passeport + visa + fièvre jaune.
- « C'est combien le billet pour Abéché ? » → le bot **ne donne pas de prix** et redirige (preuve d'anti-hallucination).
- « Je veux un remboursement, mon vol a été annulé. » → le bot rassure **et l'agent reçoit une notification WhatsApp en direct** (effet « transfert »).

> Pour la démo, mettez **votre propre numéro** dans `AGENT_WHATSAPP_NUMBER` : vous verrez le transfert arriver en direct sur votre téléphone pendant que le client voit « un conseiller va vous reprendre ».

---

## 8. Coûts

- **WhatsApp** : les réponses du bot dans la fenêtre de 24h (toujours initiée par le client) sont **gratuites**. Coût quasi nul pour ce type de bot réactif.
- **Claude** : facturé à l'usage selon le volume de messages. C'est le seul coût récurrent réel, et il reste modéré.
- **Railway** : offre un palier gratuit / peu coûteux suffisant pour une démo.

---

## 9. Limites de la version démo (et suite)

- L'historique est **en mémoire** : il est perdu si le serveur redémarre. En production → PostgreSQL (même structure, clé = numéro).
- L'escalade notifie **un seul agent**. En production → groupe d'agents, ou outil dédié (Chatwoot) avec boîte de réception partagée.
- Le bot **ne réserve pas** et ne traite **aucun paiement** (par conception) : il informe et oriente.
- Tant que la **vérification d'entreprise** n'est pas faite, le volume est plafonné (~250 conversations/24h) — large pour une démo, à lever pour le grand public.

---

## 10. Dépannage rapide

| Symptôme | Cause probable |
|---|---|
| Webhook refusé à la config Meta | `WHATSAPP_VERIFY_TOKEN` différent entre `.env` et Meta |
| Le bot ne répond pas | Token expiré (utilisez un token **permanent**, section 4.3) |
| « Signature invalide » dans les logs | `WHATSAPP_APP_SECRET` incorrect |
| Le bot répond mais l'agent n'est pas notifié | `AGENT_WHATSAPP_NUMBER` vide ou mauvais format (international, sans +) |
| Erreur Claude dans les logs | `ANTHROPIC_API_KEY` invalide ou crédit épuisé |
| Réponses lentes | Normal au premier message (démarrage à froid Railway) |
