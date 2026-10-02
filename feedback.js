// Thumbs up/down feedback. Only runs when the user clicks Send in the feedback dialog,
// which shows them exactly what will be shared first.
const fs = require("fs");
const path = require("path");

// Same Firebase project as treesim. The web API key is public by design; the Firestore rules only
// allow *creating* documents in this one collection, never reading them from the app.
const PROJECT = "treesim-a59eb";
const API_KEY = "AIzaSyARDvBCkSMRQhR8MSxTrs7-YxpPBXpVkBs";
const COLLECTION = "treelens_feedback";
const URL = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${COLLECTION}?key=${API_KEY}`;

function toValue(v) {
    if (typeof v === "string") return { stringValue: v };
    if (typeof v === "number") return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (typeof v === "boolean") return { booleanValue: v };
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
    return { stringValue: JSON.stringify(v) };
}

async function post(entry) {
    const fields = Object.fromEntries(Object.entries(entry).map(([k, v]) => [k, toValue(v)]));
    const res = await fetch(URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fields }),
        signal: AbortSignal.timeout(15000)
    });
    if (!res.ok) throw new Error(`Feedback was not accepted (${res.status}).`);
}

// Sends the entry; if the network is down it is kept in an outbox and retried with the next one.
async function send(userDataDir, entry) {
    const outbox = path.join(userDataDir, "feedback-outbox.json");
    let queue = [];
    try { queue = JSON.parse(fs.readFileSync(outbox, "utf8")); } catch { /* empty */ }
    queue.push(entry);
    const failed = [];
    for (const item of queue) {
        try { await post(item); } catch { failed.push(item); }
    }
    fs.writeFileSync(outbox, JSON.stringify(failed));
    return { ok: !failed.includes(entry), queued: failed.length };
}

module.exports = { send };
