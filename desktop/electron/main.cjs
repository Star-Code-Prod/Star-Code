// Electron main process.
//
// Runs the agent server in-process (it's plain Node, so no child process and
// no separately installed Node runtime is required), then loads the UI.
// The window uses a hidden title bar so the app's own chrome is the frame.

const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Notification } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawn, execFileSync } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const APP_DIR = path.join(__dirname, "..");
const ICON = path.join(APP_DIR, "assets", "icon.ico");
const ICON_PNG = path.join(APP_DIR, "assets", "icon.png");

// The app is called "Pulse Harness" now, but every existing install keeps its
// settings (window bounds, working directory) under the old product name:
// Electron derives userData from productName, so the rename would silently
// switch the folder and look like data loss. Pin the original directory path
// before anything reads or writes it.
app.setPath("userData", path.join(app.getPath("appData"), "Star Code Desktop"));

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
// The app draws its own window controls in the title bar, so there is no
// native overlay to recolor on a theme change.

function createWindow(url) {
  const s = readStore();
  const isMac = process.platform === "darwin";

  win = new BrowserWindow({
    width: s.width || 1440,
    height: s.height || 900,
    x: s.x, y: s.y,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: "#1b1a18",
    show: false,
    title: "Pulse Harness",
    icon: process.platform === "win32" ? ICON : ICON_PNG,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: isMac ? { x: 16, y: 11 } : undefined,
    titleBarOverlay: isMac ? undefined : false,
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
const REPO_NAME = "Pulse-Harness";
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
/** Check the platform signature when it exists. Returns
 *  { ok, signed } or { ok:false, error }. Unsigned builds are allowed unless
 *  STAR_REQUIRE_SIGNATURE=1. */
function verifyInstallerSignature(file) {
  if (process.platform === "win32") {
    try {
      const status = execFileSync("powershell.exe", ["-NoProfile", "-Command",
        "(Get-AuthenticodeSignature -LiteralPath '" + String(file).replace(/'/g, "''") + "').Status"],
        { encoding: "utf8", timeout: 30000 }).trim();
      if (status === "Valid") return { ok: true, signed: true };
      if (status === "NotSigned") return { ok: true, signed: false };
      return { ok: false, error: "installer signature is " + status };
    } catch { return { ok: true, signed: false }; }
  }
  if (process.platform === "darwin") {
    try {
      execFileSync("codesign", ["--verify", "--deep", "--strict", file], { timeout: 30000 });
      return { ok: true, signed: true };
    } catch {
      return { ok: true, signed: false };
    }
  }
  return { ok: true, signed: false };
}

async function checkForUpdates() {
  const current = app.getVersion();
  const base = { current, url: RELEASES_URL, repo: `${REPO_OWNER}/${REPO_NAME}` };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "Pulse-Harness/" + current,
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
    const assets = Array.isArray(rel.assets) ? rel.assets : [];
    const ymlName = process.platform === "win32" ? "latest.yml"
      : process.platform === "darwin" ? "latest-mac.yml" : "latest-linux.yml";
    const yml = assets.find((a) => a.name === ymlName);
    return {
      ...base,
      ok: true,
      latest,
      newer: semverGt(latest, current),
      url: rel.html_url || RELEASES_URL,
      published: rel.published_at || null,
      notes: typeof rel.body === "string" ? rel.body.slice(0, 1500) : "",
      asset: pickUpdateAsset(assets),
      latestYmlUrl: yml ? yml.url : null,
    };
  } catch (e) {
    return { ...base, ok: false, reason: e.name === "TimeoutError" ? "timeout" : "network" };
  }
}

/** The installer that fits this platform, from a release's asset list. */
function pickUpdateAsset(assets) {
  const find = (re) => assets.find((a) => re.test(a.name));
  if (process.platform === "win32") {
    const setup = find(/Setup.*\.exe$/i);
    if (setup) return { name: setup.name, url: setup.url, kind: "nsis" };
    const portable = find(/portable\.exe$/i);
    if (portable) return { name: portable.name, url: portable.url, kind: "file" };
  } else if (process.platform === "darwin") {
    const dmg = find(/\.dmg$/i);
    if (dmg) return { name: dmg.name, url: dmg.url, kind: "file" };
  } else {
    const appimage = find(/\.AppImage$/i);
    if (appimage) return { name: appimage.name, url: appimage.url, kind: "file" };
  }
  return null;
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

  // One-click update: download the right installer, verify its sha512
  // against latest*.yml, then hand it to the OS. On Windows NSIS it
  // installs silently and relaunches. Fully anonymous - ready for a public
  // release with no tokens or credentials anywhere.
  ipcMain.handle("desktop:update-run", async (_e, { asset, latestYmlUrl } = {}) => {
    try {
      if (!asset || !asset.url) return { ok: false, error: "no installer for this platform in the release" };
      const gh = { "User-Agent": "Pulse-Harness/" + app.getVersion() };
      const res = await fetch(asset.url, {
        headers: { ...gh, Accept: "application/octet-stream" },
        redirect: "follow",
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) return { ok: false, error: "HTTP " + res.status };
      const buf = Buffer.from(await res.arrayBuffer());

      if (latestYmlUrl) {
        try {
          const ymlRes = await fetch(latestYmlUrl, {
            headers: { ...gh, Accept: "application/octet-stream" },
            redirect: "follow",
            signal: AbortSignal.timeout(20000),
          });
          if (!ymlRes.ok) return { ok: false, error: "could not read latest.yml (HTTP " + ymlRes.status + ")" };
          if (ymlRes.ok) {
            const yml = await ymlRes.text();
            const esc = asset.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const m = yml.match(new RegExp(esc + "[\\s\\S]*?sha512:\\s*([A-Za-z0-9+/=]+)"));
            if (!m) return { ok: false, error: "latest.yml has no sha512 for " + asset.name + " - refusing to install" };
            const actual = crypto.createHash("sha512").update(buf).digest("base64");
            if (actual !== m[1]) return { ok: false, error: "sha512 mismatch - download corrupted or tampered with" };
          }
        } catch (e) {
          return { ok: false, error: "could not verify the download: " + e.message };
        }
      }

      const dir = path.join(app.getPath("temp"), "star-code-update");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, asset.name);
      const part = file + ".part";
      fs.writeFileSync(part, buf);
      try { fs.renameSync(part, file); } catch { try { fs.rmSync(part, { force: true }); } catch {} throw new Error("could not stage the installer"); }
      const sig = verifyInstallerSignature(file);
      if (!sig.ok) return { ok: false, error: sig.error };
      if (!sig.signed && process.env.STAR_REQUIRE_SIGNATURE === "1") {
        return { ok: false, error: "installer is unsigned and STAR_REQUIRE_SIGNATURE is set" };
      }
      try {
        fs.writeFileSync(path.join(app.getPath("userData"), "pending-update.json"),
          JSON.stringify({ from: app.getVersion(), asset: asset.name, at: Date.now() }), "utf8");
      } catch { /* non-fatal */ }

      if (process.platform === "win32" && asset.kind === "nsis") {
        const child = spawn(file, ["/S"], { detached: true, stdio: "ignore" });
        child.unref();
        setTimeout(() => app.quit(), 350);
        return { ok: true, launching: true };
      }
      await shell.openPath(file);
      return { ok: true, opened: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

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

  // Attach a file (image or video first, anything else behind "All files"):
  // returns the absolute path, which rides into the message as [attached: …].
  ipcMain.handle("desktop:pick-file", async () => {
    const res = await dialog.showOpenDialog(win, {
      title: "Attach a file",
      defaultPath: serverModule ? serverModule.getRoot() : defaultRoot(),
      properties: ["openFile"],
      buttonLabel: "Attach",
      filters: [
        { name: "Images and videos", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "mp4", "mov", "webm", "mkv", "avi"] },
        { name: "All files", extensions: ["*"] },
      ],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
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

  // "Record" for motion artifacts: the Preview pane captures the canvas and
  // hands us the bytes. The recording belongs to the project, so it goes in
  // the session root's artifacts/ folder - never a caller-chosen path.
  ipcMain.handle("desktop:save-motion", async (_e, args = {}) => {
    try {
      // destructured inside the guard so even a null payload returns {ok:false}
      const { name, ext, bytes } = args || {};
      const kind = String(ext || "").toLowerCase();
      if (kind !== "mp4" && kind !== "webm") {
        return { ok: false, error: "extension must be mp4 or webm" };
      }
      // separators are never part of a file name: reject rather than rewrite
      if (typeof name !== "string" || !name.trim() || /[\\/]/.test(name)) {
        return { ok: false, error: "name must be 1-60 chars of a-z 0-9 . _ -" };
      }
      const safe = name.trim().replace(/[^a-z0-9._-]/gi, "_").replace(/^\.+/, "").slice(0, 60);
      if (!safe) return { ok: false, error: "name must be 1-60 chars of a-z 0-9 . _ -" };

      let buf = null;
      if (bytes instanceof ArrayBuffer) buf = Buffer.from(bytes);
      else if (ArrayBuffer.isView(bytes)) buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      if (!buf || buf.length < 1 || buf.length >= 2 * 1024 * 1024 * 1024) {
        return { ok: false, error: "bytes must be a non-empty buffer under 2 GiB" };
      }

      const root = (serverModule && serverModule.getRoot()) || defaultRoot();
      const dir = path.join(root, "artifacts");
      fs.mkdirSync(dir, { recursive: true });
      let file = path.join(dir, safe + "." + kind);
      if (fs.existsSync(file)) {
        const stamp = Date.now();
        file = path.join(dir, safe + "-" + stamp + "." + kind);
        for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, safe + "-" + stamp + "-" + i + "." + kind);
      }
      fs.writeFileSync(file, buf);
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // "Save" for artifacts: the card writes the self-contained page into the
  // project's artifacts/ folder, where recordings already land — again never
  // a caller-chosen path. Same sanitisation and collision rules as save-motion.
  ipcMain.handle("desktop:save-artifact", async (_e, args = {}) => {
    try {
      const { name, ext, text } = args || {};
      const kind = String(ext || "").toLowerCase();
      if (kind !== "html") {
        return { ok: false, error: "extension must be html" };
      }
      // separators are never part of a file name: reject rather than rewrite
      if (typeof name !== "string" || !name.trim() || /[\\/]/.test(name)) {
        return { ok: false, error: "name must be 1-60 chars of a-z 0-9 . _ -" };
      }
      const safe = name.trim().replace(/[^a-z0-9._-]/gi, "_").replace(/^\.+/, "").slice(0, 60);
      if (!safe) return { ok: false, error: "name must be 1-60 chars of a-z 0-9 . _ -" };

      if (typeof text !== "string" || text.length < 1 || text.length > 8 * 1024 * 1024) {
        return { ok: false, error: "text must be a non-empty string under 8 MiB" };
      }

      const root = (serverModule && serverModule.getRoot()) || defaultRoot();
      const dir = path.join(root, "artifacts");
      fs.mkdirSync(dir, { recursive: true });
      let file = path.join(dir, safe + "." + kind);
      if (fs.existsSync(file)) {
        const stamp = Date.now();
        file = path.join(dir, safe + "-" + stamp + "." + kind);
        for (let i = 1; fs.existsSync(file); i++) file = path.join(dir, safe + "-" + stamp + "-" + i + "." + kind);
      }
      fs.writeFileSync(file, text, "utf8");
      return { ok: true, path: file };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle("desktop:set-theme", (_e, theme) => {
    nativeTheme.themeSource = theme === "light" ? "light" : theme === "dark" ? "dark" : "system";
    return true;
  });

  ipcMain.handle("desktop:notify", (_e, payload = {}) => {
    if (!Notification.isSupported()) return false;
    try {
      new Notification({
        title: String(payload.title || "Pulse Harness").slice(0, 80),
        body: String(payload.body || "").slice(0, 240),
        silent: false,
      }).show();
      return true;
    } catch { return false; }
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

/** `Pulse Harness.exe --pulse-web`: the installed `pulse web` shim starts the
 *  same local server without opening a desktop window. */
async function bootWeb() {
  const args = process.argv.slice(1);
  const value = (name, fallback = "") => {
    const i = args.indexOf(name);
    if (i >= 0 && args[i + 1]) return args[i + 1];
    const eq = args.find((a) => a.startsWith(name + "="));
    return eq ? eq.slice(name.length + 1) : fallback;
  };
  const root = path.resolve(value("--root", defaultRoot()));
  const wanted = Number(value("--port", process.env.PORT || 4180)) || 4180;
  const serverUrl = pathToFileURL(path.join(APP_DIR, "server.js")).href;
  serverModule = await import(serverUrl);
  try {
    srv = await serverModule.startServer({ port: wanted, root, silent: true });
  } catch (e) {
    if (e && e.code === "EADDRINUSE") srv = await serverModule.startServer({ port: 0, root, silent: true });
    else throw e;
  }
  const url = "http://127.0.0.1:" + srv.port;
  console.log("\n  Pulse Harness — web version");
  console.log("  " + url);
  console.log("  root: " + root + "\n");
  if (!args.includes("--no-open")) shell.openExternal(url).catch(() => {});
}

/** If we recorded an update that never reached the new version, say so once. */
async function checkPendingUpdate() {
  const file = path.join(app.getPath("userData"), "pending-update.json");
  try {
    if (!fs.existsSync(file)) return;
    const pending = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.rmSync(file, { force: true });
    if (pending && pending.from === app.getVersion()) {
      await dialog.showMessageBox({
        type: "warning",
        title: "Update did not complete",
        message: "Pulse Harness is still running " + app.getVersion() + ".",
        detail: "The installer " + (pending.asset || "download") + " did not install. Your current version was kept. You can retry from the update banner.",
        buttons: ["OK"],
      });
    }
  } catch { /* best effort */ }
}

const CLI_WEB = process.argv.includes("--pulse-web");

app.whenReady().then(async () => {
  if (CLI_WEB) { await bootWeb(); return; }
  await checkPendingUpdate();
  await boot();
}).catch((e) => {
  const detail = String(e && e.stack ? e.stack : e);
  console.error("[main] startup failed:", detail);
  try { fs.appendFileSync(path.join(app.getPath("userData"), "startup-error.log"), detail + "\n"); } catch {}
  dialog.showErrorBox("Pulse Harness - startup failed", detail);
  app.quit();
});

app.on("activate", () => {
  if (!CLI_WEB && BrowserWindow.getAllWindows().length === 0 && srv) createWindow(srv.url);
});
app.on("window-all-closed", async () => {
  try { if (srv) await srv.close(); } catch {}
  if (process.platform !== "darwin") app.quit();
});
