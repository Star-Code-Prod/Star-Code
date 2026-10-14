// Preload: expose a tiny, explicit surface to the renderer.
// Nothing else from Node reaches the page.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  info: () => ipcRenderer.invoke("desktop:info"),
  pickFolder: () => ipcRenderer.invoke("desktop:pick-folder"),
  setRoot: (p) => ipcRenderer.invoke("desktop:set-root", p),
  reveal: (p) => ipcRenderer.invoke("desktop:reveal", p),
  openExternal: (u) => ipcRenderer.invoke("desktop:open-external", u),
  openHtml: (title, html) => ipcRenderer.invoke("desktop:open-html", { title, html }),
  setTheme: (t) => ipcRenderer.invoke("desktop:set-theme", t),
  window: (a) => ipcRenderer.invoke("desktop:window", a),
  checkUpdates: () => ipcRenderer.invoke("desktop:check-updates"),
  updateRun: (arg) => ipcRenderer.invoke("desktop:update-run", arg),
  setGithubToken: (t) => ipcRenderer.invoke("desktop:set-github-token", t),
});
