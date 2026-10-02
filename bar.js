const $ = id => document.getElementById(id);
const q = $("q");

const MAX_IMAGES = 3;
let images = [];      // attached images (data URLs)
let useWeb = true;
let chatMode = false;
let busy = false;
let rows = [];        // suggestion rows: [{ label, icon, hint, run }]
let selected = -1;    // -1 = nothing highlighted, so Enter asks the AI

function fit() {
    // Tell the window how tall the content is (the bar grows with the chat).
    window.bar.resize($("wrap").offsetHeight + 20);
}

function el(tag, props = {}, ...kids) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
}

/* ---------- tiny markdown: **bold**, `code`, - lists, paragraphs ---------- */
function inline(text) {
    const out = [];
    for (const part of text.split(/(\*\*[^*]+\*\*|`[^`]+`)/)) {
        if (part.startsWith("**") && part.endsWith("**") && part.length > 4) out.push(el("b", { textContent: part.slice(2, -2) }));
        else if (part.startsWith("`") && part.endsWith("`") && part.length > 2) out.push(el("code", { textContent: part.slice(1, -1) }));
        else out.push(part);
    }
    return out;
}

function renderMarkdown(target, text) {
    const nodes = [];
    let list = null;
    for (const line of text.split("\n")) {
        const item = line.match(/^\s*(?:[-*•]|\d+\.)\s+(.*)$/);
        if (item) {
            if (!list) { list = el("ul"); nodes.push(list); }
            list.append(el("li", {}, ...inline(item[1])));
        } else {
            list = null;
            if (line.trim()) nodes.push(el("p", {}, ...inline(line.replace(/^#+\s*/, ""))));
        }
    }
    target.replaceChildren(...nodes);
}

/* ---------- composer ---------- */
function updateComposer() {
    const has = q.value.trim() || images.length;
    $("send").style.display = has ? "grid" : "none";
    $("quick").style.display = images.length ? "flex" : "none";
    $("thumbs").style.display = images.length ? "flex" : "none";
    $("thumbs").replaceChildren(...images.map((src, i) =>
        el("div", { className: "thumb" },
            el("img", { src }),
            el("button", { textContent: "×", title: "Remove", onclick: () => { images.splice(i, 1); updateComposer(); } }))));
    $("web-btn").classList.toggle("on", useWeb);
    $("web-btn").title = useWeb ? "Web search is on for text questions" : "Web search is off";
    fit();
}

function attach(dataUrl) {
    if (!dataUrl) return;
    if (images.length >= MAX_IMAGES) images.shift();
    images.push(dataUrl);
    updateComposer();
    q.focus();
}

async function attachFile(file) {
    if (!file || !file.type.startsWith("image/")) return;
    const dataUrl = await new Promise(resolve => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.readAsDataURL(file);
    });
    attach(await window.bar.normalizeImage(dataUrl));
}

$("plus-btn").onclick = async () => attach(await window.bar.pickImage());
$("lens-btn").onclick = async () => attach(await window.bar.lensImage());
$("web-btn").onclick = () => { useWeb = !useWeb; updateComposer(); };
$("send").onclick = () => ask();
for (const b of document.querySelectorAll("#quick .btn")) b.onclick = () => ask(b.dataset.q);

window.addEventListener("paste", e => {
    const file = [...e.clipboardData.files].find(f => f.type.startsWith("image/"));
    if (file) { e.preventDefault(); attachFile(file); }
});
window.addEventListener("dragover", e => { e.preventDefault(); document.body.classList.add("dragging"); });
window.addEventListener("dragleave", () => document.body.classList.remove("dragging"));
window.addEventListener("drop", e => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    for (const f of e.dataTransfer.files) attachFile(f);
});

/* ---------- suggestions (apps + web) ---------- */
function renderRows() {
    const box = $("sugg");
    if (!rows.length || chatMode) { box.style.display = "none"; return fit(); }
    const parts = [];
    let lastHeader = "";
    rows.forEach((r, i) => {
        if (r.section !== lastHeader) { parts.push(el("h4", { textContent: r.section })); lastHeader = r.section; }
        parts.push(el("div", { className: "row" + (i === selected ? " sel" : ""), onclick: r.run },
            el("span", { className: "ico", textContent: r.icon }), r.label));
    });
    box.replaceChildren(...parts);
    box.style.display = "block";
    fit();
}

let token = 0;
async function onType() {
    updateComposer();
    const text = q.value.trim();
    const mine = ++token;
    if (!text || chatMode) { rows = []; selected = -1; return renderRows(); }
    const apps = await window.bar.searchApps(text);
    if (mine !== token) return; // a newer keystroke won
    rows = [
        ...apps.map(a => ({ section: "Apps", label: a.name, icon: "▢", run: () => window.bar.launch(a.id) })),
        { section: "Web", label: `Search Google for “${text}”`, icon: "🔍", run: () => window.bar.searchWeb(text) }
    ];
    selected = -1;
    renderRows();
}

q.addEventListener("input", onType);
q.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" && rows.length) { selected = Math.min(selected + 1, rows.length - 1); renderRows(); e.preventDefault(); }
    else if (e.key === "ArrowUp" && rows.length) { selected = Math.max(selected - 1, -1); renderRows(); e.preventDefault(); }
    else if (e.key === "Enter") { selected >= 0 ? rows[selected].run() : ask(); }
});
window.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    if ($("menu").style.display === "block") $("menu").style.display = "none";
    else window.bar.hide();
});

/* ---------- chat ---------- */
function enterChat() {
    if (chatMode) return;
    chatMode = true;
    $("chat").style.display = "block";
    $("new-btn").style.display = "grid";
    $("menu-btn").style.display = "none";
    rows = [];
    renderRows();
}

function newChat() {
    window.bar.resetChat();
    chatMode = false;
    busy = false;
    $("chat").replaceChildren();
    $("chat").style.display = "none";
    $("new-btn").style.display = "none";
    $("menu-btn").style.display = "grid";
    $("menu").style.display = "none";
    q.value = "";
    images = [];
    updateComposer();
    q.focus();
}

function scrollChat() { $("chat").scrollTop = $("chat").scrollHeight; }

function progressCard(text, button, run) {
    const status = el("div", { className: "note" });
    const btn = el("button", {
        className: "btn primary",
        textContent: button,
        onclick: async () => {
            btn.disabled = true;
            status.textContent = "Starting...";
            pullStatus = status;
            await run(status, btn);
        }
    });
    const card = el("div", { className: "card" }, text, el("div", {}, btn), status);
    card.start = () => btn.click();
    return card;
}

// Sets up everything the AI needs by itself: Ollama, then the model. `auto` starts without a click.
function setupCard(kind, retry, auto) {
    let card;
    if (kind === "no-ollama") {
        card = progressCard(
            "Tree Lens needs Ollama (free) to run its AI on your PC. I'll download and install it for you.",
            "Install Ollama",
            async (status, btn) => {
                const r = await window.bar.installOllama();
                if (r.ok) retry(true);
                else { status.textContent = r.error; btn.disabled = false; }
            });
    } else {
        card = progressCard(
            "Tree Lens needs its AI model, a one-time download of about 3 GB. After that it runs on your PC.",
            "Download model",
            async (status, btn) => {
                const r = await window.bar.pullModel();
                if (r.ok) retry(true);
                else { status.textContent = r.error; btn.disabled = false; }
            });
    }
    if (auto) setTimeout(() => card.start(), 0);
    return card;
}

async function ask(prompt) {
    if (busy) return;
    const text = (prompt || q.value).trim() || (images.length ? "Describe this image in detail." : "");
    if (!text) return;
    const pics = images.slice();
    q.value = "";
    images = [];
    updateComposer();
    enterChat();
    await runAsk(text, pics);
}

// The streaming events from the main process are registered once and write into the answer in progress.
let live = null;
window.bar.onToken(piece => {
    if (!live) return;
    live.buf += piece;
    live.note.textContent = "";
    renderMarkdown(live.textBox, live.buf);
    scrollChat();
    fit();
});
window.bar.onNote(t => { if (live && !live.buf) live.note.textContent = t; });
window.bar.onSources(list => {
    if (!live) return;
    live.sources.replaceChildren(...list.map(s => el("a", {
        textContent: new URL(s.url).hostname, title: s.title, onclick: () => window.bar.openUrl(s.url)
    })));
    fit();
});
let pullStatus = null;
window.bar.onPull(p => { if (pullStatus) pullStatus.textContent = p.percent == null ? p.text : `${p.text} ${p.percent}%`; });

async function runAsk(text, pics, existingUser, autoSetup) {
    busy = true;
    const chat = $("chat");
    if (!existingUser) {
        chat.append(el("div", { className: "msg user" },
            ...pics.map(src => el("img", { src })),
            el("div", { className: "b", textContent: text })));
    }
    const note = el("div", { className: "note", textContent: "..." });
    const answer = el("div", { className: "msg ai" });
    const sources = el("div", { className: "sources" });
    answer.append(note, el("div", { className: "text" }), sources);
    chat.append(answer);
    scrollChat();
    fit();

    live = { note, textBox: answer.querySelector(".text"), sources, buf: "" };

    const r = await window.bar.ask({ text, images: pics, web: useWeb });
    busy = false;
    live = null;
    note.textContent = "";
    if (r.setup) {
        answer.replaceChildren(setupCard(r.setup, auto => { answer.remove(); runAsk(text, pics, true, auto); }, autoSetup));
    } else if (!r.ok) {
        answer.append(el("div", { className: "note err", textContent: r.error }));
    }
    scrollChat();
    fit();
    q.focus();
}

/* ---------- header + menu ---------- */
$("close-btn").onclick = () => window.bar.hide();
$("new-btn").onclick = newChat;
$("menu-btn").onclick = () => {
    const m = $("menu");
    m.style.display = m.style.display === "block" ? "none" : "block";
};
$("m-new").onclick = newChat;
$("m-top").onclick = () => window.bar.setSetting("keepOnTop", !current.keepOnTop);
$("m-login").onclick = () => window.bar.setSetting("startWithWindows", !current.startWithWindows);
$("m-hotkey").onclick = startHotkeyRecording;
$("m-quit").onclick = () => window.bar.quit();
$("pin-btn").onclick = () => window.bar.setSetting("keepOnTop", !current.keepOnTop);
window.addEventListener("click", e => {
    if (!e.target.closest("#menu") && !e.target.closest("#menu-btn")) $("menu").style.display = "none";
});

let current = { keepOnTop: false, startWithWindows: false, hotkey: "Alt+Space" };
function applySettings(s) {
    current = s;
    if (recording) return;
    $("keys").textContent = s.hotkey.split("+").join(" + ");
    $("pin-btn").classList.toggle("on", s.keepOnTop);
    $("pin-btn").title = s.keepOnTop ? "Kept on top (click to unpin)" : "Keep on top";
    $("m-top-c").textContent = s.keepOnTop ? "✓" : "";
    $("m-login-c").textContent = s.startWithWindows ? "✓" : "";
}
/* ---------- custom hotkey ---------- */
const KEY_NAMES = { Space: "Space", Enter: "Return", Tab: "Tab", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
let recording = false;

function startHotkeyRecording() {
    recording = true;
    $("menu").style.display = "none";
    $("keys").textContent = "Press new shortcut... (Esc cancels)";
    window.bar.recordHotkey(true);
}

function stopRecording() {
    recording = false;
    applySettings(current);
}

window.addEventListener("keydown", async e => {
    if (!recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") { window.bar.recordHotkey(false); return stopRecording(); }
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return; // wait for the real key
    const code = e.code;
    const key = KEY_NAMES[code]
        || (/^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F\d{1,2}$/.test(code) ? code : null);
    const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
    if (!key || (!mods.length && !/^F\d/.test(key))) { $("keys").textContent = "Use Ctrl/Alt/Shift + a key"; return; }
    const r = await window.bar.setHotkey([...mods, key].join("+"));
    if (!r.ok) { window.bar.recordHotkey(false); $("keys").textContent = r.error; setTimeout(stopRecording, 2500); return; }
    stopRecording();
}, true);

window.bar.getSettings().then(applySettings);
window.bar.onSettings(applySettings);

window.bar.onShown(() => {
    q.value = "";
    rows = [];
    renderRows();
    updateComposer();
    q.focus();
});

updateComposer();
