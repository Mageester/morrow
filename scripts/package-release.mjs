#!/usr/bin/env node
/**
 * Morrow Release Packager (Windows x64).
 *
 * Produces a self-contained, runnable portable package with ONE predictable
 * top-level directory:
 *
 *   Morrow-v<version>-windows-x64/
 *     morrow.cmd                         -> runtime\node.exe morrow.mjs %*
 *     morrow.mjs                         (launcher: start/stop/status/doctor/...)
 *     runtime/node.exe                   (bundled Node, matched ABI for native deps)
 *     orchestrator/dist/src/index.js     (service entrypoint)
 *     orchestrator/node_modules/...      (production deps only, flat npm install)
 *       @morrow/contracts/dist/index.js  (COMPILED workspace dep, never .ts source)
 *     web/index.html                     (web UI assets)
 *     VERSION, CHANNEL, THIRD_PARTY_NOTICES.txt, uninstall.ps1
 *
 * The package contract is asserted (scripts/lib/package-layout.mjs) before the
 * archive is considered complete, so a broken bundle can never be published.
 *
 * Usage: node scripts/package-release.mjs <version> [--skip-build]
 *   version: e.g. 0.1.0-beta.5 (with or without a leading "v")
 *
 * Runtime sourcing: set MORROW_RUNTIME_DIR to an already-extracted
 * node-v<NODE_VERSION>-win-x64 directory to skip the download.
 */

import { execFileSync, execSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertArtifactLayout } from "./lib/package-layout.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const TEMPLATES = join(ROOT, "installer", "templates");

const NODE_VERSION = "22.15.0"; // bundled runtime; native deps are built against this ABI
const PLATFORM = "windows-x64";

const RAW_VERSION = (process.argv[2] || "").replace(/^v/, "");
if (!RAW_VERSION) { console.error("Usage: node scripts/package-release.mjs <version> [--skip-build]"); process.exit(2); }
const SKIP_BUILD = process.argv.includes("--skip-build");

const VERSION = RAW_VERSION;
const PKG_NAME = `Morrow-v${VERSION}-${PLATFORM}`;
const PKG_DIR = join(DIST, PKG_NAME);
const ZIP_PATH = join(DIST, `${PKG_NAME}.zip`);

function sh(cmd, opts = {}) { console.log(`  $ ${cmd}`); return execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts }); }
function ensure(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function sha256(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function ps(script) { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "inherit" }); }

// ── 1. Validate + build ──────────────────────────────────────────────────
if (!SKIP_BUILD) {
  console.log("\n[1/8] Validating and building from source...");
  sh("pnpm check");
  sh("pnpm test");
  sh("pnpm build");
} else {
  console.log("\n[1/8] --skip-build: using existing dist output");
}

// ── 2. Bundled Node runtime ──────────────────────────────────────────────
console.log("\n[2/8] Resolving bundled Node runtime...");
const RUNTIME_DIR = join(PKG_DIR, "runtime");
ensure(DIST);
if (existsSync(PKG_DIR)) rmSync(PKG_DIR, { recursive: true, force: true });
ensure(PKG_DIR);
ensure(RUNTIME_DIR);

const nodeDistName = `node-v${NODE_VERSION}-win-x64`;
let runtimeSource = process.env.MORROW_RUNTIME_DIR;
if (!runtimeSource) {
  const cache = join(DIST, ".runtime-cache");
  ensure(cache);
  const zip = join(cache, `${nodeDistName}.zip`);
  if (!existsSync(zip)) {
    console.log(`  Downloading Node ${NODE_VERSION} (win-x64)...`);
    ps(`Invoke-WebRequest -Uri 'https://nodejs.org/dist/v${NODE_VERSION}/${nodeDistName}.zip' -OutFile '${zip}' -UseBasicParsing`);
    // Verify against the official checksum list.
    const sums = join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
    ps(`Invoke-WebRequest -Uri 'https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt' -OutFile '${sums}' -UseBasicParsing`);
    const expected = readFileSync(sums, "utf8").split("\n").find((l) => l.includes(`${nodeDistName}.zip`))?.trim().split(/\s+/)[0];
    const actual = sha256(zip);
    if (!expected || expected.toLowerCase() !== actual.toLowerCase()) throw new Error(`Node runtime checksum mismatch (expected ${expected}, got ${actual}).`);
  }
  ps(`Expand-Archive -LiteralPath '${zip}' -DestinationPath '${cache}' -Force`);
  runtimeSource = join(cache, nodeDistName);
}
cpSync(runtimeSource, RUNTIME_DIR, { recursive: true });
const BUNDLED_NODE = join(RUNTIME_DIR, "node.exe");
const BUNDLED_NPM = join(RUNTIME_DIR, "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(BUNDLED_NODE)) throw new Error(`Bundled runtime missing node.exe at ${BUNDLED_NODE}`);

// ── 3. Orchestrator dist (runtime files only) ────────────────────────────
console.log("\n[3/8] Bundling orchestrator...");
const orchSrc = join(ROOT, "services", "orchestrator");
const orchDst = join(PKG_DIR, "orchestrator");
ensure(orchDst);
cpSync(join(orchSrc, "dist"), join(orchDst, "dist"), {
  recursive: true,
  filter: (src) => !/[\\/]Morrow-v[^\\/]*[\\/]?/.test(src) && !/[\\/]scripts[\\/].*smoke/i.test(src) && !/\.test\.js$/.test(src),
});
const orchPkg = JSON.parse(readFileSync(join(orchSrc, "package.json"), "utf8"));

// ── 4. Production dependencies (flat npm install, matched ABI) ────────────
console.log("\n[4/8] Installing production dependencies with the bundled runtime...");
// External (non-workspace) production deps only; workspace deps are injected compiled.
const externalDeps = Object.fromEntries(
  Object.entries(orchPkg.dependencies || {}).filter(([name]) => !name.startsWith("@morrow/")),
);
writeFileSync(join(orchDst, "package.json"), JSON.stringify({
  name: orchPkg.name, version: VERSION, private: true, type: "module", dependencies: orchPkg.dependencies,
}, null, 2));
// Install externals into the package's orchestrator dir using the bundled node
// so native modules (better-sqlite3) match the bundled ABI exactly.
const installPkg = join(orchDst, ".install");
ensure(installPkg);
writeFileSync(join(installPkg, "package.json"), JSON.stringify({ name: "morrow-orch-runtime", private: true, type: "module", dependencies: externalDeps }, null, 2));
const npmEnv = { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: "1", Path: `${RUNTIME_DIR};${process.env.Path || process.env.PATH || ""}` };
execFileSync(BUNDLED_NODE, [BUNDLED_NPM, "install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: installPkg, stdio: "inherit", env: npmEnv });
rmSync(join(orchDst, "node_modules"), { recursive: true, force: true });
cpSync(join(installPkg, "node_modules"), join(orchDst, "node_modules"), { recursive: true });
rmSync(installPkg, { recursive: true, force: true });

// Inject compiled workspace deps (never TypeScript source).
for (const dep of Object.keys(orchPkg.dependencies || {}).filter((n) => n.startsWith("@morrow/"))) {
  const short = dep.split("/")[1];
  const pkgSrc = join(ROOT, "packages", short);
  const distSrc = join(pkgSrc, "dist");
  if (!existsSync(join(distSrc, "index.js"))) throw new Error(`Workspace dep ${dep} is not built (missing ${distSrc}/index.js). Run pnpm build.`);
  const depDst = join(orchDst, "node_modules", "@morrow", short);
  rmSync(depDst, { recursive: true, force: true });
  ensure(join(depDst, "dist"));
  cpSync(distSrc, join(depDst, "dist"), { recursive: true });
  const depPkg = JSON.parse(readFileSync(join(pkgSrc, "package.json"), "utf8"));
  writeFileSync(join(depDst, "package.json"), JSON.stringify({
    name: depPkg.name, version: depPkg.version, private: true, type: "module",
    exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
    dependencies: depPkg.dependencies || {},
  }, null, 2));
}

// ── 5. Web app ───────────────────────────────────────────────────────────
console.log("\n[5/8] Bundling web app...");
const webSrc = join(ROOT, "apps", "web", "dist");
if (!existsSync(join(webSrc, "index.html"))) throw new Error("Web app is not built (missing apps/web/dist/index.html).");
cpSync(webSrc, join(PKG_DIR, "web"), { recursive: true });

// ── 6. Launchers + metadata (from versioned templates) ───────────────────
console.log("\n[6/8] Writing launchers and metadata...");
cpSync(join(TEMPLATES, "morrow.mjs"), join(PKG_DIR, "morrow.mjs"));
cpSync(join(TEMPLATES, "morrow.cmd"), join(PKG_DIR, "morrow.cmd"));
cpSync(join(TEMPLATES, "uninstall.ps1"), join(PKG_DIR, "uninstall.ps1"));
writeFileSync(join(PKG_DIR, "VERSION"), VERSION);
writeFileSync(join(PKG_DIR, "CHANNEL"), "beta");
const notices = join(ROOT, "THIRD_PARTY_NOTICES.txt");
writeFileSync(join(PKG_DIR, "THIRD_PARTY_NOTICES.txt"), existsSync(notices) ? readFileSync(notices, "utf8") : "Morrow bundles Node.js and third-party npm dependencies under their respective licenses.\n");

// ── 7. Archive ───────────────────────────────────────────────────────────
console.log("\n[7/8] Creating archive...");
if (existsSync(ZIP_PATH)) rmSync(ZIP_PATH, { force: true });
ps(`Compress-Archive -Path '${PKG_DIR}' -DestinationPath '${ZIP_PATH}' -CompressionLevel Optimal -Force`);

// ── 8. Validate contract, checksums, manifest ────────────────────────────
console.log("\n[8/8] Validating package contract and writing manifest...");
const layout = assertArtifactLayout(ZIP_PATH);
console.log(`  Contract OK: single top-level dir, ${layout.entryCount} entries.`);

const hash = sha256(ZIP_PATH);
const size = readFileSync(ZIP_PATH).length;
writeFileSync(join(DIST, `morrow-v${VERSION}-checksums.txt`), `${hash}  ${PKG_NAME}.zip\n`);

const manifest = {
  schemaVersion: 1,
  version: VERSION,
  channel: "beta",
  publishedAt: new Date().toISOString(),
  unsignedBeta: true,
  bundledNodeVersion: NODE_VERSION,
  minimumWindowsVersion: "10",
  releaseNotes: `https://github.com/Mageester/morrow/releases/tag/v${VERSION}`,
  artifacts: [{
    platform: PLATFORM,
    filename: `${PKG_NAME}.zip`,
    url: `https://github.com/Mageester/morrow/releases/download/v${VERSION}/${PKG_NAME}.zip`,
    size,
    sha256: hash,
  }],
};
writeFileSync(join(DIST, "latest.json"), JSON.stringify(manifest, null, 2));
// GitHub's release download URL and the landing page use this canonical name;
// keep latest.json for the existing installer/CDN contract.
writeFileSync(join(DIST, "release-manifest.json"), JSON.stringify(manifest, null, 2));

console.log("\n✓ Release package complete.");
console.log(`  Archive:   ${ZIP_PATH}`);
console.log(`  Size:      ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  SHA-256:   ${hash}`);
console.log(`  Manifest:  ${join(DIST, "latest.json")}`);
