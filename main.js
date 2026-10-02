const {
    app, BrowserWindow, ipcMain, shell, screen, desktopCapturer, globalShortcut, Tray, Menu, nativeImage
} = require("electron");
const path = require("path");
const fs = require("fs");
const { Worker } = require("worker_threads");
const { autoUpdater } = require("electron-updater");

app.setAppUserModelId("com.trickortree.treelens");

if (!app.requestSingleInstanceLock()) {
    app.quit();
}

// Hotkeys to try in order; the first one nobody else is using wins. Edit this list to rebind.
const HOTKEYS = ["Alt+Space", "Ctrl+Shift+Space", "Ctrl+Alt+L"];
let HOTKEY = HOTKEYS[0];
const BAR_WIDTH = 700;
const BAR_MIN_HEIGHT = 84;
const BAR_MAX_HEIGHT = 680;
const LENS_MODES = ["describe", "identify", "translate"];
const LENS_MAX_EDGE = 768;

let bar = null;
let tray = null;
let lensWorker = null;
let lensBusy = false;
let lastImage = null; // last selected area, so mode chips can re-run on it
let appIndex = [];
let appIndexAt = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function send(channel, data) {
    if (bar && !bar.isDestroyed()) bar.webContents.send(channel, data);
}

/* ---------- Search bar window ---------- */

function createBar() {
    bar = new BrowserWindow({
        width: BAR_WIDTH,
        height: BAR_MIN_HEIGHT,
        useContentSize: true,
        frame: false,
        transparent: true,
        resizable: false,
        maximizable: false,
        minimizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    bar.loadFile("bar.html");
    bar.on("blur", () => { if (!lensBusy) bar.hide(); });
}

function placeBar() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const { x, y, width, height } = display.workArea;
    const [w] = bar.getSize();
    bar.setPosition(Math.round(x + (width - w) / 2), Math.round(y + height * 0.18));
}

function showBar(fresh = true) {
    placeBar();
    bar.show();
    bar.focus();
    if (fresh) send("bar:shown");
    refreshAppIndex();
}

function toggleBar() {
    if (bar.isVisible() && bar.isFocused()) bar.hide();
    else showBar();
}

ipcMain.on("bar:resize", (_e, height) => {
    const h = Math.max(BAR_MIN_HEIGHT, Math.min(BAR_MAX_HEIGHT, Math.ceil(Number(height) || BAR_MIN_HEIGHT)));
    bar.setContentSize(BAR_WIDTH, h);
});
ipcMain.on("bar:hide", () => bar.hide());

/* ---------- App search (Start Menu) ---------- */

function walkLnk(dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkLnk(full, out);
        else if (/\.lnk$/i.test(e.name) && !/uninstall|readme|help/i.test(e.name)) {
            out.push({ name: e.name.replace(/\.lnk$/i, ""), path: full });
        }
    }
}

function refreshAppIndex() {
    if (Date.now() - appIndexAt < 60_000) return;
    appIndexAt = Date.now();
    const found = [];
    for (const base of [process.env.ProgramData, process.env.APPDATA]) {
        if (base) walkLnk(path.join(base, "Microsoft", "Windows", "Start Menu", "Programs"), found);
    }
    const seen = new Set();
    appIndex = found.filter(a => !seen.has(a.name.toLowerCase()) && seen.add(a.name.toLowerCase()));
}

ipcMain.handle("search:apps", (_e, query) => {
    const q = String(query || "").trim().toLowerCase();
    if (!q) return [];
    return appIndex
        .map((a, id) => ({ id, name: a.name, rank: a.name.toLowerCase().startsWith(q) ? 0 : a.name.toLowerCase().includes(q) ? 1 : 2 }))
        .filter(a => a.rank < 2)
        .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
        .slice(0, 6)
        .map(({ id, name }) => ({ id, name }));
});

ipcMain.handle("search:launch", (_e, id) => {
    const entry = appIndex[id];
    if (entry) shell.openPath(entry.path);
    bar.hide();
});

ipcMain.handle("search:web", (_e, query) => {
    shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(String(query || ""))}`);
    bar.hide();
});

/* ---------- Lens ---------- */

function getWorker() {
    if (lensWorker) return lensWorker;
    lensWorker = new Worker(path.join(__dirname, "lens-worker.js"), {
        workerData: { cacheDir: path.join(app.getPath("userData"), "models") }
    });
    lensWorker.on("exit", () => { lensWorker = null; });
    return lensWorker;
}

function askWorker(payload) {
    const worker = getWorker();
    return new Promise((resolve, reject) => {
        const onMessage = msg => {
            if (msg.type === "status") return send("lens:status", msg.text);
            worker.off("message", onMessage);
            worker.off("error", onError);
            if (msg.type === "result") resolve(msg.text);
            else reject(new Error(msg.message));
        };
        const onError = err => {
            worker.off("message", onMessage);
            reject(err);
        };
        worker.on("message", onMessage);
        worker.once("error", onError);
        worker.postMessage(payload);
    });
}

// Shows the screenshot full-screen on the given display; resolves with the dragged
// rectangle in CSS pixels, or null if the user cancelled.
async function selectRegion(display, shot) {
    const win = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        resizable: false,
        movable: false,
        skipTaskbar: true,
        show: false,
        backgroundColor: "#000000",
        webPreferences: {
            preload: path.join(__dirname, "overlay-preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
        }
    });
    win.setAlwaysOnTop(true, "screen-saver");
    await win.loadFile("overlay.html");
    win.webContents.send("overlay:image", `data:image/jpeg;base64,${shot.toJPEG(85).toString("base64")}`);
    win.show();
    win.focus();

    return new Promise(resolve => {
        const onDone = (e, rect) => {
            if (e.sender !== win.webContents) return;
            ipcMain.off("overlay:done", onDone);
            resolve(rect);
            win.close();
        };
        ipcMain.on("overlay:done", onDone);
        win.on("closed", () => {
            ipcMain.off("overlay:done", onDone);
            resolve(null);
        });
    });
}

async function captureRegion() {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const px = {
        width: Math.round(display.bounds.width * display.scaleFactor),
        height: Math.round(display.bounds.height * display.scaleFactor)
    };
    bar.hide();
    await sleep(300); // let the bar fully disappear before grabbing the screen
    const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: px });
    const source = sources.find(s => s.display_id === String(display.id)) || sources[0];
    const shot = source.thumbnail;
    const rect = await selectRegion(display, shot);
    if (!rect) return null;

    const scale = shot.getSize().width / display.bounds.width;
    let img = shot.crop({
        x: Math.round(rect.x * scale),
        y: Math.round(rect.y * scale),
        width: Math.max(1, Math.round(rect.w * scale)),
        height: Math.max(1, Math.round(rect.h * scale))
    });
    const { width, height } = img.getSize();
    const k = LENS_MAX_EDGE / Math.max(width, height);
    if (k < 1) img = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: "best" });
    return img;
}

// again=false: drag a new area first. again=true: re-run the last area in another mode.
ipcMain.handle("lens:run", async (_e, { mode, lang, again }) => {
    if (lensBusy) return { ok: false, error: "Tree Lens is already working." };
    if (!LENS_MODES.includes(mode)) return { ok: false, error: "Unknown mode." };
    lensBusy = true;
    try {
        if (!again) {
            let img;
            try {
                img = await captureRegion();
            } finally {
                showBar(false);
            }
            if (!img) return { ok: true, cancelled: true };
            lastImage = img;
        }
        if (!lastImage) return { ok: false, error: "Select an area first." };
        send("lens:status", "Preparing...");
        const text = await askWorker({
            mode,
            lang: String(lang || "English").slice(0, 40),
            image: lastImage.toPNG()
        });
        return { ok: true, text, image: lastImage.toDataURL() };
    } catch (err) {
        return { ok: false, error: String(err.message || err) };
    } finally {
        lensBusy = false;
    }
});

/* ---------- Tray, updates, lifecycle ---------- */

function createTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, "build", "icon.png")).resize({ width: 16, height: 16 });
    tray = new Tray(icon);
    tray.setToolTip(`Tree Lens (${HOTKEY})`);
    const menu = () => Menu.buildFromTemplate([
        { label: `Open (${HOTKEY})`, click: () => showBar() },
        {
            label: "Start with Windows",
            type: "checkbox",
            checked: app.getLoginItemSettings().openAtLogin,
            click: item => app.setLoginItemSettings({ openAtLogin: item.checked })
        },
        { type: "separator" },
        { label: `Tree Lens v${app.getVersion()}`, enabled: false },
        { label: "Quit", click: () => app.quit() }
    ]);
    tray.on("click", () => showBar());
    tray.on("right-click", () => tray.popUpContextMenu(menu()));
}

function setupAutoUpdater() {
    if (!app.isPackaged) return;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true; // installs the next time Tree Lens quits
    autoUpdater.on("error", err => console.error("AUTO-UPDATER ERROR:", err));
    autoUpdater.checkForUpdates().catch(err => console.error(err));
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

app.on("second-instance", () => { if (bar) showBar(); });

app.whenReady().then(() => {
    createBar();
    createTray();
    setupAutoUpdater();
    refreshAppIndex();
    HOTKEY = HOTKEYS.find(k => globalShortcut.register(k, toggleBar)) || "(none)";
    tray.setToolTip(`Tree Lens (${HOTKEY})`);
    if (HOTKEY !== HOTKEYS[0]) console.error(`${HOTKEYS[0]} is taken by another app, using ${HOTKEY}.`);
    if (!app.getLoginItemSettings().wasOpenedAtLogin) bar.once("ready-to-show", () => showBar());
});

app.on("will-quit", () => globalShortcut.unregisterAll());
app.on("window-all-closed", () => { /* stay in the tray */ });
