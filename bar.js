const $ = id => document.getElementById(id);
const q = $("q");
const chatBox = $("chat");
const chatIn = Object.assign(document.createElement("div"), { id: "chat-in" });
chatBox.append(chatIn);

const MAX_IMAGES = 3;
const NARROW = 640, WIDE = 870;

let settings = { keepOnTop: false, taskbar: false, startWithWindows: false, hotkey: "Alt+Space", model: "", models: [] };
let chat = newChat();
let chatList = [];
let images = [];          // attached images: [{ full }]
let useWeb = true;
let busy = false;
let live = null;          // the AI answer currently streaming in
let pending = null;       // a question waiting for Ollama / the model to be set up
let job = { running: false };
let sidebarOpen = false;
try { sidebarOpen = localStorage.getItem("sidebar") === "1"; } catch { /* storage unavailable */ }
let rows = [];            // suggestion rows: [{ section, label, icon, run }]
let selected = -1;        // -1 = nothing highlighted, so Enter asks the AI
let recording = false;

function el(tag, props = {}, ...kids) {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...kids);
    return node;
}

function newChat() {
    return { id: String(Date.now()), title: "New chat", created: Date.now(), updated: Date.now(), messages: [] };
}

/* ---------- window size ---------- */
let fitQueued = false, lastH = 0, lastW = 0;
function fit() {
    // Window resizes are costly, so ask at most once per frame and ignore tiny changes.
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => {
        fitQueued = false;
        // The window is sized to its content (chat capped), and the chat scrolls inside the rounded box.
        let h = $("top").offsetHeight + $("composer").offsetHeight + 14;
        if ($("update").classList.contains("show")) h += $("update").offsetHeight + 6;
        if (chatBox.style.display === "block") h += Math.min(chatIn.offsetHeight + 14, 470);
        if ($("sugg").style.display === "block") h += $("sugg").offsetHeight;
        if ($("menu").style.display === "block") h = Math.max(h, $("menu").offsetTop + $("menu").offsetHeight + 20);
        if (sidebarOpen) h = Math.max(h, 380);
        const w = sidebarOpen ? WIDE : NARROW;
        if (Math.abs(h - lastH) < 3 && w === lastW) return;
        lastH = h;
        lastW = w;
        window.bar.resize(w, h + 20);
    });
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

/* ---------- images ---------- */
function shrink(dataUrl, edge, quality) {
    return new Promise(resolve => {
        const img = new Image();
        img.onload = () => {
            const k = Math.min(1, edge / Math.max(img.width, img.height));
            const c = document.createElement("canvas");
            c.width = Math.max(1, Math.round(img.width * k));
            c.height = Math.max(1, Math.round(img.height * k));
            c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
            resolve(c.toDataURL("image/jpeg", quality));
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

function attach(dataUrl) {
    if (!dataUrl) return;
    if (images.length >= MAX_IMAGES) images.shift();
    images.push({ full: dataUrl });
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

/* ---------- composer ---------- */
function growInput() {
    q.style.height = "32px";
    q.style.height = Math.min(q.scrollHeight, 140) + "px";
}

function updateComposer() {
    const has = q.value.trim() || images.length;
    $("send").style.display = has || busy ? "grid" : "none";
    $("send-up").style.display = busy ? "none" : "block";
    $("send-stop").style.display = busy ? "block" : "none";
    $("send").title = busy ? "Stop" : "Ask (Enter)";
    $("quick").style.display = images.length ? "flex" : "none";
    $("thumbs").style.display = images.length ? "flex" : "none";
    $("thumbs").replaceChildren(...images.map((im, i) =>
        el("div", { className: "thumb" },
            el("img", { src: im.full }),
            el("button", { textContent: "×", title: "Remove", onclick: () => { images.splice(i, 1); updateComposer(); } }))));
    $("web-btn").classList.toggle("on", useWeb);
    $("web-btn").title = useWeb ? "Web search is on" : "Web search is off";
    growInput();
    fit();
}

$("composer").addEventListener("mousedown", e => {
    if (!e.target.closest("button") && e.target !== q) { e.preventDefault(); q.focus(); }
});
$("plus-btn").onclick = async () => attach(await window.bar.pickImage());
$("lens-btn").onclick = async () => attach(await window.bar.lensImage());
$("web-btn").onclick = () => { useWeb = !useWeb; updateComposer(); };
$("send").onclick = () => (busy ? window.bar.stop() : ask());
for (const b of document.querySelectorAll("#quick .btn")) b.onclick = () => ask(b.dataset.q, true);

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
    if (!rows.length) { box.style.display = "none"; return fit(); }
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
    if (!text || text.includes("\n") || chat.messages.length) { rows = []; selected = -1; return renderRows(); }
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
    if (e.isComposing) return;
    if (e.key === "ArrowDown" && rows.length) { selected = Math.min(selected + 1, rows.length - 1); renderRows(); e.preventDefault(); }
    else if (e.key === "ArrowUp" && rows.length) { selected = Math.max(selected - 1, -1); renderRows(); e.preventDefault(); }
    else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        selected >= 0 ? rows[selected].run() : ask();
    }
});
window.addEventListener("keydown", e => {
    if (e.key !== "Escape" || recording) return;
    if ($("modal").style.display === "block") closeModal();
    else if ($("menu").style.display === "block") toggleMenu(false);
    else window.bar.hide();
});

/* ---------- saving ---------- */
function persist() {
    chat.updated = Date.now();
    if (!chat.messages.length) return;
    const plain = { ...chat, messages: chat.messages.map(({ full, ...m }) => m) };
    window.bar.saveChat(plain).then(refreshChatList);
}

async function refreshChatList() {
    chatList = await window.bar.listChats();
    renderChatList();
}

function renderChatList() {
    $("chats").replaceChildren(...chatList.map(c =>
        el("div", { className: "chat-row" + (c.id === chat.id ? " on" : ""), onclick: () => openChat(c.id), title: c.title },
            el("span", { textContent: c.title }),
            el("button", {
                textContent: "×", title: "Delete chat",
                onclick: async e => {
                    e.stopPropagation();
                    await window.bar.deleteChat(c.id);
                    if (c.id === chat.id) newChatUi();
                    refreshChatList();
                }
            }))));
}

/* ---------- chat messages ---------- */
function showChat() {
    chatBox.style.display = "block";
    $("new-btn").style.display = "grid";
    rows = [];
    renderRows();
}

function newChatUi() {
    window.bar.resetChat();
    chat = newChat();
    busy = false;
    live = null;
    pending = null;
    chatIn.replaceChildren();
    chatBox.style.display = "none";
    $("new-btn").style.display = "none";
    toggleMenu(false);
    q.value = "";
    images = [];
    renderChatList();
    updateComposer();
    q.focus();
}

async function openChat(id) {
    const saved = await window.bar.getChat(id);
    if (!saved) return;
    window.bar.resetChat();
    chat = saved;
    busy = false; live = null; pending = null;
    chatIn.replaceChildren(...chat.messages.map(msgEl));
    showChat();
    window.bar.setHistory(chat.messages.map(m => ({ role: m.role, text: m.text })));
    renderChatList();
    scrollChat();
    updateComposer();
}

function scrollChat() { chatBox.scrollTop = chatBox.scrollHeight; }

const ICONS = {
    copy: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
    check: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>',
    star: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/></svg>',
    up: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 11v9H4v-9zM7 11l4-8a2 2 0 0 1 2 2v4h6a2 2 0 0 1 2 2l-1.5 7a2 2 0 0 1-2 1.5H7"/></svg>',
    down: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 13V4h3v9zM17 13l-4 8a2 2 0 0 1-2-2v-4H5a2 2 0 0 1-2-2l1.5-7A2 2 0 0 1 6.5 4H17"/></svg>'
};

function actionButton(kind, title, onclick) {
    const b = el("button", { className: `ib ${kind}`, title, onclick });
    b.innerHTML = ICONS[kind];
    return b;
}

function actionsFor(m) {
    const copy = actionButton("copy", "Copy", () => {
        window.bar.copy(m.text);
        copy.innerHTML = ICONS.check;
        setTimeout(() => { copy.innerHTML = ICONS.copy; }, 900);
    });
    const star = actionButton("star", "Star to remember in every chat", () => {
        m.starred = !m.starred;
        star.classList.toggle("on", m.starred);
        window.bar.setStar({ id: m.id, text: m.text, on: m.starred });
        persist();
    });
    star.classList.toggle("on", !!m.starred);
    const acts = [copy, star];
    if (m.role === "ai") {
        const up = actionButton("up", "Good answer", () => feedbackDialog(m, "up", up, down));
        const down = actionButton("down", "Bad answer", () => feedbackDialog(m, "down", up, down));
        up.classList.toggle("on", m.vote === "up");
        down.classList.toggle("on", m.vote === "down");
        acts.push(up, down);
    }
    return el("div", { className: "acts" }, ...acts);
}

function dedupeSources(list) {
    const seen = new Set();
    return list.filter(s => !seen.has(new URL(s.url).hostname) && seen.add(new URL(s.url).hostname));
}

function sourceChip(s) {
    return el("a", { textContent: new URL(s.url).hostname, title: s.title, onclick: () => window.bar.openUrl(s.url) });
}

function msgEl(m) {
    const node = el("div", { className: `msg ${m.role}` });
    if (m.role === "user") {
        node.append(...(m.thumbs || []).map(src => el("img", { src })));
        node.append(el("div", { className: "b", textContent: m.text }));
        node.append(actionsFor(m));
    } else {
        const text = el("div", { className: "text" });
        renderMarkdown(text, m.text);
        node.append(text, el("div", { className: "sources" }, ...dedupeSources(m.sources || []).map(sourceChip)), actionsFor(m));
    }
    return node;
}

/* ---------- Ollama + model setup (state lives in the main process) ---------- */
const setupCards = new Set();

function stepLine(done, active, text, percent) {
    const line = el("div", { className: "step", textContent: `${done ? "✓" : active ? "…" : "•"} ${text}` });
    if (active && percent != null) line.append(el("div", { className: "bar" }, el("i", { style: `width:${percent}%` })));
    return line;
}

function renderSetup(card) {
    const needsOllama = card.needs === "no-ollama";
    const onModel = job.step === "model";
    const model = settings.model || "the AI model";
    const children = [el("div", { textContent: "Tree Lens runs its AI on your PC. Setting it up is automatic and only happens once." })];
    if (needsOllama) children.push(stepLine(!!job.done || onModel, job.running && job.step === "ollama", "Install Ollama", job.percent));
    children.push(stepLine(!!job.done, job.running && onModel, `Download ${model}`, job.percent));
    if (job.running) children.push(el("div", { className: "note", textContent: job.text || "Working..." }));
    else if (job.done) children.push(el("div", { className: "note", textContent: "All set." }));
    else {
        if (job.error) children.push(el("div", { className: "note err", textContent: job.error }));
        children.push(el("button", {
            className: "btn primary", textContent: job.error ? "Try again" : "Set up Tree Lens AI",
            onclick: () => window.bar.runSetup(card.needs)
        }));
    }
    card.replaceChildren(...children);
}

function setupCard(needs) {
    const card = el("div", { className: "card" });
    card.needs = needs;
    setupCards.add(card);
    renderSetup(card);
    return card;
}

window.bar.onSetup(next => {
    job = next;
    for (const card of setupCards) {
        if (!card.isConnected) setupCards.delete(card);
        else renderSetup(card);
    }
    fit();
    if (job.done && pending) {
        const p = pending;
        pending = null;
        for (const card of setupCards) card.closest(".msg")?.remove();
        runAsk(p.text, p.canned);
    }
});
window.bar.setupState().then(s => { job = s; });

/* ---------- asking ---------- */
async function ask(prompt, canned = false) {
    if (busy) return;
    const text = (prompt || q.value).trim() || (images.length ? "Describe this image in detail." : "");
    if (!text) return;
    const pics = images.map(i => i.full);
    const thumbs = await Promise.all(pics.map(p => shrink(p, 200, 0.6)));
    const userMsg = { id: crypto.randomUUID(), role: "user", text, thumbs, full: pics };
    chat.messages.push(userMsg);
    if (chat.title === "New chat") chat.title = text.slice(0, 40);
    q.value = "";
    images = [];
    updateComposer();
    showChat();
    chatIn.append(msgEl(userMsg));
    scrollChat();
    await runAsk(text, canned);
}

async function runAsk(text, canned) {
    busy = true;
    updateComposer();
    const userMsg = [...chat.messages].reverse().find(m => m.role === "user");
    const pics = userMsg && userMsg.full ? userMsg.full : [];

    const m = { id: crypto.randomUUID(), role: "ai", text: "" };
    const note = el("div", { className: "note", textContent: "Thinking..." });
    const textBox = el("div", { className: "text" });
    const sources = el("div", { className: "sources" });
    const node = el("div", { className: "msg ai" }, note, textBox, sources);
    chatIn.append(node);
    scrollChat();
    fit();

    const started = Date.now();
    live = { m, note, textBox, sources, stage: "Thinking..." };
    const timer = setInterval(() => {
        if (!m.text) note.textContent = `${live ? live.stage : "Thinking..."} ${Math.round((Date.now() - started) / 1000)}s`;
    }, 1000);

    const r = await window.bar.ask({ text, images: pics, web: useWeb, canned });
    clearInterval(timer);
    busy = false;
    live = null;
    note.remove();

    if (r.setup) {
        node.replaceChildren(setupCard(r.setup));
        pending = { text, canned };
    } else if (r.stopped) {
        if (m.text) { finishAnswer(m, node, {}); node.append(el("div", { className: "note", textContent: "Stopped." })); }
        else node.remove();
    } else if (!r.ok) {
        node.append(el("div", { className: "note err", textContent: r.error }));
    } else {
        finishAnswer(m, node, r);
    }
    updateComposer();
    scrollChat();
    q.focus();
}

function finishAnswer(m, node, r) {
    m.thinking = r.thinking || "";
    m.sources = r.sources || [];
    m.searched = !!r.searched;
    m.ms = r.ms || 0;
    m.model = r.model || settings.model;
    chat.messages.push(m);
    node.replaceWith(msgEl(m));
    persist();
}

let drawTimer = null;
window.bar.onToken(piece => {
    if (!live) return;
    live.m.text += piece;
    live.note.textContent = "";
    if (drawTimer) return;
    drawTimer = setTimeout(() => {
        drawTimer = null;
        if (!live) return;
        renderMarkdown(live.textBox, live.m.text);
        scrollChat();
        fit();
    }, 120);
});
window.bar.onNote(t => { if (live) { live.stage = t; if (!live.m.text) live.note.textContent = t; } });
window.bar.onSources(list => {
    if (!live) return;
    live.sources.replaceChildren(...dedupeSources(list).map(sourceChip));
    fit();
});

/* ---------- feedback (thumbs up / down) ---------- */
function closeModal() {
    $("modal").style.display = "none";
    $("modal").replaceChildren();
}

async function feedbackDialog(m, vote, upBtn, downBtn) {
    if (m.vote === vote) return;
    const i = chat.messages.indexOf(m);
    const question = chat.messages.slice(0, i).reverse().find(x => x.role === "user");
    const imgs = question ? (question.full && question.full.length ? question.full : question.thumbs || []) : [];

    const include = el("input", { type: "checkbox", checked: true });
    const comment = el("textarea", { placeholder: "Anything else? (optional)" });
    const status = el("div", { className: "note" });
    const send = el("button", { className: "btn primary", textContent: "Send feedback" });
    const dlg = el("div", { className: "dlg" },
        el("h3", { textContent: vote === "up" ? "👍 Good answer" : "👎 Bad answer" }),
        el("div", { className: "note", textContent: "If you send this, the Tree Lens developers will see the following. Nothing else leaves your PC." }),
        el("div", { className: "note", textContent: "Your message" }),
        el("div", { className: "pre", textContent: question ? question.text : "" }),
        ...(imgs.length ? [el("div", {}, ...imgs.map(src => el("img", { src })))] : []),
        ...(imgs.length ? [el("label", { className: "note" }, include, " Include the image(s)")] : []),
        el("div", { className: "note", textContent: "The answer" }),
        el("div", { className: "pre", textContent: m.text }),
        el("div", { className: "note", textContent: `How it was made: ${m.model || ""}${m.searched ? ", used web search" : ""}${m.thinking ? ", plus the model's reasoning" : ""}.` }),
        comment, status,
        el("div", { className: "row2" },
            el("button", { className: "btn", textContent: "Cancel", onclick: closeModal }), send));
    $("modal").replaceChildren(dlg);
    $("modal").style.display = "block";

    send.onclick = async () => {
        send.disabled = true;
        status.textContent = "Sending...";
        const pictures = include.checked && imgs.length
            ? await Promise.all(imgs.slice(0, 2).map(src => shrink(src, 480, 0.55)))
            : [];
        const r = await window.bar.sendFeedback({
            vote,
            question: (question ? question.text : "").slice(0, 4000),
            answer: m.text.slice(0, 8000),
            images: pictures,
            comment: comment.value.slice(0, 1000),
            chatId: chat.id,
            context: JSON.stringify({
                searched: !!m.searched,
                sources: (m.sources || []).map(s => s.url),
                seconds: Math.round((m.ms || 0) / 1000),
                thinking: (m.thinking || "").slice(0, 4000)
            })
        });
        if (r.ok) {
            m.vote = vote;
            upBtn.classList.toggle("on", vote === "up");
            downBtn.classList.toggle("on", vote === "down");
            persist();
            closeModal();
        } else {
            status.textContent = r.queued
                ? "Couldn't reach the server. It's saved and will be sent next time."
                : (r.error || "Couldn't send.");
            send.disabled = false;
        }
    };
}

/* ---------- header, menu, sidebar ---------- */
function toggleMenu(open) {
    $("menu").style.display = open ? "block" : "none";
    fit();
}

function setSidebar(open) {
    sidebarOpen = open;
    try { localStorage.setItem("sidebar", open ? "1" : "0"); } catch { /* storage unavailable */ }
    $("side").style.display = open ? "flex" : "none";
    $("m-hist-c").textContent = open ? "✓" : "";
    if (open) refreshChatList();
    fit();
}

$("update-btn").onclick = () => window.bar.restartForUpdate();
$("close-btn").onclick = () => window.bar.hide();
$("new-btn").onclick = newChatUi;
$("menu-btn").onclick = () => toggleMenu($("menu").style.display !== "block");
$("m-new").onclick = newChatUi;
$("m-hist").onclick = () => { setSidebar(!sidebarOpen); toggleMenu(false); };
$("m-top").onclick = () => window.bar.setSetting("keepOnTop", !settings.keepOnTop);
$("pin-btn").onclick = () => window.bar.setSetting("keepOnTop", !settings.keepOnTop);
$("m-task").onclick = () => window.bar.setSetting("taskbar", !settings.taskbar);
$("m-login").onclick = () => window.bar.setSetting("startWithWindows", !settings.startWithWindows);
$("m-hotkey").onclick = () => startHotkeyRecording();
$("m-quit").onclick = () => window.bar.quit();
window.addEventListener("click", e => {
    if (!e.target.closest("#menu") && !e.target.closest("#menu-btn")) toggleMenu(false);
});

function applySettings(s) {
    settings = s;
    $("update").classList.toggle("show", !!s.updateReady);
    $("update-text").textContent = s.updateReady ? `Tree Lens ${s.updateReady} is ready to install.` : "";
    if (!recording) $("keys").textContent = s.hotkey.split("+").join(" + ");
    $("pin-btn").classList.toggle("on", s.keepOnTop);
    $("pin-btn").title = s.keepOnTop ? "Kept on top (click to unpin)" : "Keep on top";
    $("m-top-c").textContent = s.keepOnTop ? "✓" : "";
    $("m-task-c").textContent = s.taskbar ? "✓" : "";
    $("m-login-c").textContent = s.startWithWindows ? "✓" : "";
    $("m-models").replaceChildren(...s.models.map(mod =>
        el("div", {
            className: "sub" + (mod.id === s.model ? " sel" : ""),
            textContent: `${mod.id === s.model ? "✓ " : ""}${mod.label}`,
            onclick: () => { if (mod.id !== s.model) { window.bar.setSetting("model", mod.id); newChatUi(); } }
        })));
}
window.bar.getSettings().then(applySettings);
window.bar.onSettings(applySettings);

/* ---------- custom hotkey ---------- */
const KEY_NAMES = { Space: "Space", Enter: "Return", Tab: "Tab", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };

function startHotkeyRecording() {
    recording = true;
    toggleMenu(false);
    $("keys").textContent = "Press new shortcut (Esc cancels)";
    window.bar.recordHotkey(true);
}

function stopRecording() {
    recording = false;
    applySettings(settings);
}

window.addEventListener("keydown", async e => {
    if (!recording) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === "Escape") { window.bar.recordHotkey(false); return stopRecording(); }
    const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift", e.metaKey && "Super"].filter(Boolean);
    if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) {
        $("keys").textContent = [...mods, "..."].join(" + "); // show the modifiers held so far
        return;
    }
    const code = e.code;
    const key = KEY_NAMES[code]
        || (/^Key[A-Z]$/.test(code) ? code.slice(3) : /^Digit\d$/.test(code) ? code.slice(5) : /^F\d{1,2}$/.test(code) ? code : null);
    const ok = key && (/^F\d/.test(key) || mods.length >= 2 || (mods.length === 1 && mods[0] === "Alt" && key !== "Tab" && key !== "Return"));
    if (!ok) {
        $("keys").textContent = "Use two of Ctrl/Alt/Shift + a key (or Alt + a key)";
        return;
    }
    const r = await window.bar.setHotkey([...mods, key].join("+"));
    if (!r.ok) {
        $("keys").textContent = r.error;
        setTimeout(stopRecording, 2500);
        return;
    }
    stopRecording();
}, true);

window.bar.onShown(() => {
    q.value = "";
    rows = [];
    renderRows();
    updateComposer();
    q.focus();
    window.bar.setupState().then(s => { job = s; });
});

// Whenever the window gets focus, typing must go straight into the box (not the first button).
window.addEventListener("focus", () => { if (!recording && $("modal").style.display !== "block") q.focus(); });

setSidebar(sidebarOpen);
refreshChatList();
updateComposer();
setTimeout(() => q.focus(), 50);
