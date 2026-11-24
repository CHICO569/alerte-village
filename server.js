require("dotenv").config();
const express = require("express"), twilio = require("twilio"), fs = require("fs"), path = require("path");
const { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOK, TWILIO_NUMBER, MY_NUMBER, BASE_URL,
        DASH_USER = "mairie", DASH_PASS = "changeme", PORT = 3000 } = process.env;
const VR = twilio.twiml.VoiceResponse;
const twilioClient = (SID && TOK) ? twilio(SID, TOK) : null;

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Villages de la Commune de Ndiédieng (Région de Kaolack, Sénégal) - Données de démonstration
const VILLAGES = [
  "Ndiédieng Centre",
  "Médina Ndiédieng",
  "Keur Mboucki",
  "Keur Baka",
  "Ndiébel",
  "Keur Socé",
  "Latmingué",
  "Thiamène",
  "Touba Ndiédieng"
];

const VILLAGE_COORDS = {
  "Ndiédieng Centre": [14.0205, -16.0315],
  "Médina Ndiédieng": [14.0350, -16.0150],
  "Keur Mboucki": [14.0520, -16.0410],
  "Keur Baka": [13.9850, -16.0620],
  "Ndiébel": [14.0810, -16.1010],
  "Keur Socé": [14.0120, -16.1230],
  "Latmingué": [14.0430, -16.1820],
  "Thiamène": [14.0610, -16.0020],
  "Touba Ndiédieng": [14.0110, -16.0210]
};

const TYPES = { 1: "Naissance", 2: "Décès", 3: "Panne de forage", 4: "Panne d’éclairage" };

const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "reports.json");
const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(RECORDINGS_DIR)) fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

// Moteur de classification automatique IA pour les signalements (urgence, type, résumé, manque)
function classifyReportAI(r) {
  let urgency = "Basse";
  let urgencyLevel = "normal"; // urgent, high, medium, normal
  let resume = "";
  let missing = [];

  if (r.type === 3) {
    urgency = "Haute";
    urgencyLevel = "urgent";
    resume = `Panne de forage à ${r.village} : risque d'arrêt immédiat de l'eau potable pour les concessions villageoises.`;
    missing = ["Type de pompe", "Nature de la panne constatée"];
  } else if (r.type === 2) {
    urgency = "Haute";
    urgencyLevel = "high";
    resume = `Décès signalé à ${r.village} : inscription au registre d'état civil dans le délai légal (sous 24h-48h).`;
    missing = ["Prénom et nom du défunt", "Âge du défunt", "Lien de parenté du déclarant"];
  } else if (r.type === 4) {
    urgency = "Moyenne";
    urgencyLevel = "medium";
    resume = `Éclairage public défaillant à ${r.village} : impacterait la visibilité nocturne sur la voie principale.`;
    missing = ["Quartier ou secteur précis", "Nombre de lampadaires éteints"];
  } else {
    urgency = "Basse";
    urgencyLevel = "normal";
    resume = `Naissance survenue à ${r.village} : pré-déclaration prête pour instruction et versement au logiciel LGEC.`;
    missing = ["Prénom du nouveau-né", "Nom complet de la mère", "Lieu précis de naissance"];
  }

  return {
    urgency,
    urgencyLevel,
    resume,
    missing,
    validatedByHuman: false,
    proposedAt: Date.now()
  };
}

let reports = [];
if (fs.existsSync(DATA_FILE)) {
  try { reports = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); }
  catch (e) { console.error("Erreur lecture reports.json:", e); reports = []; }
}

// Nettoyer/Adapter les villages pour la commune de Ndiédieng
reports.forEach((r, idx) => {
  if (!VILLAGES.includes(r.village)) {
    r.village = VILLAGES[idx % VILLAGES.length];
  }
  if (!r.ai) r.ai = classifyReportAI(r);
});

let nid = reports.reduce((max, r) => Math.max(max, r.id || 0), 0) + 1;
let clients = [];

const saveReports = () => {
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(reports, null, 2), "utf8"); }
  catch (e) { console.error("Erreur sauvegarde reports.json:", e); }
};
const push = () => clients.forEach(r => r.write("data: maj\n\n"));
const addReport = o => {
  const r = { id: nid++, t: Date.now(), st: "recu", audio: null, details: {}, ...o };
  r.ai = classifyReportAI(r);
  reports.unshift(r);
  saveReports();
  push();
  return r;
};

// Télécharge et met en cache local le fichier audio Twilio
async function cacheAudio(reportId, twilioUrl) {
  if (!twilioUrl) return;
  const filePath = path.join(RECORDINGS_DIR, `${reportId}.mp3`);
  try {
    const f = await fetch(twilioUrl + ".mp3", {
      headers: { Authorization: "Basic " + Buffer.from(SID + ":" + TOK).toString("base64") }
    });
    if (f.ok) {
      const buffer = Buffer.from(await f.arrayBuffer());
      fs.writeFileSync(filePath, buffer);
      console.log(`[AUDIO CACHE] Fichier audio #${reportId} mis en cache locale (${buffer.length} octets)`);
    }
  } catch (err) {
    console.error(`[AUDIO CACHE ERREUR] #${reportId}:`, err.message);
  }
}

// Mise en cache au démarrage
reports.forEach(r => {
  if (r.audio && !fs.existsSync(path.join(RECORDINGS_DIR, `${r.id}.mp3`))) {
    cacheAudio(r.id, r.audio);
  }
});

// Envoi automatique d'un SMS de suivi citoyen après appel/signalement
async function sendFollowupSMS(r) {
  if (!twilioClient || !TWILIO_NUMBER || !r.from) return;
  let text = "";
  if (r.type === 1) {
    text = `Mairie de Ndiédieng: Félicitations pour la naissance à ${r.village} (Dossier N°${r.id}). La pré-déclaration a été enregistrée. L'officier d'état civil prendra contact pour l'acte définitif.`;
  } else if (r.type === 2) {
    text = `Mairie de Ndiédieng: Toutes nos condoléances pour le décès survenu à ${r.village} (Dossier N°${r.id}). Le dossier est ouvert pour inscription au registre communal.`;
  } else if (r.type === 3) {
    text = `Mairie de Ndiédieng: Signalement de Panne de forage à ${r.village} (N°${r.id}) bien reçu. Les services techniques sont alertés.`;
  } else {
    text = `Mairie de Ndiédieng: Signalement d'éclairage à ${r.village} (N°${r.id}) enregistré. Les services municipaux s'en occupent.`;
  }
  try {
    const res = await twilioClient.messages.create({ to: r.from, from: TWILIO_NUMBER, body: text });
    console.log(`[SMS SUIVI] Envoyé à ${r.from} (SID: ${res.sid})`);
  } catch (err) {
    console.error(`[SMS SUIVI ERREUR]:`, err.message);
  }
}

function say(node, key, fr) {
  if (fs.existsSync(path.join(__dirname, "public/audio", key + ".mp3"))) {
    node.play(BASE_URL + "/audio/" + key + ".mp3");
  } else {
    node.say({ language: "fr-FR" }, fr);
  }
}
const xml = (res, vr) => res.type("text/xml").send(vr.toString());

/* ---------- Webhooks Twilio ---------- */
app.use("/audio", express.static(path.join(__dirname, "public/audio")));
const hook = twilio.webhook({ validate: !!TOK && process.env.SKIP_SIGNATURE !== "1", protocol: "https" });

app.post("/voice", hook, (req, res) => {
  const vr = new VR();
  const g = vr.gather({ numDigits: 1, action: "/voice/type", timeout: 6 });
  say(g, "menu", "Bienvenue. Tapez 1 pour une naissance, 2 pour un décès, 3 pour une panne de forage, 4 pour une panne d’éclairage.");
  vr.redirect("/voice");
  xml(res, vr);
});

app.post("/voice/type", hook, (req, res) => {
  const d = req.body.Digits || req.query.Digits, vr = new VR();
  if (!TYPES[d]) { vr.redirect("/voice"); return xml(res, vr); }
  const g = vr.gather({ numDigits: 1, action: "/voice/village?type=" + d, timeout: 6 });
  say(g, "village", "Tapez le numéro de votre village : " + VILLAGES.map((v, i) => (i + 1) + " " + v).join(", ") + ".");
  vr.redirect("/voice/type?Digits=" + d);
  xml(res, vr);
});

app.post("/voice/village", hook, (req, res) => {
  const type = +req.query.type, v = +req.body.Digits - 1, vr = new VR();
  if (!VILLAGES[v]) { vr.redirect("/voice/type?Digits=" + type); return xml(res, vr); }
  const r = addReport({ type, village: VILLAGES[v], canal: "Appel", from: req.body.From });
  say(vr, "parle", "Après le bip, dites votre message, puis raccrochez ou appuyez sur dièse.");
  vr.record({
    maxLength: 45, playBeep: true, finishOnKey: "#",
    action: "/voice/fin", recordingStatusCallback: "/voice/rec?id=" + r.id, recordingStatusCallbackEvent: "completed"
  });
  xml(res, vr);
});

app.post("/voice/fin", hook, (req, res) => {
  const vr = new VR();
  say(vr, "merci", "Merci. Votre signalement est envoyé à la Mairie.");
  vr.hangup();
  xml(res, vr);
});

app.post("/voice/rec", hook, async (req, res) => {
  const r = reports.find(x => x.id == req.query.id);
  if (r) {
    r.audio = req.body.RecordingUrl;
    saveReports();
    push();
    cacheAudio(r.id, r.audio);
    sendFollowupSMS(r);
  }
  res.sendStatus(200);
});

/* ---------- Entrée SMS ---------- */
const norm = x => x.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
app.post("/sms", hook, (req, res) => {
  const txt = (req.body.Body || "").trim(), vr = new VR();
  const [t, ...rest] = txt.split(/\s+/), vtxt = rest.join(" ");
  let vi = /^\d+$/.test(vtxt) ? +vtxt - 1 : VILLAGES.findIndex(v => norm(v) === norm(vtxt));
  if (!TYPES[t] || !VILLAGES[vi]) {
    vr.message("Format : TYPE VILLAGE. Ex: 3 Ndiédieng. Types: 1 Naissance, 2 Décès, 3 Panne forage, 4 Panne éclairage.");
  } else {
    const r = addReport({ type: +t, village: VILLAGES[vi], canal: "SMS", from: req.body.From, texte: txt });
    vr.message(`Mairie de Ndiédieng: Votre signalement (${TYPES[t]} à ${VILLAGES[vi]}, N°${r.id}) est bien reçu.`);
  }
  xml(res, vr);
});

/* ---------- Audio sans authentification (pour lecteur HTML5) ---------- */
app.get("/api/audio/:id", async (req, res) => {
  const r = reports.find(x => x.id == req.params.id);
  if (!r) return res.sendStatus(404);
  const localFile = path.join(RECORDINGS_DIR, `${r.id}.mp3`);
  if (!fs.existsSync(localFile) && r.audio) {
    await cacheAudio(r.id, r.audio);
  }
  if (fs.existsSync(localFile)) {
    return res.sendFile(localFile);
  }
  res.sendStatus(404);
});

/* ---------- Tableau de bord (protégé par mot de passe) ---------- */
app.use((req, res, next) => {
  const [u, p] = Buffer.from((req.headers.authorization || "").split(" ")[1] || "", "base64").toString().split(":");
  if (u === DASH_USER && p === DASH_PASS) return next();
  res.set("WWW-Authenticate", 'Basic realm="Mairie"').status(401).send("Accès réservé à la Mairie");
});
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/villages", (req, res) => {
  res.json({ villages: VILLAGES, coords: VILLAGE_COORDS, types: TYPES });
});
app.get("/api/reports", (req, res) => res.json(reports));
app.get("/api/stream", (req, res) => {
  res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }).flushHeaders();
  clients.push(res);
  req.on("close", () => (clients = clients.filter(c => c !== res)));
});

// Statut
app.post("/api/reports/:id/status", (req, res) => {
  const r = reports.find(x => x.id == req.params.id);
  if (!r) return res.sendStatus(404);
  r.st = req.body.st;
  r.rp = r.rp ?? Date.now() - r.t;
  saveReports();
  push();
  res.json(r);
});

// Validation ou correction de la proposition de l'IA par un agent
app.post("/api/reports/:id/ai-validate", (req, res) => {
  const r = reports.find(x => x.id == req.params.id);
  if (!r) return res.sendStatus(404);
  const { action, correctedType, correctedUrgency } = req.body;
  if (action === "validate") {
    r.ai.validatedByHuman = true;
    r.ai.validationDate = Date.now();
  } else if (action === "correct") {
    if (correctedType) r.type = +correctedType;
    if (correctedUrgency) r.ai.urgency = correctedUrgency;
    r.ai.validatedByHuman = true;
    r.ai.correctedByHuman = true;
  }
  saveReports();
  push();
  res.json(r);
});

// Détails / Saisie manuelle de la pré-déclaration
app.post("/api/reports/:id/details", (req, res) => {
  const r = reports.find(x => x.id == req.params.id);
  if (!r) return res.sendStatus(404);
  r.details = { ...(r.details || {}), ...req.body };
  saveReports();
  push();
  res.json(r);
});

// Saisie de texte de secours si wolof à retranscrire par l'agent
app.post("/api/reports/:id/transcript", (req, res) => {
  const r = reports.find(x => x.id == req.params.id);
  if (!r) return res.sendStatus(404);
  r.texte = req.body.texte || r.texte;
  saveReports();
  push();
  res.json(r);
});

app.post("/api/reports/simulate", (req, res) => {
  const { type = 1, village = "Ndiédieng Centre", canal = "Appel", from = "+221 77 *** ** 79", texte = "" } = req.body;
  const r = addReport({ type: +type, village, canal, from, texte });
  res.json(r);
});

app.post("/api/call", async (req, res) => {
  try {
    await twilio(SID, TOK).calls.create({ to: MY_NUMBER, from: TWILIO_NUMBER, url: BASE_URL + "/voice" });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ erreur: e.message });
  }
});

/* ---------- ASSISTANT DU MAIRE (Règle stricte : jamais de chiffre inventé) ---------- */
app.post("/api/ai/ask", (req, res) => {
  const q = (req.body.question || "").toLowerCase().trim();
  const unresolved = reports.filter(r => r.st !== 'resolu');
  const forages = reports.filter(r => r.type === 3 && r.st !== 'resolu');
  const naissances = reports.filter(r => r.type === 1);
  const deces = reports.filter(r => r.type === 2);
  const eclairages = reports.filter(r => r.type === 4 && r.st !== 'resolu');

  let answer = "";
  let sourceFiche = "Base des signalements municipaux en temps réel";

  if (q.includes("eau") || q.includes("forage") || q.includes("puits")) {
    if (forages.length === 0) {
      answer = "Monsieur le Maire, d'après les dossiers enregistrés sur la commune de Ndiédieng, aucune panne de forage non résolue n'est signalée. Tous les points d'eau répertoriés sont actuellement en état de marche.";
      sourceFiche = "Fiche Registre Hydraulique Villageoise (Ndiédieng)";
    } else {
      const vList = forages.map(r => r.village).join(", ");
      answer = `Monsieur le Maire, d'après les signalements enregistrés, ${forages.length} village(s) n'ont actuellement plus d'eau à cause d'une panne de forage : ${vList}.\n\nRecommandation : Une intervention prioritaire de la régie hydraulique est préconisée.`;
      sourceFiche = `Fiche d'incident hydraulique N°${forages[0].id} (${forages[0].village})`;
    }
  } else if (q.includes("naissance") || q.includes("bébé") || q.includes("enfant")) {
    answer = `Monsieur le Maire, ${naissances.length} pré-déclaration(s) de naissance sont enregistrées dans la base. Elles sont prêtes pour vérification par l'officier d'état civil avant versement au logiciel LGEC.`;
    sourceFiche = "Registre Pré-déclarations Naissances (LGEC Ndiédieng)";
  } else if (q.includes("décès") || q.includes("mort") || q.includes("deces")) {
    answer = `Monsieur le Maire, ${deces.length} déclaration(s) de décès ont été reçues. Conformément aux règles d'état civil, aucune cause médicale n'est enregistrée. Les fiches préparatoires attendent la vérification légale de votre officier d'état civil.`;
    sourceFiche = "Registre Pré-déclarations Décès (LGEC Ndiédieng)";
  } else if (q.includes("résumé") || q.includes("conseil") || q.includes("situation") || q.includes("bilan")) {
    answer = `Synthèse exécutive pour Monsieur le Maire (Commune de Ndiédieng) :
• Dossiers actifs : ${unresolved.length} signalement(s) en attente d'intervention.
• État Civil : ${naissances.length} naissance(s) et ${deces.length} décès recensés en pré-déclaration.
• Infrastructures : ${forages.length} forage(s) en arrêt et ${eclairages.length} panne(s) d'éclairage.
Règle : Seul l'officier d'état civil certifie les actes. Les données restent confidentielles à la Mairie.`;
    sourceFiche = "Tableau de Bord Intégré Communal (Ndiédieng)";
  } else if (q.includes("village") || q.includes("touché") || q.includes("urgent")) {
    const counts = {};
    unresolved.forEach(r => { counts[r.village] = (counts[r.village] || 0) + 1; });
    const sorted = Object.entries(counts).sort((a,b) => b[1] - a[1]);
    if (sorted.length === 0) {
      answer = "Tous les villages de la commune de Ndiédieng sont actuellement dans une situation normale sans alerte active.";
      sourceFiche = "Synthèse cartographique territoriale";
    } else {
      const top = sorted.map(([v, c]) => `${v} (${c} alerte${c > 1 ? 's' : ''})`).join(", ");
      answer = `Les villages nécessitant une intervention prioritaire sont : ${top}. Ces sites sont marqués d'un point rouge clignotant sur votre cartographie municipale.`;
      sourceFiche = "Matrice de priorité territoriale (Ndiédieng)";
    }
  } else {
    // Règle d'or : ne rien inventer, répondre honnêtement si pas dans les fiches
    answer = `Monsieur le Maire, cette information précise ne figure pas dans les signalements actuellement enregistrés sur le serveur. Je ne peux pas inventer de données non certifiées. Vous pouvez consulter les fiches hydrauliques ou le registre des pré-déclarations d'état civil.`;
    sourceFiche = "Index général des fiches municipales";
  }

  res.json({ answer, sourceFiche, timestamp: Date.now() });
});

app.listen(PORT, () => console.log("Serveur prêt : http://localhost:" + PORT));
