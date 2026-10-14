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
  // The overlay area (window controls) must follow the app's theme: with
  // themeSource synced from the UI, shouldUseDarkColors is our own setting.
  const dark = nativeTheme.shouldUseDarkColors;
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
    title: "Star Code Desktop",
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
          // eval first, then inspect, then capture, so a script can set up
          // state and the diagnostics can report on it
          if (process.env.CCD_EVAL) {
            const code = fs.readFileSync(process.env.CCD_EVAL, "utf8");
            await win.webContents.executeJavaScript(code);
            await new Promise((r) => setTimeout(r, 900));
            console.log("[main] eval applied");
          }
          if (process.env.CCD_DIAG) {
            const diag = await win.webContents.executeJavaScript(`(() => ({
              hasDesktop: !!window.desktop,
              isElectronClass: document.body.classList.contains("is-electron"),
              theme: document.documentElement.getAttribute("data-theme"),
              projChip: (document.getElementById("sProj")||{}).textContent,
              model: (document.getElementById("cModelName")||{}).textContent,
              lightsHidden: getComputedStyle(document.querySelector(".lights")||document.body).display,
              panels: document.querySelectorAll(".pane").length,
              appVersion: (typeof appVersion !== "undefined") ? appVersion : null,
              updateInfo: (typeof updateInfo !== "undefined") ? updateInfo : null,
              updateBarVisible: !!(document.getElementById("updateBar")||{}).classList?.contains("on"),
              updateBarText: ((document.getElementById("updateBar")||{}).innerText || "").replace(/\\s+/g," ").trim() || null,
              updateStatus: (typeof updateStatusText === "function") ? updateStatusText() : null
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
const REPO_OWNER = "Star-Code-Prod";
const REPO_NAME = "Star-Code";
const RELEASES_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases`;

/** true when a is a strictly higher x.y.z than b */
function semverGt(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return false;
}

/**
 * Look for a newer release without shipping any credential.
 *
 * The repo is private, and an anonymous request to a private repo returns 404,
 * so we cannot distinguish "private" from "no releases" from "offline". All
 * three fall back to a link the user can open in a browser where they are
 * already signed in. If the repo is ever made public this starts reporting
 * versions with no change needed.
 */
async function checkForUpdates() {
  const current = app.getVersion();
  const base = { current, url: RELEASES_URL, repo: `${REPO_OWNER}/${REPO_NAME}` };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Star-Code/" + current,
        },
        signal: AbortSignal.timeout(9000),
      }
    );
    if (res.status === 404) return { ...base, ok: false, reason: "private-or-none" };
    if (res.status === 403) return { ...base, ok: false, reason: "rate-limited" };
    if (!res.ok) return { ...base, ok: false, reason: "http-" + res.status };

    const rel = await res.json();
    const latest = String(rel.tag_name || "").replace(/^v/, "");
    if (!latest) return { ...base, ok: false, reason: "no-tag" };
    return {
      ...base,
      ok: true,
      latest,
      newer: semverGt(latest, current),
      url: rel.html_url || RELEASES_URL,
      published: rel.published_at || null,
      notes: typeof rel.body === "string" ? rel.body.slice(0, 1500) : "",
    };
  } catch (e) {
    return { ...base, ok: false, reason: e.name === "TimeoutError" ? "timeout" : "network" };
  }
}

function wire() {
  ipcMain.handle("desktop:info", () => ({
    platform: process.platform,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome },
    root: serverModule ? serverModule.getRoot() : null,
    appVersion: app.getVersion(),
    url: srv ? srv.url : null,
    releasesUrl: RELEASES_URL,
  }));

  ipcMain.handle("desktop:check-updates", () => checkForUpdates());

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

  // "Open in browser" for artifacts: blob URLs cannot cross the window-open
  // handler, so write the document to a temp file and hand it to the OS.
  ipcMain.handle("desktop:open-html", async (_e, { title, html } = {}) => {
    try {
      const dir = path.join(app.getPath("temp"), "star-code-preview");
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(title || "artifact").replace(/[^a-z0-9\-_]/gi, "_").slice(0, 60) || "artifact";
      const file = path.join(dir, Date.now() + "-" + safe + ".html");
      fs.writeFileSync(file, String(html || ""), "utf8");
      await shell.openPath(file);
      return { ok: true, file };
    } catch (e) {
      return { ok: false, error: e.message };
    }
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
  dialog.showErrorBox("Star Code Desktop - startup failed", detail);
  app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0 && srv) createWindow(srv.url);
});
app.on("window-all-closed", async () => {
  try { if (srv) await srv.close(); } catch {}
  if (process.platform !== "darwin") app.quit();
});
