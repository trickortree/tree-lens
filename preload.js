const { contextBridge, ipcRenderer } = require("electron");

const on = (channel, cb) => ipcRenderer.on(channel, (_e, data) => cb(data));
const invoke = channel => (...args) => ipcRenderer.invoke(channel, ...args);
const send = channel => (...args) => ipcRenderer.send(channel, ...args);

contextBridge.exposeInMainWorld("bar", {
    // window
    resize: send("bar:resize"),
    hide: send("bar:hide"),
    quit: send("bar:quit"),
    copy: send("clipboard:write"),
    onShown: cb => on("bar:shown", cb),
    getSettings: invoke("settings:get"),
    setSetting: send("settings:set"),
    onSettings: cb => on("settings:changed", cb),
    recordHotkey: send("hotkey:record"),
    setHotkey: invoke("hotkey:set"),
    // search
    searchApps: invoke("search:apps"),
    launch: invoke("search:launch"),
    searchWeb: invoke("search:web"),
    openUrl: send("open:url"),
    // images
    normalizeImage: invoke("image:normalize"),
    pickImage: invoke("image:pick"),
    lensImage: invoke("image:lens"),
    // chats, stars, feedback
    listChats: invoke("chats:list"),
    getChat: invoke("chats:get"),
    saveChat: invoke("chats:save"),
    deleteChat: invoke("chats:delete"),
    setStar: invoke("stars:set"),
    sendFeedback: invoke("feedback:send"),
    // AI
    ask: invoke("ai:ask"),
    stop: send("ai:stop"),
    resetChat: send("ai:reset"),
    setHistory: send("ai:set-history"),
    aiStatus: invoke("ai:status"),
    setupState: invoke("setup:state"),
    runSetup: send("setup:run"),
    onSetup: cb => on("setup:update", cb),
    onToken: cb => on("ai:token", cb),
    onNote: cb => on("ai:note", cb),
    onSources: cb => on("ai:sources", cb)
});
