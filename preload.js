const { contextBridge, ipcRenderer } = require("electron");

const on = (channel, cb) => ipcRenderer.on(channel, (_e, data) => cb(data));

contextBridge.exposeInMainWorld("bar", {
    searchApps: q => ipcRenderer.invoke("search:apps", q),
    launch: id => ipcRenderer.invoke("search:launch", id),
    searchWeb: q => ipcRenderer.invoke("search:web", q),
    resize: h => ipcRenderer.send("bar:resize", h),
    hide: () => ipcRenderer.send("bar:hide"),
    onShown: cb => on("bar:shown", cb),
    runLens: opts => ipcRenderer.invoke("lens:run", opts),
    onLensStatus: cb => on("lens:status", cb)
});
