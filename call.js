// Test n°1 : Twilio t'appelle et joue le menu. Lance : npm run call
require("dotenv").config();
const c = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
c.calls.create({ to: process.env.MY_NUMBER, from: process.env.TWILIO_NUMBER, url: process.env.BASE_URL + "/voice" })
  .then(x => console.log("Appel lancé :", x.sid)).catch(e => console.error("Erreur :", e.message));
