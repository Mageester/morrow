import { dirname } from "node:path";
import { parseArgs, flagBool, flagString } from "./cli/args.js";
import { Context } from "./cli/context.js";
import { CliError, EXIT, usageError } from "./cli/errors.js";
import { Output, resolveColor } from "./cli/output.js";
import { ConfigStore } from "./config/config.js";
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
import { missionCommand } from "./commands/mission.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { probePnpm } from "./service/pnpm.js";
import { ensureRunning, serveDetached, serveForeground, stop, tailLog } from "./service/lifecycle.js";
import { aggregateDoctor } from "./service/doctor-checks.js";
import { checkForUpdate, fetchLatestVersion, MORROW_VERSION } from "./service/update.js";

// Single source of truth lives in service/update.ts (MORROW_VERSION); re-exported
// here so `morrow --version`, `/versions`, and `--help` never drift from the
// update checker's notion of the current version.
export const VERSION = MORROW_VERSION;

const VALUE_FLAGS = ["project", "provider", "model", "preset", "timeout", "host", "port", "url", "db", "path", "name", "title", "out", "format", "key", "scope", "content", "limit", "value", "resume", "lines", "worktree", "base", "task", "agent", "status", "target"];
const ALIASES = { h: "help", v: "version", q: "quiet" };
export const COMMANDS = new Set(["ask", "fix", "plan", "yolo", "new", "mission", "auth", "model", "settings", "start", "stop", "restart", "status", "open", "doctor", "update", "onboard", "serve", "uninstall", "logs", "config", "projects", "init", "chat", "run", "conversations", "conversation", "sessions", "session", "resume", "providers", "models", "presets", "tools", "permissions", "audit", "memory", "panic", "skills", "schedule", "schedules", "import", "processes", "ps", "worktrees", "worktree", "integrate", "integrations", "symbols", "symbol-index"]);
const LIFECYCLE_COMMANDS = ["install", "uninstall", "repair", "update", "start", "stop", "restart", "status", "doctor", "open", "serve", "logs"];

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
    if ((flagBool(parsed.flags, "help") && parsed.positionals.length === 0) || parsed.positionals[0] === "help") return printHelp(out);
    if (flagBool(parsed.flags, "version")) return printVersion(out);
    const config = ConfigStore.load();
    const ctx = new Context({ out, config, paths: config.paths, flags: parsed.flags });
    const invocation = resolveInvocation(parsed.positionals);

    // Auto-detect first launch
    const isSetupCmd = invocation.kind === "command" && ["onboard", "serve", "start", "stop", "restart", "status", "open", "doctor", "uninstall", "logs"].includes(invocation.root);
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
        return open(ctx);
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
      case "yolo": { const p = promptOf(); return await chatWith({ yolo: true, ...(p ? { message: p } : {}) }); }
      case "plan": { const p = promptOf(); return await chatWith({ plan: true, ...(p ? { message: p } : {}) }); }
      case "new": return await chatWith({ new: true });
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
      case "open": return await open(ctx);
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
    out.error(error instanceof Error ? error.message : String(error));
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
    `  morrow open                  ${g("open the local app in your browser")}`,
    `  morrow uninstall             ${g("guided uninstall; preserves user data unless --purge-data")}`,
    "",
    b("In a session"),
    `  ${g("/help /mode /yolo /model /tree /result /context /diff /undo /output /panic /status /memory /permissions /resume /exit")}`,
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
  const checks: Array<{ name: string; ok: boolean; detail: string; critical: boolean }> = [
    { name: "node", ok: Number(process.versions.node.split(".")[0]) >= 22, detail: process.versions.node, critical: true },
    { name: "pnpm", ok: pnpm.ok, detail: pnpm.executable ? `${pnpm.detail} (${pnpm.executable})` : pnpm.detail, critical: true },
    { name: "data directory", ok: true, detail: dirname(ctx.service.dbPath), critical: false },
  ];
  try {
    const health = await ctx.api().health();
    checks.push({ name: "orchestrator", ok: health.ok, detail: `${health.service}; migrations ${health.migrations.applied}/${health.migrations.latest ?? "?"}`, critical: true });
    const providers = await ctx.api().listProviders();
    checks.push({ name: "providers", ok: true, detail: `${providers.filter((provider) => provider.configured).length} configured`, critical: false });
  } catch (error) {
    checks.push({ name: "orchestrator", ok: false, detail: error instanceof Error ? error.message : String(error), critical: true });
  }
  const ok = aggregateDoctor(checks).ok;
  if (ctx.out.json) ctx.out.data({ ok, checks, pnpm, logPath: ctx.paths.logFile });
  else {
    ctx.out.heading("Morrow doctor");
    ctx.out.table(["check", "status", "detail"], checks.map((check) => [check.name, check.ok ? ctx.out.green("ok") : ctx.out.red("fail"), check.detail]));
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
  }
  return ok ? EXIT.OK : EXIT.SERVICE_UNAVAILABLE;
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
async function open(ctx: Context): Promise<number> {
  await ensureRunning(ctx);
  const url = ctx.service.baseUrl;
  const { spawn } = await import("node:child_process");
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  if (ctx.out.json) ctx.out.data({ opened: url }); else ctx.out.success(`Opened ${url}`);
  return EXIT.OK;
}
async function logs(ctx: Context): Promise<number> { const content = tailLog(ctx, Number(flagString(ctx.flags, "lines") ?? 100)); if (ctx.out.json) ctx.out.data({ path: ctx.paths.logFile, content }); else ctx.out.print(content || `No logs at ${ctx.paths.logFile}.`); return EXIT.OK; }

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
