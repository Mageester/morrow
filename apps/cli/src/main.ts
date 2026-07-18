import { accessSync, constants, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs, flagBool, flagString } from "./cli/args.js";
import { Context } from "./cli/context.js";
import { CliError, EXIT, usageError } from "./cli/errors.js";
import { Output, resolveColor } from "./cli/output.js";
import { ConfigStore } from "./config/config.js";
import { resolvePaths } from "./config/paths.js";
import { chatCommand } from "./commands/chat.js";
import { conversationsCommand } from "./commands/conversations.js";
import { memoryCommand, auditCommand, permissionsCommand, toolsCommand } from "./commands/observability.js";
import { modelsCommand } from "./commands/models.js";
import { presetsCommand } from "./commands/presets.js";
import { projectsCommand, initCommand } from "./commands/projects.js";
import { panicCommand } from "./commands/panic.js";
import { skillsCommand } from "./commands/skills.js";
import { scheduleCommand } from "./commands/schedule.js";
import { providersCommand } from "./commands/providers.js";
import { onboardCommand } from "./commands/onboard.js";
import { importCommand } from "./commands/import.js";
import { processesCommand } from "./commands/processes.js";
import { worktreesCommand } from "./commands/worktrees.js";
import { integrationsCommand } from "./commands/integrations.js";
import { symbolsCommand } from "./commands/symbols.js";
import { missionCommand, printMissionHelp } from "./commands/mission.js";
import { cortexCommand, printCortexHelp } from "./commands/cortex.js";
import { capabilitiesCommand } from "./commands/capabilities.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { acceptanceCommand, printAcceptanceHelp } from "./commands/acceptance.js";
import { provenanceCommand } from "./commands/provenance.js";
import { SLASH_COMMANDS } from "./terminal/commands.js";
import { probePnpm } from "./service/pnpm.js";
import { ensureRunning, serveDetached, serveForeground, stop, tailLog } from "./service/lifecycle.js";
import { aggregateDoctor, pnpmIsCritical, redactDiagnostics, type DoctorCheck } from "./service/doctor-checks.js";
import { checkForUpdate, fetchLatestVersion, MORROW_VERSION } from "./service/update.js";

// Single source of truth lives in service/update.ts (MORROW_VERSION); re-exported
// here so `morrow --version`, `/versions`, and `--help` never drift from the
// update checker's notion of the current version.
export const VERSION = MORROW_VERSION;

const VALUE_FLAGS = ["project", "provider", "model", "preset", "timeout", "host", "port", "url", "db", "path", "name", "title", "out", "format", "key", "scope", "content", "limit", "value", "resume", "lines", "worktree", "base", "task", "agent", "status", "target"];
const ALIASES = { h: "help", v: "version", q: "quiet" };
export const COMMANDS = new Set(["ask", "fix", "plan", "yolo", "new", "mission", "cortex", "acceptance", "provenance", "capabilities", "auth", "model", "settings", "start", "stop", "restart", "status", "doctor", "update", "onboard", "serve", "uninstall", "logs", "config", "projects", "init", "chat", "run", "conversations", "conversation", "sessions", "session", "resume", "providers", "models", "presets", "tools", "permissions", "audit", "memory", "panic", "skills", "schedule", "schedules", "import", "processes", "ps", "worktrees", "worktree", "integrate", "integrations", "symbols", "symbol-index"]);
const LIFECYCLE_COMMANDS = ["install", "uninstall", "repair", "update", "start", "stop", "restart", "status", "doctor", "serve", "logs"];

type Invocation =
  | { kind: "interactive" }
  | { kind: "prompt"; prompt: string }
  | { kind: "command"; root: string; sub: string | undefined; args: string[] };

export function resolveInvocation(positionals: string[]): Invocation {
  const [root, sub, ...args] = positionals;
  if (!root) return { kind: "interactive" };
  if (root === "run") return { kind: "prompt", prompt: [sub, ...args].filter((value): value is string => Boolean(value)).join(" ") };
  if (COMMANDS.has(root) || looksLifecycleCommand(root)) return { kind: "command", root, sub, args };
  return { kind: "prompt", prompt: positionals.join(" ") };
}

function looksLifecycleCommand(root: string): boolean {
  const normalized = root.toLowerCase();
  return LIFECYCLE_COMMANDS.some((command) => normalized === command || normalized.startsWith(`${command}-`) || normalized.startsWith(`${command}:`));
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, { valueFlags: VALUE_FLAGS, aliases: ALIASES });
  const noColor = parsed.flags.color === false || flagBool(parsed.flags, "no-color");
  const out = new Output({ json: flagBool(parsed.flags, "json"), quiet: flagBool(parsed.flags, "quiet"), color: resolveColor({ noColorFlag: noColor, json: flagBool(parsed.flags, "json"), env: process.env, isTTY: Boolean(process.stdout.isTTY) }) });
  try {
    if (flagBool(parsed.flags, "help") && parsed.positionals.length === 0) return printHelp(out);
    if (flagBool(parsed.flags, "help") && parsed.positionals[0] === "cortex") return printCortexHelp(out);
    if (flagBool(parsed.flags, "help") && parsed.positionals[0] === "mission") return printMissionHelp(out);
    if (flagBool(parsed.flags, "help") && parsed.positionals[0] === "acceptance") return printAcceptanceHelp(out);
    if (parsed.positionals[0] === "help") return printHelp(out);
    if (flagBool(parsed.flags, "version")) return printVersion(out);
    const invocation = resolveInvocation(parsed.positionals);
    let config: ConfigStore;
    try {
      config = ConfigStore.load();
    } catch (error) {
      if (invocation.kind === "command" && invocation.root === "doctor") {
        return invalidConfigDoctor(out, parsed.flags, error);
      }
      throw error;
    }
    const ctx = new Context({ out, config, paths: config.paths, flags: parsed.flags });

    // Auto-detect first launch
    const isSetupCmd = invocation.kind === "command" && ["onboard", "serve", "start", "stop", "restart", "status", "doctor", "uninstall", "logs", "capabilities", "acceptance", "provenance"].includes(invocation.root);
    if (!isSetupCmd) {
      let onboarded = config.get("user.onboarded") === true;
      if (!onboarded) {
        try {
          const api = ctx.api();
          const backendState = await api.getOnboardingState();
          if (backendState.onboarded) {
            config.set("user.onboarded", "true", "user");
            if (backendState.name) config.set("user.name", backendState.name, "user");
            if (backendState.useCase) config.set("user.useCase", backendState.useCase, "user");
            onboarded = true;
          }
        } catch {
          // Ignore backend lookup if service is down or fails
        }
      }
      if (!onboarded) {
        out.print(out.bold("Welcome to Morrow! Let's complete the quick setup guide first."));
        out.print();
        return onboardCommand(ctx, "", []);
      }
    }
    switch (invocation.kind) {
      case "interactive":
        return await chatCommand(ctx);
      case "prompt": {
        if (!invocation.prompt) throw usageError("Missing prompt.", "Run `morrow \"Explain this repository\"` or `morrow run \"…\"`.");
        const promptCtx = new Context({ out, config, paths: config.paths, flags: { ...parsed.flags, message: invocation.prompt } });
        return await chatCommand(promptCtx);
      }
      case "command":
        break;
    }
    const { root, sub, args = [] } = invocation;
    // Primary product surface: ask (inspect), fix (agent), plan (plan-only),
    // new (fresh agent session). A trailing prompt makes them one-shot.
    const promptOf = () => [sub, ...args].filter((v): v is string => Boolean(v)).join(" ");
    const chatWith = (extra: Record<string, string | boolean>) =>
      chatCommand(new Context({ out, config, paths: config.paths, flags: { ...parsed.flags, ...extra } }));
    switch (root) {
      case "ask": { const p = promptOf(); return await chatWith({ "read-only": true, ...(p ? { message: p } : {}) }); }
      case "fix": { const p = promptOf(); return await chatWith({ ...(p ? { message: p } : {}) }); }
      case "yolo": { const p = promptOf(); return await chatWith({ build: true, yolo: true, ...(p ? { message: p } : {}) }); }
      case "plan": { const p = promptOf(); return await chatWith({ plan: true, ...(p ? { message: p } : {}) }); }
      case "new": return await chatWith({ new: true });
      case "cortex": return await cortexCommand(ctx, sub, args);
      case "acceptance": return await acceptanceCommand(ctx, sub, args);
      case "provenance": return await provenanceCommand(ctx, [sub, ...args].filter((value): value is string => value !== undefined));
      case "capabilities": return await capabilitiesCommand(ctx);
      case "mission": {
        // A bare `morrow mission` (no objective/subcommand) opens the interactive
        // shell / Mission Control; otherwise run the Verified Missions lifecycle.
        if (!sub) return await chatWith({});
        return await missionCommand(ctx, sub, args);
      }
      case "model": return await modelsCommand(ctx, sub ?? "", args);
      case "settings": return await configCommand(ctx, sub ?? "list", args);
      case "auth": return await providersCommand(ctx, authSub(sub), args);
      case "status": return await status(ctx);
      case "doctor": return await doctor(ctx);
      case "update": return await update(ctx);
      case "onboard": return await onboardCommand(ctx, sub ?? "", args);
      case "serve": return flagBool(parsed.flags, "detach") ? (await serveDetached(ctx), EXIT.OK) : await serveForeground(ctx);
      case "start": await serveDetached(ctx); return EXIT.OK;
      case "stop": return await serviceStop(ctx);
      case "restart": return await restart(ctx);
      case "uninstall": return await uninstallCommand(ctx);
      case "logs": return await logs(ctx);
      case "config": return await configCommand(ctx, sub, args);
      case "projects": return await projectsCommand(ctx, sub ?? "", args);
      case "init": return await initCommand(ctx, [sub, ...args].filter((value): value is string => value !== undefined));
      case "chat": return await chatCommand(ctx);
      case "conversations": return await conversationsCommand(ctx, sub ?? "", args);
      case "conversation": return await conversationsCommand(ctx, sub ?? "", args);
      case "sessions": return await conversationsCommand(ctx, "list", []);
      case "session": return await conversationsCommand(ctx, sub ?? "list", args);
      case "resume": {
        const resumeCtx = new Context({ out, config, paths: config.paths, flags: { ...parsed.flags, resume: sub ?? "" } });
        return await chatCommand(resumeCtx);
      }
      case "providers": return await providersCommand(ctx, sub ?? "", args);
      case "models": return await modelsCommand(ctx, sub ?? "", args);
      case "presets": return await presetsCommand(ctx, sub, args);
      case "tools": return await toolsCommand(ctx, sub, args);
      case "permissions": return await permissionsCommand(ctx, sub);
      case "audit": return await auditCommand(ctx, sub, args);
      case "memory": return await memoryCommand(ctx, sub, args);
      case "panic": return await panicCommand(ctx);
      case "skills": return await skillsCommand(ctx, sub, args);
      case "import": return await importCommand(ctx, sub ?? "", args);
      case "processes":
      case "ps": return await processesCommand(ctx, sub ?? "", args);
      case "worktrees":
      case "worktree": return await worktreesCommand(ctx, sub ?? "", args);
      case "integrate":
      case "integrations": return await integrationsCommand(ctx, sub ?? "", args);
      case "symbols":
      case "symbol-index": return await symbolsCommand(ctx, sub ?? "", args);
      case "schedule":
      case "schedules": return await scheduleCommand(ctx, sub, args);
      default: throw usageError(`Unknown command: ${root}`, "Run `morrow --help` for commands.");
    }
  } catch (error) {
    if (error instanceof CliError) {
      out.error(error.message);
      if (error.hint) out.diag(`  ${error.hint}`);
      return error.exitCode;
    }
    // For non-CliError exceptions, surface a human-friendly interpreted error
    // instead of a raw stack trace. The raw message is still available via
    // --verbose or /details in the interactive session.
    const raw = error instanceof Error ? error.message : String(error);
    try {
      const { interpretError } = await import("./terminal/errors.js");
      const interpreted = interpretError(raw);
      out.error(interpreted.title);
      out.print();
      out.print(`  ${interpreted.body}`);
      if (interpreted.hint) { out.print(); out.print(`  ${out.cyan(interpreted.hint)}`); }
    } catch {
      out.error(raw);
    }
    return EXIT.ERROR;
  }
}

/** Map the friendly `morrow auth …` verbs onto the providers command. */
function authSub(sub: string | undefined): string {
  if (sub === "login") return "configure";
  if (sub === "logout") return "logout";
  if (sub === "status" || sub === undefined) return "status";
  return sub;
}

function printVersion(out: Output): number { if (out.json) out.data({ version: VERSION }); else out.print(VERSION); return EXIT.OK; }
function printHelp(out: Output): number {
  const b = (s: string) => out.bold(s);
  const g = (s: string) => out.gray(s);
  const help = [
    `${b("MORROW")} ${g("· private intelligence, built around you")}`,
    "",
    b("Start here"),
    `  morrow                       ${g("open the terminal agent shell")}`,
    `  morrow mission               ${g("open Mission Control in the terminal")}`,
    `  morrow ask "…"               ${g("inspect and answer — never writes")}`,
    `  morrow plan "…"              ${g("produce a plan — no execution, no writes")}`,
    `  morrow fix "…"               ${g("approval-gated coding workflow")}`,
    `  morrow yolo "…"              ${g("agent that auto-approves edits & commands")}`,
    `  morrow cortex                ${g("inspect repository intelligence")}`,
    `  morrow acceptance            ${g("run packaged product acceptance checks")}`,
    `  morrow capabilities          ${g("what this build can actually do right now")}`,
    `  morrow resume                ${g("resume the most recent session")}`,
    `  morrow new                   ${g("start a fresh session")}`,
    "",
    b("Setup"),
    `  morrow onboard               ${g("guided first-run setup")}`,
    `  morrow auth login|status     ${g("connect a model provider")}`,
    `  morrow model                 ${g("choose a model")}`,
    `  morrow settings              ${g("view or change preferences")}`,
    `  morrow doctor                ${g("check your environment")}`,
    `  morrow start|stop|restart    ${g("manage the local service")}`,
    `  morrow uninstall             ${g("guided uninstall; preserves user data unless --purge-data")}`,
    "",
    b("In a session"),
    // Generated from the same registry the interactive `/` palette uses, so
    // this list can never drift from what the palette actually offers
    // (KNOWN_ISSUES #14 — `/tasks` and `/stats` were previously missing here).
    `  ${g(SLASH_COMMANDS.map((c) => `/${c.name}`).join(" "))}`,
    "",
    g("More: morrow projects | conversations | presets | tools | symbols | audit | skills | import hermes | serve | logs"),
    g("Options: --json --no-color --project --provider --model --preset --plan --read-only --yolo"),
  ].join("\n");
  if (out.json) out.data({ version: VERSION, help }); else out.print(help);
  return EXIT.OK;
}

async function status(ctx: Context): Promise<number> {
  const health = await ctx.api().health();
  const provider = await ctx.api().providerStatus();
  if (ctx.out.json) ctx.out.data({ health, provider });
  else ctx.out.keyValue([["service", health.service], ["status", health.ok ? "healthy" : "unhealthy"], ["provider", provider.provider], ["model", provider.model], ["database", ctx.service.dbPath]]);
  return health.ok ? EXIT.OK : EXIT.SERVICE_UNAVAILABLE;
}

async function doctor(ctx: Context): Promise<number> {
  const pnpm = probePnpm(process.env);
  const checks: DoctorCheck[] = [
    { name: "version", ok: true, detail: VERSION, critical: true },
    { name: "platform", ok: true, detail: `${platform()} ${arch()}`, critical: false },
    { name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.versions.node, critical: true },
    { name: "pnpm", ok: pnpm.ok, detail: pnpm.executable ? `${pnpm.detail} (${pnpm.executable})` : pnpm.detail, critical: pnpmIsCritical(process.env), fix: "Install pnpm only when running Morrow from source." },
    { name: "config", ok: true, detail: "parsed", critical: true },
    writableDirectoryCheck(ctx.paths.home),
    databaseCheck(ctx.service.dbPath),
    skillsCheck(ctx.paths.home),
    { name: "terminal", ok: true, detail: `tty ${Boolean(process.stdout.isTTY)}; columns ${process.stdout.columns ?? "unknown"}; color ${ctx.out.color}`, critical: false },
    { name: "unicode", ok: true, detail: process.platform === "win32" ? "UTF-8 output requested; use a modern Windows Terminal profile if glyphs render incorrectly" : "UTF-8 runtime", critical: false },
    { name: "PATH", ok: Boolean(process.env.PATH), detail: process.env.PATH ? "available" : "not set", critical: false },
  ];
  try {
    const health = await ctx.api().health();
    const identityOk = health.ok === true && health.service === "morrow-orchestrator";
    checks.push({ name: "orchestrator", ok: identityOk, detail: identityOk ? `${health.service}; api ${health.apiVersion}; port ${ctx.service.port}; migrations ${health.migrations.applied}/${health.migrations.latest ?? "?"}` : "unexpected service identity", critical: true, fix: "Stop the process on the configured port, then run `morrow start`." });
    const providers = await ctx.api().listProviders();
    const configuredProviders = providers.filter((provider) => provider.configured);
    // "N configured" alone told a beta.31 consumer nothing when routing later
    // failed. Name each configured route: provider, auth mode, endpoint host,
    // and default model — the same facts the router consumes.
    checks.push({
      name: "providers",
      ok: configuredProviders.length > 0,
      detail: configuredProviders.length > 0
        ? configuredProviders.map((provider) => `${provider.id} (${provider.authMode ?? "unknown"}${provider.endpointHost ? ` @ ${provider.endpointHost}` : ""}${provider.defaultModel ? `, model ${provider.defaultModel}` : ""})`).join("; ")
        : "0 configured",
      critical: false,
      fix: "Run `morrow auth login`.",
    });
    // The selected route + its effective context, from the same canonical
    // ModelBudget computation execution uses — never re-derived here.
    const selectedModel = ctx.config.get("defaults.model") as string | undefined;
    const selectedProvider = ctx.config.get("defaults.provider") as string | undefined;
    const activePreset = (ctx.config.get("defaults.preset") as string | undefined) ?? "balanced";
    const budgets = await ctx.api().getModelBudgets().catch(() => null);
    const budget = selectedModel ? budgets?.find((entry) => entry.selectedModelId === selectedModel && (!selectedProvider || entry.providerId === selectedProvider)) : undefined;
    checks.push({
      name: "route",
      ok: true,
      detail: `preset ${activePreset}; selected ${selectedProvider ?? "auto"}/${selectedModel ?? "auto"}`
        + (budget ? `; context ${budget.contextWindowTokens.toLocaleString()} (${budget.contextWindowConfidence}${budget.endpointHost ? ` @ ${budget.endpointHost}` : ""}); usable input ${budget.usableInputTokens.toLocaleString()}` : ""),
      critical: false,
    });
    const projects = await ctx.api().listProjects();
    const registered = Boolean(ctx.paths.repoRoot && projects.some((project) => project.workspacePath.toLowerCase() === ctx.paths.repoRoot!.toLowerCase()));
    // Say precisely which of the three distinct things is missing: a Git
    // repository at cwd, a Morrow project registration for it, or both.
    checks.push({
      name: "repository",
      ok: registered,
      detail: ctx.paths.repoRoot
        ? (registered ? `current repository registered (${ctx.paths.repoRoot})` : `Git repository found at ${ctx.paths.repoRoot}, but it is not registered as a Morrow project`)
        : "current directory is not inside a Git repository (Morrow projects are Git repositories)",
      critical: false,
      fix: ctx.paths.repoRoot ? "Run `morrow init` from the repository." : "Run `git init` (or cd into your project), then `morrow init`.",
    });
  } catch {
    checks.push({ name: "orchestrator", ok: false, detail: `not reachable on ${ctx.service.host}:${ctx.service.port}`, critical: true, fix: "Run `morrow start`, then retry `morrow doctor`." });
  }
  // Logs truthfulness: doctor previously printed the log path while `morrow
  // logs` reported "No logs at <same path>". State whether the file exists.
  const logExists = existsSync(ctx.paths.logFile);
  checks.push({
    name: "logs",
    ok: true,
    detail: logExists
      ? `${ctx.paths.logFile} (${statSync(ctx.paths.logFile).size.toLocaleString()} bytes)`
      : `no log file yet at ${ctx.paths.logFile} — it is created when this CLI starts the service (\`morrow start\`)`,
    critical: false,
  });
  const ok = aggregateDoctor(checks).ok;
  const exportPath = flagBool(ctx.flags, "export") ? writeDiagnosticExport(doctorPayload(ok, checks, ctx.paths.logFile, diagnosticDirectory(ctx.paths.home)), ctx.paths.home) : undefined;
  const payload = doctorPayload(ok, checks, ctx.paths.logFile, exportPath ?? diagnosticDirectory(ctx.paths.home));
  if (ctx.out.json) ctx.out.data(payload);
  else {
    ctx.out.heading("Morrow doctor");
    ctx.out.table(["check", "status", "detail"], checks.map((check) => [check.name, doctorStatus(ctx.out, check), check.detail]));
    // When pnpm resolution fails, surface every ranked candidate we tried so the
    // user can see why each was rejected (rather than a single opaque error).
    if (!pnpm.ok && pnpm.tried && pnpm.tried.length > 0) {
      ctx.out.print();
      ctx.out.heading("pnpm candidates checked");
      for (const attempt of pnpm.tried) {
        ctx.out.print(`  ${ctx.out.gray(`[${attempt.source}]`)} ${attempt.path} ${ctx.out.gray(`→ ${attempt.reason}`)}`);
      }
    }
    ctx.out.info(`Logs: ${ctx.paths.logFile}`);
    ctx.out.info(`Diagnostics export: ${exportPath ?? `${diagnosticDirectory(ctx.paths.home)} (run with --export)`}`);
    if (exportPath) ctx.out.success("Diagnostic export written without secrets.");
  }
  return ok ? EXIT.OK : EXIT.SERVICE_UNAVAILABLE;
}

function invalidConfigDoctor(out: Output, flags: Record<string, string | boolean>, _error: unknown): number {
  const paths = resolvePaths();
  const checks: DoctorCheck[] = [{
    name: "config",
    ok: false,
    detail: `invalid JSON in ${paths.userConfigFile}`,
    critical: true,
    fix: "Repair or move the config file, then rerun `morrow doctor`.",
  }];
  const exportPath = flagBool(flags, "export") ? writeDiagnosticExport(doctorPayload(false, checks, paths.logFile, diagnosticDirectory(paths.home)), paths.home) : undefined;
  if (out.json) out.data(doctorPayload(false, checks, paths.logFile, exportPath ?? diagnosticDirectory(paths.home)));
  else {
    out.heading("Morrow doctor");
    out.table(["check", "status", "detail"], [["config", out.red("fail"), checks[0]!.detail]]);
    out.info(checks[0]!.fix!);
    out.info(`Diagnostics export: ${exportPath ?? `${diagnosticDirectory(paths.home)} (run with --export)`}`);
  }
  return EXIT.USAGE;
}

function doctorPayload(ok: boolean, checks: DoctorCheck[], logPath: string, diagnosticsExportPath: string) {
  return {
    schemaVersion: 1,
    ok,
    version: VERSION,
    system: { platform: platform(), arch: arch(), node: process.versions.node },
    checks,
    logPath,
    diagnosticsExportPath,
  };
}

function diagnosticDirectory(home: string): string {
  return join(home, "diagnostics");
}

function writeDiagnosticExport(payload: ReturnType<typeof doctorPayload>, home: string): string {
  const directory = diagnosticDirectory(home);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `morrow-doctor-${Date.now()}.json`);
  writeFileSync(path, `${JSON.stringify(redactDiagnostics(payload, home), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  return path;
}

function doctorStatus(out: Output, check: DoctorCheck): string {
  if (check.ok) return out.green("pass");
  return check.critical ? out.red("failure") : out.yellow("warning");
}

function writableDirectoryCheck(home: string): DoctorCheck {
  try {
    accessSync(home, constants.R_OK | constants.W_OK);
    return { name: "data directory", ok: true, detail: `${home} (read/write)`, critical: true };
  } catch {
    return { name: "data directory", ok: false, detail: `${home} is missing or not writable`, critical: true, fix: "Repair directory permissions or reinstall Morrow." };
  }
}

function skillsCheck(home: string): DoctorCheck {
  const directory = process.env.MORROW_SKILLS_DIR ?? join(home, "skills");
  try {
    const count = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(directory, entry.name, "SKILL.md"))).length;
    return { name: "skills", ok: count > 0, detail: `${count} installed`, critical: false, fix: "Reinstall Morrow to restore bundled skills." };
  } catch {
    return { name: "skills", ok: false, detail: `${directory} is not readable`, critical: false, fix: "Reinstall Morrow to restore bundled skills." };
  }
}

function databaseCheck(path: string): DoctorCheck {
  if (!existsSync(path)) return { name: "state database", ok: false, detail: `${path} not created yet`, critical: false, fix: "Start Morrow once to create local state." };
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return { name: "state database", ok: true, detail: `${path} (read/write)`, critical: true };
  } catch {
    return { name: "state database", ok: false, detail: `${path} is not readable and writable`, critical: true, fix: "Repair file permissions or restore from backup." };
  }
}



async function update(ctx: Context): Promise<number> {
  const latest = await fetchLatestVersion();
  if (!latest) {
    if (ctx.out.json) ctx.out.data({ current: MORROW_VERSION, latest: null, updateAvailable: false });
    else ctx.out.warn("Could not check for updates (offline or source unavailable).");
    return EXIT.OK;
  }
  const status = checkForUpdate(MORROW_VERSION, latest);
  if (ctx.out.json) ctx.out.data(status);
  else if (status.updateAvailable) {
    ctx.out.heading("Update available");
    ctx.out.keyValue([["current", status.current], ["latest", status.latest]]);
    ctx.out.info("Apply with: git pull && pnpm install && pnpm build");
  } else {
    ctx.out.success(`Morrow is up to date (${status.current}).`);
  }
  return EXIT.OK;
}

async function serviceStop(ctx: Context): Promise<number> { const stopped = await stop(ctx); if (ctx.out.json) ctx.out.data({ stopped }); else ctx.out.info(stopped ? "Service stopped." : "Service was not running."); return EXIT.OK; }
async function restart(ctx: Context): Promise<number> { await stop(ctx); await serveDetached(ctx); return EXIT.OK; }
async function logs(ctx: Context): Promise<number> {
  const content = tailLog(ctx, Number(flagString(ctx.flags, "lines") ?? 100));
  if (ctx.out.json) {
    ctx.out.data({ path: ctx.paths.logFile, exists: existsSync(ctx.paths.logFile), content });
  } else if (content) {
    ctx.out.print(content);
  } else {
    // Truthful empty state: say why the file may not exist rather than a bare
    // "No logs at <path>" that contradicts doctor's "Logs: <path>".
    ctx.out.print(`No log file at ${ctx.paths.logFile}.`);
    ctx.out.print("The log is created when this CLI starts the service (`morrow start`). If the orchestrator was started another way, or with a different MORROW_HOME, its logs are wherever that process wrote them.");
  }
  return EXIT.OK;
}

async function configCommand(ctx: Context, sub: string | undefined, args: string[]): Promise<number> {
  const scope = flagString(ctx.flags, "scope") === "project" ? "project" : "user";
  if (!sub || sub === "list") { const values = ctx.config.flat(); if (ctx.out.json) ctx.out.data(values); else ctx.out.table(["key", "value", "source"], values.map((value) => [value.key, value.value, value.source])); return EXIT.OK; }
  if (sub === "path") { const paths = { user: ctx.paths.userConfigFile, project: ctx.paths.projectConfigFile }; if (ctx.out.json) ctx.out.data(paths); else ctx.out.keyValue([["user", paths.user], ["project", paths.project ?? "not in project"]]); return EXIT.OK; }
  const key = args[0];
  if (!key) throw usageError(`Usage: morrow config ${sub} <key>${sub === "set" ? " <value>" : ""}`);
  if (sub === "get") { const value = ctx.config.get(key); if (value === undefined) throw new CliError(`Config key is not set: ${key}`, { exitCode: EXIT.NOT_FOUND }); if (ctx.out.json) ctx.out.data({ key, value }); else ctx.out.print(String(value)); return EXIT.OK; }
  if (sub === "set") { const value = args.slice(1).join(" ") || flagString(ctx.flags, "value"); if (!value) throw usageError("Usage: morrow config set <key> <value>"); ctx.config.set(key, value, scope); if (ctx.out.json) ctx.out.data({ key, value, scope }); else ctx.out.success(`Set ${key}.`); return EXIT.OK; }
  if (sub === "unset") { ctx.config.unset(key, scope); if (ctx.out.json) ctx.out.data({ key, unset: true, scope }); else ctx.out.success(`Unset ${key}.`); return EXIT.OK; }
  throw usageError(`Unknown config subcommand: ${sub}`, "Try: list, get, set, unset, path");
}
