const $ = id => document.getElementById(id);
const q = $("q");

let rows = [];     // [{ label, icon, hint, run }]
let selected = 0;
let mode = "describe";

function fit() {
    // Tell the window how tall the content is (the bar grows with results).
    window.bar.resize($("wrap").offsetHeight + 20);
}

function showPanel(which) {
    $("list").style.display = which === "list" ? "block" : "none";
    $("lens").style.display = which === "lens" ? "block" : "none";
    fit();
}

/* ---------- search ---------- */
function renderRows() {
    const list = $("list");
    list.replaceChildren(...rows.map((r, i) => {
        const div = document.createElement("div");
        div.className = "row" + (i === selected ? " sel" : "");
        const ico = Object.assign(document.createElement("span"), { className: "ico", textContent: r.icon });
        const hint = Object.assign(document.createElement("small"), { textContent: r.hint });
        div.append(ico, r.label, hint);
        div.onclick = r.run;
        return div;
    }));
    showPanel(rows.length ? "list" : null);
}

let searchToken = 0;
async function onType() {
    const text = q.value.trim();
    const token = ++searchToken;
    if (!text) { rows = []; return renderRows(); }
    const apps = await window.bar.searchApps(text);
    if (token !== searchToken) return; // a newer keystroke won
    rows = [
        ...apps.map(a => ({ label: a.name, icon: "▢", hint: "App", run: () => window.bar.launch(a.id) })),
        { label: `Search the web for “${text}”`, icon: "🔍", hint: "Web", run: () => window.bar.searchWeb(text) }
    ];
    selected = 0;
    renderRows();
}

q.addEventListener("input", onType);
q.addEventListener("keydown", e => {
    if (e.key === "ArrowDown" && rows.length) { selected = (selected + 1) % rows.length; renderRows(); e.preventDefault(); }
    else if (e.key === "ArrowUp" && rows.length) { selected = (selected - 1 + rows.length) % rows.length; renderRows(); e.preventDefault(); }
    else if (e.key === "Enter" && rows[selected]) rows[selected].run();
});
window.addEventListener("keydown", e => { if (e.key === "Escape") window.bar.hide(); });

window.bar.onShown(() => {
    q.value = "";
    rows = [];
    $("list").replaceChildren();
    showPanel(null);
    q.focus();
});

/* ---------- Lens ---------- */
async function lens(again) {
    $("lens").style.display = "block";
    $("list").style.display = "none";
    $("status").textContent = again ? "Thinking..." : "Select an area...";
    $("answer").textContent = "";
    fit();
    const r = await window.bar.runLens({ mode, lang: $("lang").value.trim() || "English", again });
    if (!r.ok) {
        $("status").textContent = r.error;
    } else if (r.cancelled) {
        showPanel(null);
        return;
    } else {
        $("status").textContent = "";
        $("thumb").src = r.image;
        $("answer").textContent = r.text || "(no answer)";
    }
    fit();
}

$("lens-btn").onclick = () => lens(false);
window.bar.onLensStatus(text => { $("status").textContent = text; fit(); });

for (const chip of document.querySelectorAll("#chips .chip")) {
    chip.onclick = () => {
        mode = chip.dataset.mode;
        document.querySelectorAll("#chips .chip").forEach(c => c.classList.toggle("on", c === chip));
        $("lang").style.display = mode === "translate" ? "block" : "none";
        lens(true);
    };
}
$("copy").onclick = () => navigator.clipboard.writeText($("answer").textContent);
fit();
