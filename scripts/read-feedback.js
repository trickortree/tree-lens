// Prints the thumbs up/down feedback people sent from Tree Lens.
//   node scripts/read-feedback.js            (summary of every entry)
//   node scripts/read-feedback.js --images   (also saves attached images into ./feedback-images)
//   node scripts/read-feedback.js --delete <id>
// Uses the login that `firebase login` already stored on this PC. Clients can't read this collection
// (see treesim's firestore.rules); only the project owner can, through the Firebase API.
const fs = require("fs");
const os = require("os");
const path = require("path");

const PROJECT = "treesim-a59eb";
// The Firebase CLI's own public OAuth client, used to turn its stored refresh token into an access token.
const CLIENT_ID = "563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com";
const CLIENT_SECRET = "j9iVZfS8kkCEFUPaAeJV0sAi";

async function accessToken() {
    const store = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config", "configstore", "firebase-tools.json"), "utf8"));
    const refresh = store.tokens && store.tokens.refresh_token;
    if (!refresh) throw new Error("Not logged in to the Firebase CLI. Run: npx firebase-tools login");
    const res = await fetch("https://www.googleapis.com/oauth2/v3/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ refresh_token: refresh, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: "refresh_token" })
    });
    if (!res.ok) throw new Error(`Could not get an access token (${res.status})`);
    return (await res.json()).access_token;
}

const plain = v => {
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("doubleValue" in v) return v.doubleValue;
    if ("booleanValue" in v) return v.booleanValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(plain);
    return null;
};

(async () => {
    const token = await accessToken();
    const del = process.argv.indexOf("--delete");
    if (del > 0) {
        const res = await fetch(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/treelens_feedback/${process.argv[del + 1]}`,
            { method: "DELETE", headers: { Authorization: `Bearer ${token}` } });
        console.log(res.ok ? "Deleted." : `Delete failed (${res.status})`);
        return;
    }
    const saveImages = process.argv.includes("--images");
    let pageToken = "", count = 0;
    do {
        const url = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/treelens_feedback?pageSize=100${pageToken ? `&pageToken=${pageToken}` : ""}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Read failed (${res.status}): ${await res.text()}`);
        const data = await res.json();
        for (const doc of data.documents || []) {
            const f = Object.fromEntries(Object.entries(doc.fields).map(([k, v]) => [k, plain(v)]));
            const id = doc.name.split("/").pop();
            console.log(`\n=== ${f.vote === "up" ? "UP  " : "DOWN"} ${new Date(f.ts).toLocaleString()}  model=${f.model} v${f.version} chat=${f.chatId} ${id}`);
            console.log("Q:", f.question);
            console.log("A:", f.answer);
            if (f.comment) console.log("Comment:", f.comment);
            console.log("How it was made:", f.context);
            console.log(`Images: ${(f.images || []).length}`);
            if (saveImages) {
                fs.mkdirSync("feedback-images", { recursive: true });
                (f.images || []).forEach((img, i) => {
                    fs.writeFileSync(path.join("feedback-images", `${id}-${i}.jpg`), Buffer.from(img.split(",")[1], "base64"));
                });
            }
            count++;
        }
        pageToken = data.nextPageToken || "";
    } while (pageToken);
    console.log(`\n${count} feedback entr${count === 1 ? "y" : "ies"}.`);
})().catch(err => { console.error(err.message); process.exit(1); });
