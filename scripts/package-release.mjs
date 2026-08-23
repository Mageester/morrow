#!/usr/bin/env node
/**
 * Morrow Release Packager (native Windows, Linux, or macOS).
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
 *     VERSION, CHANNEL, THIRD_PARTY_NOTICES.txt, uninstall.ps1
 *
 * The package contract is asserted (scripts/lib/package-layout.mjs) before the
 * archive is considered complete, so a broken bundle can never be published.
 *
 * Usage: node scripts/package-release.mjs <version> [--skip-build]
 *   version: e.g. 0.1.0-beta.5 (with or without a leading "v")
 *
 * Runtime sourcing: set MORROW_RUNTIME_DIR to an already-extracted native
 * node-v<NODE_VERSION>-<os>-<arch> directory to skip the download.
 */

import { execFileSync, execSync } from "node:child_process";
import {
  cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assertArtifactLayout } from "./lib/package-layout.mjs";
import { buildProvenance, computePackageManifestHash, writeProvenance } from "./lib/package-provenance.mjs";
import { BUNDLED_NODE_VERSION, artifactFilename } from "./lib/release-artifacts.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const DIST = join(ROOT, "dist");
const TEMPLATES = join(ROOT, "installer", "templates");

const NODE_VERSION = BUNDLED_NODE_VERSION; // bundled runtime; native deps are built against this ABI
const OS = process.platform === "win32" ? "windows" : process.platform;
const ARCH = process.arch;
if (!['windows', 'linux', 'darwin'].includes(OS) || !['x64', 'arm64'].includes(ARCH)) {
  throw new Error(`Unsupported packaging host: ${process.platform}-${process.arch}`);
}
if (OS === "windows" && ARCH !== "x64") throw new Error("Windows arm64 packages are not supported yet.");
const PLATFORM = `${OS}-${ARCH}`;
const IS_WINDOWS = OS === "windows";

const RAW_VERSION = (process.argv[2] || "").replace(/^v/, "");
if (!RAW_VERSION) { console.error("Usage: node scripts/package-release.mjs <version> [--skip-build]"); process.exit(2); }
const SKIP_BUILD = process.argv.includes("--skip-build");

const VERSION = RAW_VERSION;
const PKG_NAME = `Morrow-v${VERSION}-${PLATFORM}`;
const PKG_DIR = join(DIST, PKG_NAME);
const ARTIFACT_FILENAME = artifactFilename(VERSION, PLATFORM);
const ARTIFACT_PATH = join(DIST, ARTIFACT_FILENAME);

function sh(cmd, opts = {}) { console.log(`  $ ${cmd}`); return execSync(cmd, { stdio: "inherit", cwd: ROOT, ...opts }); }
function ensure(dir) { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); }
function sha256(file) { return createHash("sha256").update(readFileSync(file)).digest("hex"); }
function ps(script) { return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { stdio: "inherit" }); }
function download(url, destination) {
  if (IS_WINDOWS) {
    ps(`Invoke-WebRequest -Uri '${url}' -OutFile '${destination}' -UseBasicParsing`);
  } else {
    execFileSync("curl", ["--fail", "--silent", "--show-error", "--location", url, "--output", destination], { stdio: "inherit" });
  }
}

// ── 0. Capture build provenance from the current worktree ────────────────
// Captured before the build runs, so it reflects the exact commit and dirty
// state this invocation started from, independent of anything the build
// itself might touch (dist/ output is not part of the provenance surface).
console.log("\n[0/8] Capturing build provenance...");
let sourceCommit = null;
let dirty = true;
try {
  sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) sourceCommit = null;
  const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: ROOT, encoding: "utf8" });
  dirty = status.trim().length > 0;
} catch {
  sourceCommit = null;
  dirty = true;
}
console.log(`  commit=${sourceCommit ?? "unknown"} dirty=${dirty}`);

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

const nodeOs = OS === "windows" ? "win" : OS;
const nodeDistName = `node-v${NODE_VERSION}-${nodeOs}-${ARCH}`;
let runtimeSource = process.env.MORROW_RUNTIME_DIR;
if (!runtimeSource) {
  const cache = join(DIST, ".runtime-cache");
  ensure(cache);
  const runtimeExtension = IS_WINDOWS ? "zip" : "tar.gz";
  const runtimeArchive = join(cache, `${nodeDistName}.${runtimeExtension}`);
  if (!existsSync(runtimeArchive)) {
    console.log(`  Downloading Node ${NODE_VERSION} (${nodeOs}-${ARCH})...`);
    download(`https://nodejs.org/dist/v${NODE_VERSION}/${nodeDistName}.${runtimeExtension}`, runtimeArchive);
    // Verify against the official checksum list.
    const sums = join(cache, `SHASUMS256-${NODE_VERSION}.txt`);
    download(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, sums);
    const expected = readFileSync(sums, "utf8").split("\n").find((line) => line.trim().endsWith(`${nodeDistName}.${runtimeExtension}`))?.trim().split(/\s+/)[0];
    const actual = sha256(runtimeArchive);
    if (!expected || expected.toLowerCase() !== actual.toLowerCase()) throw new Error(`Node runtime checksum mismatch (expected ${expected}, got ${actual}).`);
  }
  if (IS_WINDOWS) ps(`Expand-Archive -LiteralPath '${runtimeArchive}' -DestinationPath '${cache}' -Force`);
  else execFileSync("tar", ["-xzf", runtimeArchive, "-C", cache], { stdio: "inherit" });
  runtimeSource = join(cache, nodeDistName);
}
cpSync(runtimeSource, RUNTIME_DIR, { recursive: true });
const BUNDLED_NODE = join(RUNTIME_DIR, IS_WINDOWS ? "node.exe" : "bin", ...(IS_WINDOWS ? [] : ["node"]));
const BUNDLED_NPM = IS_WINDOWS
  ? join(RUNTIME_DIR, "node_modules", "npm", "bin", "npm-cli.js")
  : join(RUNTIME_DIR, "lib", "node_modules", "npm", "bin", "npm-cli.js");
if (!existsSync(BUNDLED_NODE)) throw new Error(`Bundled runtime missing Node executable at ${BUNDLED_NODE}`);

// ── 3. Orchestrator dist (runtime files only) ────────────────────────────
console.log("\n[3/8] Bundling orchestrator...");
const orchSrc = join(ROOT, "services", "orchestrator");
const orchDst = join(PKG_DIR, "orchestrator");
ensure(orchDst);
cpSync(join(orchSrc, "dist"), join(orchDst, "dist"), {
  recursive: true,
  // Never ship compiled dev tooling: the entire dist/scripts subtree (smoke
  // suites, acceptance harnesses like todo-app-*, one-off proofs) is build-time
  // only. Also drop any stray nested package dir and compiled test files.
  filter: (src) => !/[\\/]Morrow-v[^\\/]*[\\/]?/.test(src) && !/[\\/]dist[\\/]scripts[\\/]/.test(src) && !/[\\/]scripts$/.test(src) && !/\.test\.js$/.test(src),
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
// Force prebuild-install (better-sqlite3) to fetch the binary for the BUNDLED
// Node ABI, not the host's. Without this, building on a runner whose Node ABI
// differs from the bundled runtime (e.g. Node 22 host packaging a Node 24
// runtime) bundles a native module that fails to load at startup with
// NODE_MODULE_VERSION mismatch. Targeting the bundled version makes the result
// independent of whatever Node the build host happens to use.
const npmEnv = {
  ...process.env,
  PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
  PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS: "1",
  npm_config_runtime: "node",
  npm_config_target: NODE_VERSION,
  npm_config_arch: ARCH,
  npm_config_target_arch: ARCH,
  ...(IS_WINDOWS
    ? { Path: `${RUNTIME_DIR};${process.env.Path || process.env.PATH || ""}` }
    : { PATH: `${join(RUNTIME_DIR, "bin")}:${process.env.PATH || ""}` }),
};
execFileSync(BUNDLED_NODE, [BUNDLED_NPM, "install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: installPkg, stdio: "inherit", env: npmEnv });
rmSync(join(orchDst, "node_modules"), { recursive: true, force: true });
cpSync(join(installPkg, "node_modules"), join(orchDst, "node_modules"), { recursive: true });
rmSync(installPkg, { recursive: true, force: true });

// Hard gate: load the bundled native module with the bundled runtime. This
// turns a startup-time NODE_MODULE_VERSION crash into a build-time failure, so
// an ABI-mismatched package can never be archived or published.
console.log("  Verifying better-sqlite3 loads under the bundled runtime...");
const sqliteProbe = "const D=require('better-sqlite3');const db=new D(':memory:');db.prepare('select 1 as ok').get();db.close();console.log('better-sqlite3 OK');";
try {
  execFileSync(BUNDLED_NODE, ["-e", sqliteProbe], { cwd: orchDst, stdio: "inherit" });
} catch {
  throw new Error(`Bundled better-sqlite3 failed to load under Node ${NODE_VERSION}. The native ABI does not match the bundled runtime.`);
}

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

// ── 4b. Bundled CLI (product surface for the installed launcher) ──────────
// The packaged launcher delegates every non-lifecycle command (ask/fix/plan/
// yolo/mission/new/symbols/processes/worktrees/integrate/projects/chat/...) to
// this CLI, so the installed `morrow` exposes the SAME surface as development.
//
// The CLI is compiled to plain JS and placed UNDER orchestrator/ so its
// `@morrow/*` and runtime dependencies resolve from the orchestrator's flat
// node_modules with no extra path wiring. We inject the two workspace deps the
// orchestrator install does not already provide: `@morrow/orchestrator` itself
// (pointed at its compiled lib) and `@morrow/hermes-compat`.
console.log("\n[4b/8] Compiling and bundling the CLI...");
const cliSrc = join(ROOT, "apps", "cli");
const cliDst = join(orchDst, "cli");
rmSync(cliDst, { recursive: true, force: true });
ensure(cliDst);
// Compile TS → JS (source only; tests are excluded via a temporary tsconfig).
const cliBuildTsconfig = join(cliSrc, "tsconfig.pkg.json");
writeFileSync(cliBuildTsconfig, JSON.stringify({
  extends: "./tsconfig.json",
  compilerOptions: { noEmit: false, declaration: false, sourceMap: false, incremental: false, outDir: join(cliDst, "src").replace(/\\/g, "/") },
  include: ["src"],
}, null, 2));
try {
  const tsc = join(cliSrc, "node_modules", "typescript", "bin", "tsc");
  if (!existsSync(tsc)) throw new Error(`CLI TypeScript compiler is missing: ${tsc}. Run pnpm install.`);
  execFileSync(process.execPath, [tsc, "-p", cliBuildTsconfig], { cwd: cliSrc, stdio: "inherit" });
} finally {
  rmSync(cliBuildTsconfig, { force: true });
}
if (!existsSync(join(cliDst, "src", "main.js"))) throw new Error("CLI did not compile (missing cli/src/main.js).");
// Plain-node launcher for the compiled CLI (no tsx; the source is already JS).
ensure(join(cliDst, "bin"));
writeFileSync(join(cliDst, "bin", "morrow.mjs"), [
  "#!/usr/bin/env node",
  'import { fileURLToPath, pathToFileURL } from "node:url";',
  'import { dirname, resolve } from "node:path";',
  'if (process.argv.includes("--version") || process.argv.includes("-v")) { process.stdout.write("' + VERSION + '\\n"); process.exit(0); }',
  'const here = dirname(fileURLToPath(import.meta.url));',
  'const { run } = await import(pathToFileURL(resolve(here, "../src/main.js")).href);',
  'const code = await run(process.argv.slice(2));',
  'if (typeof code === "number" && code !== 0) process.exitCode = code;',
  "",
].join("\n"));
// Where each injected workspace dep's source package.json lives, so its export
// surface can be mirrored rather than guessed.
const sourceRootOf = (dep) => dep === "orchestrator"
  ? join(ROOT, "services", "orchestrator")
  : join(ROOT, "packages", dep);

// Inject the workspace deps the CLI needs that orchestrator's install lacks.
for (const [dep, distSrc, main] of [
  ["orchestrator", join(orchSrc, "dist"), "src/lib.js"],
  ["hermes-compat", join(ROOT, "packages", "hermes-compat", "dist"), "index.js"],
]) {
  if (!existsSync(join(distSrc, main))) throw new Error(`Workspace dep @morrow/${dep} is not built (missing ${join(distSrc, main)}). Run pnpm build.`);
  const depDst = join(orchDst, "node_modules", "@morrow", dep);
  rmSync(depDst, { recursive: true, force: true });
  ensure(depDst);
  // Same exclusion as the primary orchestrator/dist copy: never ship compiled
  // dev/smoke/acceptance scripts (dist/scripts) or test files inside the
  // injected workspace dependency either.
  cpSync(distSrc, join(depDst, "dist"), {
    recursive: true,
    filter: (src) => !/[\\/]scripts$/.test(src) && !/[\\/]dist[\\/]scripts[\\/]/.test(src) && !/\.test\.js$/.test(src),
  });
  // Mirror the real package's export surface rather than restating a fixed
  // one. This was `{ ".", "./lib" }` hardcoded, so the moment the CLI imported
  // a new subpath — `@morrow/orchestrator/home`, added to keep the whole agent
  // runtime out of every `morrow` invocation — the bundled CLI could not
  // resolve it and the packaged build died. A hand-maintained copy of another
  // file's exports map is a bug with a delay on it.
  const sourceManifest = JSON.parse(readFileSync(join(sourceRootOf(dep), "package.json"), "utf8"));
  const sourceExports = typeof sourceManifest.exports === "string"
    ? { ".": sourceManifest.exports }
    : (sourceManifest.exports ?? {});
  const builtExports = {};
  for (const [key, value] of Object.entries(sourceExports)) {
    const target = typeof value === "string" ? value : (value?.import ?? value?.default);
    if (typeof target !== "string") continue;
    // The built layout differs per package (orchestrator keeps `src/`,
    // hermes-compat flattens it), so resolve by asking which candidate the
    // build actually produced instead of assuming either convention.
    const relative = target.replace(/^\.\//, "").replace(/\.tsx?$/, ".js");
    const candidates = [relative, relative.replace(/^src\//, "")];
    const found = candidates.find((candidate) => existsSync(join(distSrc, candidate)));
    if (found) builtExports[key] = `./dist/${found}`;
  }
  // "." must always resolve; fall back to the known-good main if the source
  // manifest is shaped unexpectedly.
  if (!builtExports["."]) builtExports["."] = `./dist/${main}`;
  writeFileSync(join(depDst, "package.json"), JSON.stringify({
    name: `@morrow/${dep}`, version: VERSION, private: true, type: "module",
    exports: builtExports,
  }, null, 2));
}
// Hard gate: the compiled CLI must load and route under the bundled runtime,
// resolving @morrow/* + native deps from the co-located node_modules. This turns
// a broken-bundle regression into a build-time failure.
console.log("  Verifying the bundled CLI loads under the bundled runtime...");
try {
  execFileSync(BUNDLED_NODE, [join(cliDst, "bin", "morrow.mjs"), "--help"], { cwd: orchDst, stdio: "ignore", env: { ...process.env, MORROW_NO_AUTOSTART: "1" } });
} catch {
  throw new Error("The bundled CLI failed to run under the bundled runtime.");
}

// ── 4c. Bundled web app (served locally by the orchestrator at /app) ──────
// The built React/Vite bundle from apps/web/dist is copied verbatim into the
// package's web/ directory. The launcher points MORROW_WEB_ROOT here so the
// orchestrator serves the local product at http://127.0.0.1:4317/app. The web
// artifact's content hash is covered by the package manifest hash written in
// step 6b, because the copy happens before provenance is computed.
console.log("\n[4c/8] Bundling the web app...");
const webSrc = join(ROOT, "apps", "web", "dist");
const webIndex = join(webSrc, "index.html");
if (!existsSync(webIndex)) {
  throw new Error(`Web app is not built (missing ${webIndex}). Run pnpm --filter @morrow/web build (or pnpm build) first.`);
}
const webDst = join(PKG_DIR, "web");
rmSync(webDst, { recursive: true, force: true });
cpSync(webSrc, webDst, { recursive: true });
if (!existsSync(join(webDst, "index.html"))) throw new Error("Web app copy failed (missing web/index.html).");
console.log(`  Bundled web app from ${webSrc}.`);

// ── 5. Skills (so the packaged agent can find_skill / load_skill) ─────────
// The agent reads each skill's SKILL.md (and manifest/permissions) at runtime
// from MORROW_SKILLS_DIR, which the launcher points at this bundled directory.
// Offensive LLM-jailbreak/attack skills are deliberately NOT shipped in the
// product: an installed assistant must not auto-load workflows whose purpose is
// to bypass model safety. They remain in the source tree for authorized
// red-team use; set MORROW_BUNDLE_ALL_SKILLS=1 to override (use responsibly).
const EXCLUDED_SKILLS = new Set([
  "adversarial-suffix", "context-smuggler", "dan-jailbreak", "encoding-warfare",
  "extraction-forge", "godmode", "jailbreak-evolver", "multi-turn-persuasion",
  "prompt-leak", "refusal-inverter", "roleplay-bypass", "sandbox-escape",
  "toxicity-prober", "unicode-warfare",
]);
const bundleAll = process.env.MORROW_BUNDLE_ALL_SKILLS === "1";
console.log("\n[5b/8] Bundling agent skills...");
const skillsSrc = join(ROOT, "skills");
const skillsDst = join(PKG_DIR, "skills");
let bundledSkills = 0, skippedSkills = 0;
if (existsSync(skillsSrc)) {
  for (const id of readdirSync(skillsSrc)) {
    const srcDir = join(skillsSrc, id);
    if (!existsSync(join(srcDir, "SKILL.md"))) continue;
    if (!bundleAll && EXCLUDED_SKILLS.has(id)) { skippedSkills++; continue; }
    const dstDir = join(skillsDst, id);
    ensure(dstDir);
    for (const file of ["SKILL.md", "manifest.json", "permissions.json"]) {
      if (existsSync(join(srcDir, file))) cpSync(join(srcDir, file), join(dstDir, file));
    }
    bundledSkills++;
  }
}
if (bundledSkills === 0) throw new Error("No skills were bundled (expected SKILL.md files under skills/).");
console.log(`  Bundled ${bundledSkills} skills${skippedSkills ? `, excluded ${skippedSkills} offensive/jailbreak skill(s)` : ""}.`);

// ── 6. Launchers + metadata (from versioned templates) ───────────────────
console.log("\n[6/8] Writing launchers and metadata...");
cpSync(join(TEMPLATES, "morrow.mjs"), join(PKG_DIR, "morrow.mjs"));
// The launcher imports ./dispatch.mjs for command classification; ship it too.
cpSync(join(TEMPLATES, "dispatch.mjs"), join(PKG_DIR, "dispatch.mjs"));
if (IS_WINDOWS) {
  cpSync(join(TEMPLATES, "morrow.cmd"), join(PKG_DIR, "morrow.cmd"));
  cpSync(join(TEMPLATES, "uninstall.ps1"), join(PKG_DIR, "uninstall.ps1"));
} else {
  // The POSIX installer writes the public shim after activation. The root
  // Windows launcher is not part of the POSIX runtime contract.
  rmSync(join(PKG_DIR, "morrow.mjs"), { force: true });
  rmSync(join(PKG_DIR, "dispatch.mjs"), { force: true });
}
writeFileSync(join(PKG_DIR, "VERSION"), VERSION);
writeFileSync(join(PKG_DIR, "CHANNEL"), "beta");
const notices = join(ROOT, "THIRD_PARTY_NOTICES.txt");
writeFileSync(join(PKG_DIR, "THIRD_PARTY_NOTICES.txt"), existsSync(notices) ? readFileSync(notices, "utf8") : "Morrow bundles Node.js and third-party npm dependencies under their respective licenses.\n");

// ── 6b. Build provenance ──────────────────────────────────────────────────
// Written last, after every other package file is in place, so its manifest
// hash covers the complete, final package contents. Baked into the archive:
// re-running acceptance against this exact zip always reads back the same
// sourceCommit/dirty/manifestHash, regardless of what HEAD does afterward.
console.log("\n[6b/8] Writing build provenance...");
let schemaCatalogVersion = null;
try {
  const dbModule = await import(pathToFileURL(join(orchSrc, "dist", "src", "database.js")).href);
  schemaCatalogVersion = Array.isArray(dbModule.migrations) ? dbModule.migrations.length : null;
} catch {
  schemaCatalogVersion = null;
}
const manifestHash = computePackageManifestHash(PKG_DIR);
const provenance = buildProvenance({ version: VERSION, sourceCommit, dirty, schemaCatalogVersion, manifestHash });
writeProvenance(PKG_DIR, provenance);
console.log(`  sourceCommit=${provenance.sourceCommit ?? "unknown"} dirty=${provenance.dirty} manifestHash=${provenance.manifestHash.slice(0, 12)}…`);

// ── 7. Archive ───────────────────────────────────────────────────────────
// Zip via .NET ZipFile from a temp stage OUTSIDE the project tree. Compress-Archive
// reads each source file with a BinaryReader, which throws "Stream was not readable"
// when the source lives under a synced folder (OneDrive) whose files are cloud
// placeholders or transiently locked by the sync client. Staging to %TEMP% forces
// local hydration and removes the sync client from the archive path entirely.
console.log("\n[7/8] Creating archive...");
if (existsSync(ARTIFACT_PATH)) rmSync(ARTIFACT_PATH, { force: true });
if (IS_WINDOWS) {
  const zipStage = join(process.env.TEMP || process.env.TMP || DIST, `morrow-pkgzip-${Date.now()}`);
  ps([
  `$ErrorActionPreference='Stop'`,
  `$stage=${JSON.stringify(zipStage)}`,
  `if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }`,
  `[void](New-Item -ItemType Directory -Path $stage)`,
  `$dest=Join-Path $stage ${JSON.stringify(PKG_NAME)}`,
  `robocopy ${JSON.stringify(PKG_DIR)} $dest /E /NFL /NDL /NJH /NJS /NP | Out-Null`,
  `if ($LASTEXITCODE -ge 8) { throw "robocopy failed: $LASTEXITCODE" }`,
  `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
  // tmpZip must live OUTSIDE $stage so CreateFromDirectory does not try to archive
  // its own output. includeBaseDirectory=false → archive root holds PKG_NAME/ only.
  `$tmpZip="$stage.zip"`,
  `if (Test-Path $tmpZip) { Remove-Item -Force $tmpZip }`,
  `[IO.Compression.ZipFile]::CreateFromDirectory($stage, $tmpZip, [IO.Compression.CompressionLevel]::Optimal, $false)`,
  `Move-Item -Force $tmpZip ${JSON.stringify(ARTIFACT_PATH)}`,
  `Remove-Item -Recurse -Force $stage`,
  ].join("; "));
} else {
  execFileSync("tar", ["-czf", ARTIFACT_PATH, "-C", DIST, PKG_NAME], { stdio: "inherit" });
}

// ── 8. Validate contract, checksums, manifest ────────────────────────────
console.log("\n[8/8] Validating package contract and writing manifest...");
const layout = assertArtifactLayout(ARTIFACT_PATH, PLATFORM);
console.log(`  Contract OK: single top-level dir, ${layout.entryCount} entries.`);

const hash = sha256(ARTIFACT_PATH);
const size = readFileSync(ARTIFACT_PATH).length;
const artifact = {
  schemaVersion: 1,
  version: VERSION,
  platform: PLATFORM,
  filename: ARTIFACT_FILENAME,
  url: `https://github.com/Mageester/morrow/releases/download/v${VERSION}/${ARTIFACT_FILENAME}`,
  size,
  sha256: hash,
};
writeFileSync(join(DIST, `artifact-${PLATFORM}.json`), `${JSON.stringify(artifact, null, 2)}\n`);

console.log("\n✓ Release package complete.");
console.log(`  Archive:   ${ARTIFACT_PATH}`);
console.log(`  Size:      ${(size / 1024 / 1024).toFixed(1)} MB`);
console.log(`  SHA-256:   ${hash}`);
console.log(`  Descriptor:${join(DIST, `artifact-${PLATFORM}.json`)}`);
