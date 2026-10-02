// Talks to a local Ollama server (https://ollama.com), which runs the model on this PC,
// and does keyless web searches through DuckDuckGo's HTML endpoint.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const OLLAMA = process.env.OLLAMA_HOST_URL || "http://127.0.0.1:11434";

// The first entry is the default. Most laptops this runs on have 8 GB of RAM, so the options are small.
const MODELS = [
    { id: "gemma3:4b", label: "Balanced: gemma3:4b (3.3 GB, best answers, ~50 s per image)" },
    { id: "moondream", label: "Fast: moondream (1.7 GB, ~3x quicker on images, simpler answers)" }
];
const DEFAULT_MODEL = MODELS[0].id;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Calls fn at most every `ms`, always delivering the latest value (so progress never floods the UI).
function throttle(fn, ms = 250) {
    let last = 0, timer = null, pending;
    return value => {
        pending = value;
        const wait = ms - (Date.now() - last);
        if (wait <= 0) { last = Date.now(); fn(pending); }
        else if (!timer) timer = setTimeout(() => { timer = null; last = Date.now(); fn(pending); }, wait);
    };
}

async function listModels() {
    const res = await fetch(`${OLLAMA}/api/tags`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) throw new Error(`Ollama returned ${res.status}`);
    return (await res.json()).models.map(m => m.name);
}

const ollamaExe = () => path.join(process.env.LOCALAPPDATA || "", "Programs", "Ollama", "ollama.exe");

// Starts only the background server: no Ollama window, no terminal, no sign-in prompt.
function startServer() {
    const exe = ollamaExe();
    if (!fs.existsSync(exe)) return false;
    // Not "detached": a console-less server makes Windows open a visible command window for every
    // model run it starts. With a hidden console of its own, its helpers inherit it and stay invisible.
    spawn(exe, ["serve"], {
        stdio: "ignore",
        windowsHide: true,
        env: {
            ...process.env,
            OLLAMA_MAX_LOADED_MODELS: "1",
            OLLAMA_NUM_PARALLEL: "1",
            OLLAMA_FLASH_ATTENTION: "1",
            OLLAMA_KV_CACHE_TYPE: "q8_0"
        }
    }).unref();
    return true;
}

// "ready" | "no-model" | "no-ollama" (not installed) | "slow" (installed, but still starting up).
// Ollama's first start can take a minute on some PCs, so an installed Ollama is given time instead of
// being treated as missing.
async function status(model, onWait) {
    await quietOllama();
    let started = false;
    const installed = fs.existsSync(ollamaExe());
    for (let i = 0; i < (installed ? 120 : 3); i++) {
        try {
            const models = await listModels();
            return models.some(m => m === model || m.startsWith(`${model}-`) || (!model.includes(":") && m === `${model}:latest`))
                ? "ready" : "no-model";
        } catch {
            if (!started) {
                started = startServer();
                if (!started) return "no-ollama";
            }
            if (onWait && i === 2) onWait("Starting Ollama (the first start can take a minute)...");
            await sleep(1000);
        }
    }
    return installed ? "slow" : "no-ollama";
}

// Loads the model into memory ahead of the first question (only if the server is already up).
async function warm(model) {
    try {
        await listModels();
        await fetch(`${OLLAMA}/api/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ model, prompt: "", keep_alive: "30m" }),
            signal: AbortSignal.timeout(120000)
        });
    } catch { /* not running or model missing: nothing to warm */ }
}

function run(file, args) {
    return new Promise(resolve => execFile(file, args, { windowsHide: true }, (err, out) => resolve(err ? "" : String(out))));
}

// Ollama's own desktop app (the window with "Apps", a tray icon and a login-time autostart) is not
// needed: Tree Lens only uses the quiet background server. Close the window if it is open and stop
// it from starting at login. The server it hosted keeps running.
async function quietOllama() {
    const list = await run("tasklist", ["/FI", "IMAGENAME eq ollama app.exe", "/NH"]);
    if (/ollama app\.exe/i.test(list)) await run("taskkill", ["/F", "/IM", "ollama app.exe"]);
    await run("reg", ["delete", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Ollama", "/f"]);
    const startup = path.join(process.env.APPDATA || "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Ollama.lnk");
    try { fs.rmSync(startup, { force: true }); } catch { /* not there */ }
}

// Downloads the official Ollama installer and runs it silently (per-user install, no prompts).
async function installOllama(onProgress) {
    const report = throttle(onProgress);
    const res = await fetch("https://ollama.com/download/OllamaSetup.exe");
    if (!res.ok) throw new Error(`Could not download Ollama (${res.status}).`);
    const total = Number(res.headers.get("content-length")) || 0;
    const dest = path.join(os.tmpdir(), "OllamaSetup.exe");
    const out = fs.createWriteStream(dest);
    let done = 0;
    for await (const chunk of res.body) {
        if (!out.write(chunk)) await new Promise(r => out.once("drain", r));
        done += chunk.length;
        report({ text: "Downloading Ollama", percent: total ? Math.round(done / total * 100) : null });
    }
    await new Promise((resolve, reject) => out.end(err => (err ? reject(err) : resolve())));

    onProgress({ text: "Installing Ollama (about a minute)", percent: null });
    const code = await new Promise((resolve, reject) => {
        const p = spawn(dest, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-"], { stdio: "ignore", windowsHide: true });
        p.on("error", reject);
        p.on("exit", resolve);
    });
    if (code !== 0) throw new Error(`The Ollama installer failed (code ${code}).`);
    fs.rmSync(dest, { force: true });

    // The installer starts Ollama's own window and sets it to launch at login; we only want the quiet server.
    await quietOllama();
    onProgress({ text: "Starting Ollama", percent: null });
    for (let i = 0; i < 20; i++) {
        try { await listModels(); return; } catch { if (i === 0) startServer(); await sleep(1000); }
    }
    throw new Error("Ollama installed but did not start.");
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

async function pullModel(model, onProgress) {
    const report = throttle(onProgress);
    const res = await fetch(`${OLLAMA}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, stream: true })
    });
    if (!res.ok) throw new Error(`Model download failed (${res.status}).`);
    for await (const msg of ndjson(res)) {
        if (msg.error) throw new Error(msg.error);
        report({
            text: msg.total ? "Downloading the AI model" : (msg.status || "Preparing the model"),
            percent: msg.total ? Math.round(msg.completed / msg.total * 100) : null
        });
    }
}

// messages: [{ role, content, images?: [base64] }]. Returns { answer, thinking }.
async function chat(model, messages, onToken, signal) {
    const res = await fetch(`${OLLAMA}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model, messages, stream: true, keep_alive: "30m",
            options: { num_ctx: 4096, num_predict: 500 }
        }),
        signal
    });
    if (!res.ok) throw new Error(`The model returned an error (${res.status}).`);
    let answer = "", thinking = "";
    for await (const msg of ndjson(res)) {
        if (msg.error) throw new Error(msg.error);
        const m = msg.message || {};
        if (m.thinking) thinking += m.thinking;
        if (m.content) {
            answer += m.content;
            onToken(m.content);
        }
    }
    return { answer, thinking };
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
    return links.slice(0, 5).map((m, i) => {
        let url = decodeEntities(m[1]);
        const wrapped = url.match(/uddg=([^&]+)/);
        if (wrapped) url = decodeURIComponent(wrapped[1]);
        return { title: decodeEntities(m[2]), url, snippet: snippets[i] ? decodeEntities(snippets[i][1]) : "" };
    }).filter(r => /^https?:\/\//.test(r.url));
}

// Not every message needs the web: skip greetings, tiny messages and plain maths.
function shouldSearch(text) {
    const t = text.trim();
    if (t.split(/\s+/).length < 3) return false;
    if (/^(hi|hello|hey|thanks|thank you|ok|okay|yo|sup)\b/i.test(t) && t.length < 25) return false;
    if (/^[\d\s+\-*/().^%=x]+$/.test(t)) return false;
    if (/\b(rewrite|rephrase|summari[sz]e|translate|proofread|fix my|write me|write a|code|function)\b/i.test(t)) return false;
    return true;
}

module.exports = { quietOllama, MODELS, DEFAULT_MODEL, throttle, status, warm, installOllama, pullModel, chat, webSearch, shouldSearch };
