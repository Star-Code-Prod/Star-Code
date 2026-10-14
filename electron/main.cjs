// Electron main process.
//
// Runs the agent server in-process (it's plain Node, so no child process and
// no separately installed Node runtime is required), then loads the UI.
// The window uses a hidden title bar so the app's own chrome is the frame.

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const APP_DIR = path.join(__dirname, "..");
const ICON = path.join(APP_DIR, "assets", "icon.ico");
const ICON_PNG = path.join(APP_DIR, "assets", "icon.png");

let win = null;
let srv = null;
let serverModule = null;

/* ------------------------------ preferences ------------------------------ */
const storePath = () => path.join(app.getPath("userData"), "desktop.json");
function readStore() {
  try { return JSON.parse(fs.readFileSync(storePath(), "utf8")); } catch { return {}; }
}
function writeStore(patch) {
  const next = Object.assign(readStore(), patch);
  try {
    fs.mkdirSync(path.dirname(storePath()), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(next, null, 2));
  } catch {}
  return next;
}

function defaultRoot() {
  const s = readStore();
  if (s.root && fs.existsSync(s.root)) return s.root;
  // start somewhere useful rather than inside the app bundle
  const docs = app.getPath("documents");
  return fs.existsSync(docs) ? docs : app.getPath("home");
}

/* -------------------------------- window --------------------------------- */
function titlebarColors() {
  const dark = !nativeTheme.shouldUseDarkColors;
  return dark
    ? { color: "#1a1a1a", symbolColor: "#b9b9b5" }
    : { color: "#faf9f5", symbolColor: "#55534c" };
}

// Registered once, not per-window, so repeated `activate` calls can't stack listeners.
nativeTheme.on("updated", () => {
  if (win && !win.isDestroyed() && process.platform !== "darwin") {
    try { win.setTitleBarOverlay({ ...titlebarColors(), height: 46 }); } catch {}
  }
});

function createWindow(url) {
  const s = readStore();
  const c = titlebarColors();
  const isMac = process.platform === "darwin";

  win = new BrowserWindow({
    width: s.width || 1440,
    height: s.height || 900,
    x: s.x, y: s.y,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#1a1a1a",
    show: false,
    title: "Star Code",
    icon: process.platform === "win32" ? ICON : ICON_PNG,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: isMac ? { x: 16, y: 15 } : undefined,
    titleBarOverlay: isMac ? undefined : { ...c, height: 46 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  win.loadURL(url);
  win.once("ready-to-show", () => win.show());

  const saveBounds = () => {
    if (!win || win.isDestroyed() || win.isMinimized()) return;
    const b = win.getBounds();
    writeStore({ width: b.width, height: b.height, x: b.x, y: b.y });
  };
  win.on("resize", saveBounds);
  win.on("move", saveBounds);

  // external links go to the real browser, never a new Electron window
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, u) => {
    if (!srv || !u.startsWith(srv.url)) {
      e.preventDefault();
      if (/^https?:/i.test(u)) shell.openExternal(u);
    }
  });

  win.on("closed", () => { win = null; });

  // Diagnostics: CCD_SHOT=<path> renders the window to a PNG and exits.
  // CCD_DIAG=<path> dumps renderer state, and always captures console output.
  // Used by tools/screenshot.ps1 to verify the UI without needing window focus.
  if (process.env.CCD_SHOT || process.env.CCD_DIAG) {
    win.webContents.on("console-message", (_e, level, message, line, source) => {
      console.log("[renderer:" + level + "] " + message + (source ? " (" + source + ":" + line + ")" : ""));
    });
    win.webContents.once("did-finish-load", () => {
      setTimeout(async () => {
        try {
          if (process.env.CCD_DIAG) {
            const diag = await win.webContents.executeJavaScript(`(() => ({
              hasDesktop: !!window.desktop,
              desktopKeys: window.desktop ? Object.keys(window.desktop) : [],
              isElectronClass: document.body.classList.contains("is-electron"),
              isMacClass: document.body.classList.contains("is-mac"),
              theme: document.documentElement.getAttribute("data-theme"),
              projChip: (document.getElementById("sProj")||{}).textContent,
              bigProj: (document.getElementById("bigProjName")||{}).textContent,
              model: (document.getElementById("cModelName")||{}).textContent,
              lightsHidden: getComputedStyle(document.querySelector(".lights")||document.body).display,
              panels: document.querySelectorAll(".pane").length,
              rules: document.styleSheets.length
            }))()`);
            fs.writeFileSync(process.env.CCD_DIAG, JSON.stringify(diag, null, 2));
            console.log("[main] diag written");
          }
          if (process.env.CCD_SHOT) {
            const img = await win.webContents.capturePage();
            fs.writeFileSync(process.env.CCD_SHOT, img.toPNG());
            console.log("[main] captured to " + process.env.CCD_SHOT);
          }
        } catch (e) {
          console.error("[main] capture failed:", e.message);
        }
        app.quit();
      }, Number(process.env.CCD_SHOT_DELAY || 3500));
    });
  }

  return win;
}

/* --------------------------------- IPC ----------------------------------- */
function wire() {
  ipcMain.handle("desktop:info", () => ({
    platform: process.platform,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    root: serverModule ? serverModule.getRoot() : null,
    appVersion: app.getVersion(),
    url: srv ? srv.url : null,
  }));

  ipcMain.handle("desktop:pick-folder", async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "Choose a working directory",
      defaultPath: serverModule ? serverModule.getRoot() : defaultRoot(),
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: "Use this folder",
    });
    if (res.canceled || !res.filePaths.length) return null;
    const picked = res.filePaths[0];
    serverModule.setRoot(picked);
    writeStore({ root: picked });
    return picked;
  });

  ipcMain.handle("desktop:set-root", (_e, p) => {
    if (!p || !fs.existsSync(p) || !fs.statSync(p).isDirectory()) {
      return { ok: false, error: "Not a folder: " + p };
    }
    serverModule.setRoot(p);
    writeStore({ root: p });
    return { ok: true, root: serverModule.getRoot() };
  });

  ipcMain.handle("desktop:reveal", (_e, p) => {
    const target = p || (serverModule && serverModule.getRoot());
    if (target && fs.existsSync(target)) shell.showItemInFolder(target);
    return true;
  });

  ipcMain.handle("desktop:open-external", (_e, u) => {
    if (/^https?:/i.test(u)) shell.openExternal(u);
    return true;
  });

  ipcMain.handle("desktop:set-theme", (_e, theme) => {
    nativeTheme.themeSource = theme === "light" ? "light" : theme === "dark" ? "dark" : "system";
    return true;
  });

  ipcMain.handle("desktop:window", (_e, action) => {
    if (!win) return false;
    if (action === "minimize") win.minimize();
    else if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === "close") win.close();
    return true;
  });
}

/* --------------------------------- boot ---------------------------------- */
async function boot() {
  // ESM needs a file:// URL — a bare "C:\..." path is read as a URL scheme.
  const serverUrl = pathToFileURL(path.join(APP_DIR, "server.js")).href;
  serverModule = await import(serverUrl);
  srv = await serverModule.startServer({ port: 0, root: defaultRoot(), silent: true });
  console.log("[main] agent server on " + srv.url);
  wire();
  createWindow(srv.url);
}

app.whenReady().then(boot).catch((e) => {
  const detail = String(e && e.stack ? e.stack : e);
  console.error("[main] startup failed:", detail);
  try { fs.appendFileSync(path.join(app.getPath("userData"), "startup-error.log"), detail + "\n"); } catch {}
  dialog.showErrorBox("Star Code — startup failed", detail);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && srv) createWindow(srv.url);
});
app.on("window-all-closed", async () => {
  try { if (srv) await srv.close(); } catch {}
  if (process.platform !== "darwin") app.quit();
});
