// Talks to a local Ollama server (https://ollama.com), which runs the model on this PC,
// and does keyless web searches through DuckDuckGo's HTML endpoint.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const OLLAMA = process.env.OLLAMA_HOST_URL || "http://127.0.0.1:11434";
// Small, mainstream, vision-capable, good at translation. Swap for "qwen2.5vl:3b" (better at
// reading text on screen) or "gemma3:12b" (smarter, needs ~10 GB of RAM) if you like.
const MODEL = "gemma3:4b";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function listModels() {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    return (await res.json()).models.map(m => m.name);
}

function startOllama() {
    const exe = path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama app.exe");
    if (!fs.existsSync(exe)) return false;
    spawn(exe, [], { detached: true, stdio: "ignore" }).unref();
    return true;
}

// "ready" | "no-model" | "no-ollama"
async function status() {
    let started = false;
    for (let i = 0; i < 10; i++) {
        try {
            const models = await listModels();
            return models.some(m => m === MODEL || m.startsWith(`${MODEL}-`)) ? "ready" : "no-model";
        } catch {
            if (!started) {
                started = startOllama();
                if (!started) return "no-ollama";
            }
            await sleep(1000);
        }
    }
    return "no-ollama";
}

// Downloads the official Ollama installer and runs it silently (per-user install, no prompts).
async function installOllama(onProgress) {
    const res = await fetch("https://ollama.com/download/OllamaSetup.exe");
    if (!res.ok) throw new Error(`Could not download Ollama (${res.status}).`);
    const total = Number(res.headers.get("content-length")) || 0;
    const dest = path.join(os.tmpdir(), "OllamaSetup.exe");
    const out = fs.createWriteStream(dest);
    let done = 0;
    for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise(r => out.once("drain", r));
        done += chunk.length;
        onProgress({ text: "Downloading Ollama", percent: total ? Math.round(done / total * 100) : null });
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));

    onProgress({ text: "Installing Ollama (this takes a minute)", percent: null });
    const code = await new Promise((resolve, reject) => {
        const p = spawn(dest, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], { stdio: "ignore" });
        p.on("error", reject);
        p.on("exit", resolve);
    });
    if (code !== 0) throw new Error(`The Ollama installer failed (code ${code}).`);
    fs.rmSync(dest, { force: true });
}

async function* ndjson(res) {
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
        buf += decoder.decode(chunk, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (line) yield JSON.parse(line);
        }
    }
    if (buf.trim()) yield JSON.parse(buf);
}

async function pullModel(onProgress) {
    const res = await fetch(`${OLLAMA}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, stream: true })
    });
    if (!res.ok) throw new Error(`Model download failed (${res.status}).`);
    for await (const msg of ndjson(res)) {
        if (msg.error) throw new Error(msg.error);
        onProgress({
            text: msg.status,
            percent: msg.total ? Math.round(msg.completed / msg.total * 100) : null
        });
    }
}

// messages: [{ role, content, images?: [base64] }]. Calls onToken with each piece of the answer.
async function chat(messages, onToken, signal) {
    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, messages, stream: true, keep_alive: "10m", options: { num_ctx: 8192 } }),
        signal
    });
    if (!res.ok) throw new Error(`The model returned an error (${res.status}).`);
    let answer = "";
    for await (const msg of ndjson(res)) {
        if (msg.error) throw new Error(msg.error);
        const piece = msg.message && msg.message.content;
        if (piece) {
            answer += piece;
            onToken(piece);
        }
    }
    return answer;
}

const decodeEntities = s => s
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();

// Returns [{ title, url, snippet }]. Throws if the network is down.
async function webSearch(query) {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36" },
        signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) throw new Error(`Search failed (${res.status})`);
    const html = await res.text();
    const links = [...html.matchAll(/class="result__a" href="([^"]+)"[^>]*>(.*?)<\/a>/gs)];
    const snippets = [...html.matchAll(/class="result__snippet"[^>]*>(.*?)<\/a>/gs)];
    return links.slice(0, 6).map((m, i) => {
        let url = decodeEntities(m[1]);
        const wrapped = url.match(/uddg=([^&]+)/);
        if (wrapped) url = decodeURIComponent(wrapped[1]);
        return { title: decodeEntities(m[2]), url, snippet: snippets[i] ? decodeEntities(snippets[i][1]) : "" };
    }).filter(r => /^https?:\/\//.test(r.url));
}

module.exports = { MODEL, status, installOllama, pullModel, chat, webSearch };
