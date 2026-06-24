#!/usr/bin/env node
/**
 * Morrow Doctor — System diagnostics
 *
 * Usage:
 *   node scripts/doctor.mjs            — human-readable output
 *   node scripts/doctor.mjs --json     — JSON output
 *   node scripts/doctor.mjs --export   — redacted diagnostic export file
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { homedir, platform, arch, cpus, totalmem, freemem } from "node:os";
import { join } from "node:path";

const JSON_MODE = process.argv.includes("--json");
const EXPORT_MODE = process.argv.includes("--export");
const MORROW_HOME = process.env.MORROW_HOME || join(homedir(), ".morrow");
const API_URL = process.env.MORROW_API_URL || "http://127.0.0.1:4317";

const checks = [];

function addCheck(id, label, status, detail, action) {
  checks.push({ id, label, status, detail, action });
}

function ok(label, detail) { addCheck(label, label, "ok", detail); }
function warn(label, detail, action) { addCheck(label, label, "warn", detail, action); }
function fail(label, detail, action) { addCheck(label, label, "fail", detail, action); }

async function run() {
  // ── System ───────────────────────────────────────────────────────────
  ok("OS", `${platform()} ${arch()}`);
  ok("Node.js", process.version);
  ok("CPUs", `${cpus().length} cores`);
  ok("Memory", `${Math.round(totalmem() / 1024 / 1024 / 1024)} GB total, ${Math.round(freemem() / 1024 / 1024 / 1024)} GB free`);

  // ── Morrow version ────────────────────────────────────────────────────
  const pkgJson = join(process.cwd(), "package.json");
  if (existsSync(pkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
      ok("Version", pkg.version || "unknown");
    } catch {
      warn("Version", "Cannot read package.json");
    }
  } else {
    warn("Version", "Not running from Morrow directory");
  }

  // ── Data directory ───────────────────────────────────────────────────
  if (existsSync(MORROW_HOME)) {
    try {
      const files = require("fs").readdirSync(MORROW_HOME);
      ok("Data directory", `${MORROW_HOME} (${files.length} items)`);
    } catch {
      warn("Data directory", `Exists but cannot read: ${MORROW_HOME}`);
    }
  } else {
    warn("Data directory", `Not found: ${MORROW_HOME}`, "Run morrow install to create");
  }

  // ── Database ─────────────────────────────────────────────────────────
  const dbPath = join(MORROW_HOME, "morrow.db");
  if (existsSync(dbPath)) {
    try {
      const sz = statSync(dbPath).size;
      ok("Database", `${dbPath} (${(sz / 1024).toFixed(0)} KB)`);
    } catch {
      warn("Database", `Cannot access: ${dbPath}`);
    }
  } else {
    warn("Database", `Not found: ${dbPath}`, "Will be created on first run");
  }

  // ── API health ───────────────────────────────────────────────────────
  try {
    const res = await fetch(`${API_URL}/api/health`);
    if (res.ok) {
      const health = await res.json();
      ok("API Health", `${health.service} v${health.apiVersion} (mock: ${health.mockProvider})`);
    } else {
      fail("API Health", `HTTP ${res.status}`, "Check orchestrator logs");
    }
  } catch {
    fail("API Health", `Cannot reach ${API_URL}`, "Start the orchestrator: node morrow.mjs");
  }

  // ── Provider configuration ───────────────────────────────────────────
  try {
    const res = await fetch(`${API_URL}/api/providers`);
    if (res.ok) {
      const providers = await res.json();
      const configured = providers.filter(p => p.configured).map(p => p.id);
      if (configured.length > 0) {
        ok("Providers", `${configured.length} configured: ${configured.join(", ")}`);
      } else {
        warn("Providers", "No providers configured", "Set API keys in environment or secrets.env");
      }
    }
  } catch {
    warn("Providers", "Cannot query (API not reachable)");
  }

  // ── Browser / Chromium ────────────────────────────────────────────────
  try {
    const chromiumPaths = [
      join(homedir(), "AppData", "Local", "ms-playwright"),
      join(homedir(), ".cache", "ms-playwright"),
    ];
    const found = chromiumPaths.find(p => existsSync(p));
    if (found) {
      ok("Browser engine", `Playwright browsers found at ${found}`);
    } else {
      warn("Browser engine", "Playwright browsers not installed", "Install with: npx playwright install chromium");
    }
  } catch {
    warn("Browser engine", "Cannot verify (Playwright may install on first use)");
  }

  // ── Skills ───────────────────────────────────────────────────────────
  const skillsDir = join(MORROW_HOME, "skills");
  if (existsSync(skillsDir)) {
    try {
      const dirs = require("fs").readdirSync(skillsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && existsSync(join(skillsDir, d.name, "SKILL.md")));
      ok("Skills", `${dirs.length} skills installed in ${skillsDir}`);
    } catch {
      warn("Skills", `Cannot read skills directory: ${skillsDir}`);
    }
  } else {
    warn("Skills", "Skills directory not found", "Skills will be discovered from MORROW_HOME/skills");
  }

  // ── Ports ────────────────────────────────────────────────────────────
  try {
    const portCheck = execSync(`netstat -ano | findstr :4317`, { encoding: "utf8" }).trim();
    if (portCheck.includes("LISTENING")) {
      ok("Port 4317", "Listening");
    } else {
      warn("Port 4317", "Not listening", "Start Morrow or check for port conflicts");
    }
  } catch {
    warn("Port 4317", "Not listening (or netstat unavailable)");
  }

  // ── Workspace ────────────────────────────────────────────────────────
  const workspacePath = process.cwd();
  ok("Workspace", workspacePath);

  // ── Output ────────────────────────────────────────────────────────────
  if (JSON_MODE || EXPORT_MODE) {
    const output = {
      timestamp: new Date().toISOString(),
      system: { platform: platform(), arch: arch(), nodeVersion: process.version },
      morrowHome: MORROW_HOME,
      checks: checks.map(c => ({ id: c.id, status: c.status, detail: c.detail }))
    };
    if (JSON_MODE) {
      console.log(JSON.stringify(output, null, 2));
    }
    if (EXPORT_MODE) {
      const exportPath = join(MORROW_HOME, "diagnostics", `morrow-doctor-${Date.now()}.json`);
      const exportDir = join(MORROW_HOME, "diagnostics");
      if (!existsSync(exportDir)) require("fs").mkdirSync(exportDir, { recursive: true });
      writeFileSync(exportPath, JSON.stringify(output, null, 2));
      console.log(`Diagnostic export written to: ${exportPath}`);
      console.log("(No secrets are included in diagnostic exports)");
    }
  } else {
    // Human-readable
    const statusIcon = { ok: "✓", warn: "!", fail: "✕" };
    const COLORS = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m", reset: "\x1b[0m" };

    console.log("\n  Morrow Doctor\n");

    const okCount = checks.filter(c => c.status === "ok").length;
    const warnCount = checks.filter(c => c.status === "warn").length;
    const failCount = checks.filter(c => c.status === "fail").length;

    for (const check of checks) {
      const icon = statusIcon[check.status];
      const color = COLORS[check.status];
      console.log(`  ${color}${icon}${COLORS.reset} ${check.label}`);
      console.log(`    ${check.detail}`);
      if (check.action) console.log(`    ${COLORS.warn}→ ${check.action}${COLORS.reset}`);
    }

    console.log(`\n  ${okCount} healthy · ${warnCount} warnings · ${failCount} failures`);
    console.log(`\n  Run with --json for machine-readable output.`);
    console.log(`  Run with --export to save a redacted diagnostic file.\n`);
  }

  // Exit with failure code if critical failures
  const hasFailures = checks.some(c => c.status === "fail");
  if (hasFailures) process.exit(1);
}

run().catch(err => {
  console.error("Doctor check failed:", err.message);
  process.exit(1);
});
