// Build a standalone executable of the CLI with Bun: one file, no Node, no
// install step. Used by CI for the release asset Star-Code-CLI-<version>.exe.
//
//   node build-exe.mjs                          # host platform default target
//   node build-exe.mjs --target bun-windows-x64 # cross-compile (CI runs this)
//   node build-exe.mjs --bun /path/to/bun       # pick a bun binary
//
// The --define folds the version into the bundle, so the binary does not need
// the package.json that sits next to the source in an npm install.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(here, "package.json"), "utf8")).version;

const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};
const target = argOf("--target", "");
const bun = argOf("--bun", "bun");
const name = argOf("--name", "Star-Code-CLI-" + version);
const out = path.join(here, name + ".exe");

const cmd = [
  "build", "--compile",
  ...(target ? ["--target", target] : []),
  "--define", "process.env.STAR_CODE_VERSION=" + JSON.stringify(version),
  path.join(here, "bin", "star-code.mjs"),
  "--outfile", out,
];

execFileSync(bun, cmd, { stdio: "inherit", cwd: here });

const size = fs.statSync(out).size;
if (size < 10 * 1024 * 1024) {
  console.error("FAILED: " + path.basename(out) + " is only " + size + " bytes - the bundle did not embed (expected tens of MB)");
  process.exit(1);
}
console.log("built " + path.basename(out) + " (" + (size / 1024 / 1024).toFixed(1) + " MB)");
