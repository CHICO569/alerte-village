// Test n°1 : Twilio t'appelle et joue le menu. Lance : npm run call
require("dotenv").config();
const required = ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_NUMBER", "MY_NUMBER", "BASE_URL"];
const missing = required.filter(name => !process.env[name] || !process.env[name].trim());
if (missing.length) {
  console.error("Configuration d'appel incomplète :", missing.join(", "));
  process.exitCode = 1;
} else {
  const c = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  c.calls.create({ to: process.env.MY_NUMBER, from: process.env.TWILIO_NUMBER, url: process.env.BASE_URL + "/voice" })
    .then(x => console.log("Appel lancé :", x.sid))
    .catch(e => console.error("Erreur :", e.message));
}
