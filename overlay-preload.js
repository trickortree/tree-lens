const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("overlay", {
    onImage: cb => ipcRenderer.on("overlay:image", (_e, dataUrl) => cb(dataUrl)),
    done: rect => ipcRenderer.send("overlay:done", rect)
});
