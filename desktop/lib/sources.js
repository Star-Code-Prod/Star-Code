// Official-source classifier: decides how much a URL's host can be trusted
// BEFORE any bytes are fetched. Pure functions, no network, zero dependencies.
//
// Tiers:
//   local     - loopback / LAN / dev hosts (hostname suffixes and IP ranges)
//   official  - curated vendor domains, matched on the exact host or a
//               dot-boundary subdomain (download.nodejs.org ✓ but
//               evilnodejs.org ✗ and nodejs.org.evil.com ✗)
//   codehost  - hosts where source code and packages live (GitHub, npm, PyPI,
//               crates.io, RubyGems) - checked before official so that
//               files.pythonhosted.org counts as a package host
//   unknown   - everything else; the agent must ask the user, naming the host
//
// Keep this catalog honest: a wrong "official" entry is worse than a missing
// one - it would bless a look-alike site. Only add a domain when you are
// certain it belongs to the vendor (redirects to the vendor count; mirrors,
// CDNs and "download portals" do not).

export const LOCAL_SUFFIXES = ["localhost", "local", "internal", "test", "lan"];

/** Curated host catalog: [domain, label]. Matching is dot-boundary safe. */
export const SOURCE_CATALOG = {
  official: [
    ["nodejs.org", "Node.js"],
    ["python.org", "Python"],
    ["pythonhosted.org", "Python package hosting"],
    ["git-scm.com", "Git"],
    ["gitforwindows.org", "Git for Windows"],
    ["go.dev", "Go"],
    ["golang.org", "Go"],
    ["rust-lang.org", "Rust"],
    ["rustup.rs", "Rust toolchain installer"],
    ["static.rust-lang.org", "Rust downloads"],
    ["dotnet.microsoft.com", ".NET"],
    ["microsoft.com", "Microsoft"],
    ["microsoftedge.microsoft.com", "Microsoft Edge"],
    ["code.visualstudio.com", "Visual Studio Code"],
    ["visualstudio.com", "Visual Studio"],
    ["java.com", "Java"],
    ["oracle.com", "Oracle"],
    ["adoptium.net", "Eclipse Temurin (OpenJDK)"],
    ["eclipse.org", "Eclipse Foundation"],
    ["apache.org", "Apache Software Foundation"],
    ["nginx.org", "nginx"],
    ["mariadb.org", "MariaDB"],
    ["mysql.com", "MySQL"],
    ["postgresql.org", "PostgreSQL"],
    ["mongodb.com", "MongoDB"],
    ["mongodb.org", "MongoDB downloads"],
    ["redis.io", "Redis"],
    ["sqlite.org", "SQLite"],
    ["php.net", "PHP"],
    ["getcomposer.org", "Composer"],
    ["jetbrains.com", "JetBrains"],
    ["docker.com", "Docker"],
    ["blender.org", "Blender"],
    ["godotengine.org", "Godot"],
    ["unity.com", "Unity"],
    ["unity3d.com", "Unity"],
    ["unrealengine.com", "Unreal Engine"],
    ["epicgames.com", "Epic Games"],
    ["store.steampowered.com", "Steam store"],
    ["fivem.net", "FiveM"],
    ["cfx.re", "Cfx.re (FiveM/RedM)"],
    ["forum.cfx.re", "Cfx.re forums"],
    ["runtime.fivem.net", "FiveM runtime artifacts"],
    ["keymaster.fivem.net", "FiveM keymaster"],
    ["rockstargames.com", "Rockstar Games"],
    ["cmake.org", "CMake"],
    ["mingw-w64.org", "MinGW-w64"],
    ["msys2.org", "MSYS2"],
    ["cygwin.com", "Cygwin"],
    ["7-zip.org", "7-Zip"],
    ["videolan.org", "VideoLAN (VLC)"],
    ["notepad-plus-plus.org", "Notepad++"],
    ["sublime.com", "Sublime Text"],
    ["sublimetext.com", "Sublime Text"],
    ["firefox.com", "Firefox"],
    ["mozilla.org", "Mozilla"],
    ["google.com", "Google (Chrome, Go downloads)"],
    ["electronjs.org", "Electron"],
    ["openssl.org", "OpenSSL"],
    ["curl.se", "curl"],
    ["gnupg.org", "GnuPG"],
    ["kernel.org", "Linux kernel"],
    ["ubuntu.com", "Ubuntu"],
    ["debian.org", "Debian"],
    ["fedoraproject.org", "Fedora"],
    ["archlinux.org", "Arch Linux"],
    ["libreoffice.org", "LibreOffice"],
    ["wireshark.org", "Wireshark"],
    ["nmap.org", "Nmap"],
    ["qt.io", "Qt"],
    ["virtualbox.org", "Oracle VirtualBox"],
    ["vagrantup.com", "Vagrant"],
    ["hashicorp.com", "HashiCorp"],
    ["flutter.dev", "Flutter"],
    ["dart.dev", "Dart"],
    ["deno.land", "Deno"],
    ["deno.com", "Deno"],
    ["bun.sh", "Bun"],
    ["yarnpkg.com", "Yarn"],
    ["pnpm.io", "pnpm"],
    ["nvm.sh", "nvm"],
    ["ruby-lang.org", "Ruby"],
    ["perl.org", "Perl"],
    ["julialang.org", "Julia"],
    ["r-project.org", "R"],
    ["swift.org", "Swift"],
    ["kotlinlang.org", "Kotlin"],
  ],
  codehost: [
    ["github.com", "GitHub"],
    ["raw.githubusercontent.com", "GitHub raw content"],
    ["objects.githubusercontent.com", "GitHub release assets"],
    ["release-assets.githubusercontent.com", "GitHub release assets"],
    ["codeload.github.com", "GitHub codeload"],
    ["gitlab.com", "GitLab"],
    ["bitbucket.org", "Bitbucket"],
    ["npmjs.com", "npm"],
    ["npmjs.org", "npm registry"],
    ["registry.npmjs.org", "npm registry"],
    ["pypi.org", "PyPI"],
    ["files.pythonhosted.org", "PyPI files"],
    ["crates.io", "crates.io"],
    ["rubygems.org", "RubyGems"],
  ],
};

// Longest domains first so the most specific entry supplies the label
// (release-assets.githubusercontent.com wins over github.com).
const sorted = (list) => [...list].sort((a, b) => b[0].length - a[0].length);
const TABLES = {
  codehost: sorted(SOURCE_CATALOG.codehost),
  official: sorted(SOURCE_CATALOG.official),
};

/** Strip brackets from IPv6 literals, trailing root dots, and be defensive. */
function normalizeHost(host) {
  let h = String(host || "").toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  h = h.replace(/\.+$/, "");
  return h;
}

function isPrivateIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b, c, d] = m.slice(1).map(Number);
  if ([a, b, c, d].some((n) => n > 255)) return false;
  if (a === 127) return true;                               // 127.0.0.0/8
  if (a === 10) return true;                                // 10.0.0.0/8
  if (a === 192 && b === 168) return true;                  // 192.168.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return true;         // 172.16.0.0/12
  return false;
}

function isLocalHost(host) {
  if (!host) return false;
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (isPrivateIpv4(host)) return true;
  return LOCAL_SUFFIXES.some((s) => host === s || host.endsWith("." + s));
}

/** Exact host or dot-boundary subdomain only: no suffix trickery. */
function matchTable(host, table) {
  for (const [domain, label] of table) {
    if (host === domain || host.endsWith("." + domain)) return label;
  }
  return null;
}

/**
 * Classify a URL by its hostname.
 * @returns {{tier: "local"|"official"|"codehost"|"unknown", host: string, label: string}}
 */
export function classifySource(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return { tier: "unknown", host: "", label: "not a known official source" };
  }
  const host = normalizeHost(parsed.hostname);
  if (!host) return { tier: "unknown", host, label: "not a known official source" };
  if (isLocalHost(host)) return { tier: "local", host, label: "local host" };
  const code = matchTable(host, TABLES.codehost);
  if (code) return { tier: "codehost", host, label: code };
  const official = matchTable(host, TABLES.official);
  if (official) return { tier: "official", host, label: official };
  return { tier: "unknown", host, label: "not a known official source" };
}
