const { contextBridge, ipcRenderer } = require("electron");

const on = (channel, cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld("bar", {
    // window
    resize: h => ipcRenderer.send("bar:resize", h),
    hide: () => ipcRenderer.send("bar:hide"),
    quit: () => ipcRenderer.send("bar:quit"),
    onShown: cb => on("bar:shown", cb),
    getSettings: () => ipcRenderer.invoke("settings:get"),
    setSetting: (key, value) => ipcRenderer.send("settings:set", key, value),
    onSettings: cb => on("settings:changed", cb),
    // search
    searchApps: q => ipcRenderer.invoke("search:apps", q),
    launch: id => ipcRenderer.invoke("search:launch", id),
    searchWeb: q => ipcRenderer.invoke("search:web", q),
    openUrl: url => ipcRenderer.send("open:url", url),
    // images
    normalizeImage: dataUrl => ipcRenderer.invoke("image:normalize", dataUrl),
    pickImage: () => ipcRenderer.invoke("image:pick"),
    lensImage: () => ipcRenderer.invoke("image:lens"),
    // AI
    aiStatus: () => ipcRenderer.invoke("ai:status"),
    installOllama: () => ipcRenderer.invoke("ai:install-ollama"),
    recordHotkey: on => ipcRenderer.send("hotkey:record", on),
    setHotkey: accel => ipcRenderer.invoke("hotkey:set", accel),
    pullModel: () => ipcRenderer.invoke("ai:pull"),
    ask: opts => ipcRenderer.invoke("ai:ask", opts),
    resetChat: () => ipcRenderer.send("ai:reset"),
    onToken: cb => on("ai:token", cb),
    onNote: cb => on("ai:note", cb),
    onSources: cb => on("ai:sources", cb),
    onPull: cb => on("ai:pull", cb)
});
