import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs, flagBool, flagString } from "./cli/args.js";
import { Context } from "./cli/context.js";
import { webCommand, webAppUrl } from "./commands/web.js";
import { CliError, EXIT, usageError } from "./cli/errors.js";
import { Output, resolveColor } from "./cli/output.js";
import { ConfigStore } from "./config/config.js";
import { resolvePaths } from "./config/paths.js";
import {
  builtinRegistry,
  CATEGORY_LABELS,
  CATEGORY_ORDER,
} from "./terminal/commands/index.js";
import { probePnpm } from "./service/pnpm.js";
import {
  ensureRunning,
  serveDetached,
  serveForeground,
  stop,
  tailLog,
} from "./service/lifecycle.js";
import {
  aggregateDoctor,
  pnpmIsCritical,
  redactDiagnostics,
  type DoctorCheck,
} from "./service/doctor-checks.js";
import {
  checkForUpdate,
  fetchLatestVersion,
  MORROW_VERSION,
} from "./service/update.js";

/**
 * Command modules are loaded on demand, never at module scope.
 *
 * Importing all twenty-five up front pulled the acceptance harness, the mission
 * engine and (through them) the whole orchestrator into every `morrow`
 * invocation — `--version` paid 1.9 seconds to print a string. Each dispatch
 * site now awaits only the module it is about to run.
 */
const load = {
  acceptanceCommand: async () =>
    (await import("./commands/acceptance.js")).acceptanceCommand,
  auditCommand: async () =>
    (await import("./commands/observability.js")).auditCommand,
  buildCommand: async () => (await import("./commands/build.js")).buildCommand,
  capabilitiesCommand: async () =>
    (await import("./commands/capabilities.js")).capabilitiesCommand,
  chatCommand: async () => (await import("./commands/chat.js")).chatCommand,
  conversationsCommand: async () =>
    (await import("./commands/conversations.js")).conversationsCommand,
  cortexCommand: async () =>
    (await import("./commands/cortex.js")).cortexCommand,
  importCommand: async () =>
    (await import("./commands/import.js")).importCommand,
  initCommand: async () => (await import("./commands/projects.js")).initCommand,
  integrationsCommand: async () =>
    (await import("./commands/integrations.js")).integrationsCommand,
  mcpCommand: async () => (await import("./commands/mcp.js")).mcpCommand,
  memoryCommand: async () =>
    (await import("./commands/observability.js")).memoryCommand,
  missionCommand: async () =>
    (await import("./commands/mission.js")).missionCommand,
  modelsCommand: async () =>
    (await import("./commands/models.js")).modelsCommand,
  onboardCommand: async () =>
    (await import("./commands/onboard.js")).onboardCommand,
  panicCommand: async () => (await import("./commands/panic.js")).panicCommand,
  permissionsCommand: async () =>
    (await import("./commands/observability.js")).permissionsCommand,
  presetsCommand: async () =>
    (await import("./commands/presets.js")).presetsCommand,
  printAcceptanceHelp: async () =>
    (await import("./commands/acceptance.js")).printAcceptanceHelp,
  printCortexHelp: async () =>
    (await import("./commands/cortex.js")).printCortexHelp,
  printMissionHelp: async () =>
    (await import("./commands/mission.js")).printMissionHelp,
  processesCommand: async () =>
    (await import("./commands/processes.js")).processesCommand,
  projectsCommand: async () =>
    (await import("./commands/projects.js")).projectsCommand,
  provenanceCommand: async () =>
    (await import("./commands/provenance.js")).provenanceCommand,
  providersCommand: async () =>
    (await import("./commands/providers.js")).providersCommand,
  scheduleCommand: async () =>
    (await import("./commands/schedule.js")).scheduleCommand,
  skillsCommand: async () =>
    (await import("./commands/skills.js")).skillsCommand,
  symbolsCommand: async () =>
    (await import("./commands/symbols.js")).symbolsCommand,
  toolsCommand: async () =>
    (await import("./commands/observability.js")).toolsCommand,
  uninstallCommand: async () =>
    (await import("./commands/uninstall.js")).uninstallCommand,
  worktreesCommand: async () =>
    (await import("./commands/worktrees.js")).worktreesCommand,
} as const;

// Single source of truth lives in service/update.ts (MORROW_VERSION); re-exported
// here so `morrow --version`, `/versions`, and `--help` never drift from the
// update checker's notion of the current version.
export const VERSION = MORROW_VERSION;

// `in` must be a declared value flag: without it `--in --json` (or any value
// that starts with `-`) would silently degrade to a boolean and the build
// would run against the wrong workspace instead of failing loudly.
const VALUE_FLAGS = [
  "project",
  "in",
  "provider",
  "model",
  "preset",
  "timeout",
  "host",
  "port",
  "url",
  "db",
  "path",
  "name",
  "title",
  "out",
  "format",
  "key",
  "scope",
  "content",
  "limit",
  "value",
  "resume",
  "lines",
  "worktree",
  "base",
  "task",
  "agent",
  "status",
  "target",
  "command",
  "template",
  "transport",
];
const ALIASES = { h: "help", v: "version", q: "quiet" };

/** Commands that print their own `--help` and are verified to do so without
 * executing anything. Every other command is intercepted by the generic help
 * path, so `--help` can never trigger the action. */
const SELF_DOCUMENTING_COMMANDS = new Set(["uninstall"]);
export const COMMANDS = new Set([
  "ask",
  "fix",
  "plan",
  "build",
  "yolo",
  "new",
  "mission",
  "cortex",
  "acceptance",
  "provenance",
  "capabilities",
  "auth",
  "model",
  "settings",
  "start",
  "stop",
  "restart",
  "status",
  "doctor",
  "update",
  "onboard",
  "serve",
  "uninstall",
  "logs",
  "config",
  "projects",
  "init",
  "chat",
  "run",
  "conversations",
  "conversation",
  "sessions",
  "session",
  "resume",
  "providers",
  "models",
  "presets",
  "tools",
  "permissions",
  "audit",
  "memory",
  "panic",
  "skills",
  "schedule",
  "schedules",
  "import",
  "processes",
  "ps",
  "worktrees",
  "worktree",
  "integrate",
  "integrations",
  "symbols",
  "symbol-index",
  "mcp",
  "web",
  "gui",
  "ui",
]);
const LIFECYCLE_COMMANDS = [
  "install",
  "uninstall",
  "repair",
  "update",
  "start",
  "stop",
  "restart",
  "status",
  "doctor",
  "serve",
  "logs",
];

type Invocation =
  | { kind: "interactive" }
  | { kind: "prompt"; prompt: string }
  | { kind: "command"; root: string; sub: string | undefined; args: string[] };

export function resolveInvocation(positionals: string[]): Invocation {
  const [root, sub, ...args] = positionals;
  if (!root) return { kind: "interactive" };
  if (root === "run")
    return {
      kind: "prompt",
      prompt: [sub, ...args]
        .filter((value): value is string => Boolean(value))
        .join(" "),
    };
  if (COMMANDS.has(root) || looksLifecycleCommand(root))
    return { kind: "command", root, sub, args };
  return { kind: "prompt", prompt: positionals.join(" ") };
}

/** Complete permission intent for the four task-bearing root commands. */
export function rootPermissionFlags(
  root: "ask" | "fix" | "plan" | "yolo",
): Record<string, boolean> {
  switch (root) {
    case "ask":
      return { "read-only": true, yolo: false };
    case "fix":
      return { yolo: false };
    case "plan":
      return { plan: true, yolo: false };
    case "yolo":
      return { build: true, yolo: true };
  }
}

function looksLifecycleCommand(root: string): boolean {
  const normalized = root.toLowerCase();
  return LIFECYCLE_COMMANDS.some(
    (command) =>
      normalized === command ||
      normalized.startsWith(`${command}-`) ||
      normalized.startsWith(`${command}:`),
  );
}

export async function run(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, { valueFlags: VALUE_FLAGS, aliases: ALIASES });
  const noColor =
    parsed.flags.color === false || flagBool(parsed.flags, "no-color");
  const out = new Output({
    json: flagBool(parsed.flags, "json"),
    quiet: flagBool(parsed.flags, "quiet"),
    color: resolveColor({
      noColorFlag: noColor,
      json: flagBool(parsed.flags, "json"),
      env: process.env,
      isTTY: Boolean(process.stdout.isTTY),
    }),
  });
  try {
    // `--help` must never reach a command. This was previously an allowlist,
    // so `morrow start --help` started the service, `morrow stop --help`
    // stopped it, and `morrow ps --help` opened the onboarding wizard — a help
    // flag with side effects, on the one idiom every user reaches for first.
    // Any command with `--help` describes itself and exits here instead.
    if (flagBool(parsed.flags, "help")) {
      const command = parsed.positionals[0];
      if (!command) return printHelp(out);
      if (command === "cortex") return (await load.printCortexHelp())(out);
      if (command === "mission") return (await load.printMissionHelp())(out);
      if (command === "acceptance") return (await load.printAcceptanceHelp())(out);
      // Commands that render their own, richer help and are verified to do it
      // without side effects fall through to their handler. Everything else is
      // intercepted above. The polarity matters: intercepting by default means
      // a newly added command is safe under `--help` without anyone
      // remembering to register it.
      if (!SELF_DOCUMENTING_COMMANDS.has(command)) return printCommandHelp(out, command);
    }
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
    const ctx = new Context({
      out,
      config,
      paths: config.paths,
      flags: parsed.flags,
    });

    // Auto-detect first launch
    const isSetupCmd =
      invocation.kind === "command" &&
      [
        "onboard",
        "serve",
        "start",
        "stop",
        "restart",
        "status",
        "doctor",
        "uninstall",
        "logs",
        "capabilities",
        "acceptance",
        "provenance",
      ].includes(invocation.root);
    if (!isSetupCmd) {
      let onboarded = config.get("user.onboarded") === true;
      if (!onboarded) {
        try {
          const api = ctx.api();
          const backendState = await api.getOnboardingState();
          if (backendState.onboarded) {
            config.set("user.onboarded", "true", "user");
            if (backendState.name)
              config.set("user.name", backendState.name, "user");
            if (backendState.useCase)
              config.set("user.useCase", backendState.useCase, "user");
            onboarded = true;
          }
        } catch {
          // Ignore backend lookup if service is down or fails
        }
      }
      if (!onboarded) {
        // Guided setup asks questions. With no terminal to answer them there is
        // nobody to ask, and starting the interview anyway left the process
        // waiting on a prompt that could never arrive — a script or a piped
        // invocation simply hung. Say what to run instead and exit.
        if (!process.stdin.isTTY) {
          out.error("Morrow has not been set up on this machine yet.");
          out.info("Run `morrow onboard` from a terminal once, then re-run this command.");
          return EXIT.USAGE;
        }
        out.print(
          out.bold(
            "Welcome to Morrow! Let's complete the quick setup guide first.",
          ),
        );
        out.print();
        return (await load.onboardCommand())(ctx, "", []);
      }
    }
    switch (invocation.kind) {
      case "interactive":
        return await (
          await load.chatCommand()
        )(ctx);
      case "prompt": {
        if (!invocation.prompt)
          throw usageError(
            "Missing prompt.",
            'Run `morrow "Explain this repository"` or `morrow run "…"`.',
          );
        const promptCtx = new Context({
          out,
          config,
          paths: config.paths,
          flags: { ...parsed.flags, message: invocation.prompt },
        });
        return await (
          await load.chatCommand()
        )(promptCtx);
      }
      case "command":
        break;
    }
    const { root, sub, args = [] } = invocation;
    // Primary product surface: ask (inspect), fix (agent), plan (plan-only),
    // new (fresh agent session). A trailing prompt makes them one-shot.
    const promptOf = () =>
      [sub, ...args].filter((v): v is string => Boolean(v)).join(" ");
    const chatWith = async (extra: Record<string, string | boolean>) =>
      (await load.chatCommand())(
        new Context({
          out,
          config,
          paths: config.paths,
          flags: { ...parsed.flags, ...extra },
        }),
      );
    switch (root) {
      case "ask": {
        const p = promptOf();
        return await chatWith({
          ...rootPermissionFlags("ask"),
          ...(p ? { message: p } : {}),
        });
      }
      case "fix": {
        const p = promptOf();
        return await chatWith({
          ...rootPermissionFlags("fix"),
          ...(p ? { message: p } : {}),
        });
      }
      case "yolo": {
        const p = promptOf();
        return await chatWith({
          ...rootPermissionFlags("yolo"),
          ...(p ? { message: p } : {}),
        });
      }
      case "plan": {
        const p = promptOf();
        return await chatWith({
          ...rootPermissionFlags("plan"),
          ...(p ? { message: p } : {}),
        });
      }
      case "new":
        return await chatWith({ new: true });
      case "cortex":
        return await (
          await load.cortexCommand()
        )(ctx, sub, args);
      case "acceptance":
        return await (
          await load.acceptanceCommand()
        )(ctx, sub, args);
      case "provenance":
        return await (
          await load.provenanceCommand()
        )(
          ctx,
          [sub, ...args].filter(
            (value): value is string => value !== undefined,
          ),
        );
      case "capabilities":
        return await (
          await load.capabilitiesCommand()
        )(ctx);
      case "build":
        return await (
          await load.buildCommand()
        )(
          ctx,
          [sub, ...args].filter(
            (value): value is string => value !== undefined,
          ),
        );
      case "mission": {
        // A bare `morrow mission` (no objective/subcommand) opens the interactive
        // shell / Mission Control; otherwise run the Verified Missions lifecycle.
        if (!sub) return await chatWith({});
        return await (
          await load.missionCommand()
        )(ctx, sub, args);
      }
      case "model":
        return await (
          await load.modelsCommand()
        )(ctx, sub ?? "", args);
      case "settings":
        return await configCommand(ctx, sub ?? "list", args);
      case "auth":
        return await (
          await load.providersCommand()
        )(ctx, authSub(sub), args);
      case "web":
      case "gui":
      case "ui":
        return await webCommand(ctx, args);
      case "status":
        return await status(ctx);
      case "doctor":
        return await doctor(ctx);
      case "update":
        return await update(ctx);
      case "onboard":
        return await (
          await load.onboardCommand()
        )(ctx, sub ?? "", args);
      case "serve":
        return flagBool(parsed.flags, "detach")
          ? (await serveDetached(ctx), EXIT.OK)
          : await serveForeground(ctx);
      case "start":
        await serveDetached(ctx);
        return EXIT.OK;
      case "stop":
        return await serviceStop(ctx);
      case "restart":
        return await restart(ctx);
      case "uninstall":
        return await (
          await load.uninstallCommand()
        )(ctx);
      case "logs":
        return await logs(ctx);
      case "config":
        return await configCommand(ctx, sub, args);
      case "projects":
        return await (
          await load.projectsCommand()
        )(ctx, sub ?? "", args);
      case "init":
        return await (
          await load.initCommand()
        )(
          ctx,
          [sub, ...args].filter(
            (value): value is string => value !== undefined,
          ),
        );
      case "chat":
        return await (
          await load.chatCommand()
        )(ctx);
      case "conversations":
        return await (
          await load.conversationsCommand()
        )(ctx, sub ?? "", args);
      case "conversation":
        return await (
          await load.conversationsCommand()
        )(ctx, sub ?? "", args);
      case "sessions":
        return await (
          await load.conversationsCommand()
        )(ctx, "list", []);
      case "session":
        return await (
          await load.conversationsCommand()
        )(ctx, sub ?? "list", args);
      case "resume": {
        const resumeCtx = new Context({
          out,
          config,
          paths: config.paths,
          flags: { ...parsed.flags, resume: sub ?? "" },
        });
        return await (
          await load.chatCommand()
        )(resumeCtx);
      }
      case "providers":
        return await (
          await load.providersCommand()
        )(ctx, sub ?? "", args);
      case "models":
        return await (
          await load.modelsCommand()
        )(ctx, sub ?? "", args);
      case "presets":
        return await (
          await load.presetsCommand()
        )(ctx, sub, args);
      case "tools":
        return await (
          await load.toolsCommand()
        )(ctx, sub, args);
      case "permissions":
        return await (
          await load.permissionsCommand()
        )(ctx, sub);
      case "audit":
        return await (
          await load.auditCommand()
        )(ctx, sub, args);
      case "memory":
        return await (
          await load.memoryCommand()
        )(ctx, sub, args);
      case "panic":
        return await (
          await load.panicCommand()
        )(ctx);
      case "skills":
        return await (
          await load.skillsCommand()
        )(ctx, sub, args);
      case "import":
        return await (
          await load.importCommand()
        )(ctx, sub ?? "", args);
      case "processes":
      case "ps":
        return await (
          await load.processesCommand()
        )(ctx, sub ?? "", args);
      case "worktrees":
      case "worktree":
        return await (
          await load.worktreesCommand()
        )(ctx, sub ?? "", args);
      case "integrate":
      case "integrations":
        return await (
          await load.integrationsCommand()
        )(ctx, sub ?? "", args);
      case "symbols":
      case "symbol-index":
        return await (
          await load.symbolsCommand()
        )(ctx, sub ?? "", args);
      case "schedule":
      case "schedules":
        return await (
          await load.scheduleCommand()
        )(ctx, sub, args);
      case "mcp":
        return await (
          await load.mcpCommand()
        )(ctx, sub, args);
      default:
        throw usageError(
          `Unknown command: ${root}`,
          "Run `morrow --help` for commands.",
        );
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
      if (interpreted.hint) {
        out.print();
        out.print(`  ${out.cyan(interpreted.hint)}`);
      }
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

function printVersion(out: Output): number {
  if (out.json) out.data({ version: VERSION });
  else out.print(VERSION);
  return EXIT.OK;
}
function printHelp(out: Output): number {
  const b = (s: string) => out.bold(s);
  const g = (s: string) => out.gray(s);
  const help = [
    `${b("MORROW")} ${g("· private intelligence, built around you")}`,
    "",
    b("Start here"),
    `  morrow                       ${g("open the terminal agent shell")}`,
    `  morrow web                   ${g("open the web interface in your browser")}`,
    `  morrow build "…"             ${g("create a new project and build it end to end")}`,
    `  morrow mission               ${g("open Mission Control in the terminal")}`,
    `  morrow ask "…"               ${g("inspect and answer — never writes")}`,
    `  morrow plan "…"              ${g("produce a plan — no execution, no writes")}`,
    `  morrow fix "…"               ${g("approval-gated coding workflow")}`,
    `  morrow build "…" --in DIR    ${g("build software in a directory, verified end to end")}`,
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
    `  morrow providers list        ${g("browse every supported model provider")}`,
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
    //
    // Grouped rather than run together, using the registry's own taxonomy so
    // the two surfaces stay identical.
    ...CATEGORY_ORDER.flatMap((category) => {
      const commands = builtinRegistry().inCategory(category);
      return commands.length === 0
        ? []
        : [
            `  ${g(CATEGORY_LABELS[category])}`,
            `    ${g(commands.map((command) => `/${command.name}`).join(" "))}`,
          ];
    }),
    "",
    g("Press / in a session to search them all."),
    "",
    g(
      "More: morrow projects | conversations | presets | tools | symbols | audit | skills | import hermes | serve | logs",
    ),
    g(
      "Options: --json --no-color --project --in --provider --model --preset --plan --read-only --yolo",
    ),
  ].join("\n");
  if (out.json) out.data({ version: VERSION, help });
  else out.print(help);
  return EXIT.OK;
}

function printCommandHelp(out: Output, command: string): number {
  const helpByCommand: Record<string, string> = {
    providers: [
      "Morrow providers — configure and inspect model providers",
      "",
      "Usage:",
      "  morrow providers list",
      "  morrow providers status",
      "  morrow providers configure <provider> [--key <key>] [--url <url>] [--model <id>]",
      "  morrow providers test <provider>",
      "  morrow providers remove <provider>",
    ].join("\n"),
    build: [
      "Morrow build — create a project and build it end to end",
      "",
      "Usage:",
      "  morrow build \"<what you want built>\" [--in <directory>] [--name <name>] [--timeout <seconds>] [--detach]",
      "",
      "The attached command cancels the durable mission when its timeout or signal ends the observation. --detach leaves it running.",
    ].join("\n"),
    run: [
      "Morrow run — execute one prompt and return its result",
      "",
      "Usage:",
      "  morrow run \"<prompt>\" [--provider <id>] [--model <id>]",
      "",
      "Ctrl+C cancels the active task. Use morrow mission or morrow build for durable, timeout-bounded execution.",
    ].join("\n"),
    start: [
      "Morrow start — start the background service",
      "",
      "Usage:",
      "  morrow start [--port <port>] [--host <host>]",
    ].join("\n"),
    stop: [
      "Morrow stop — stop the background service",
      "",
      "Usage:",
      "  morrow stop [--port <port>]",
    ].join("\n"),
    ps: [
      "Morrow ps — list background processes Morrow owns",
      "",
      "Usage:",
      "  morrow ps [--json]",
    ].join("\n"),
    ask: [
      "Morrow ask — inspect and answer; never writes",
      "",
      "Usage:",
      "  morrow ask \"<question>\" [--provider <id>] [--model <id>] [--in <directory>]",
      "  morrow ask --message \"<question>\"   (non-interactive)",
    ].join("\n"),
    models: [
      "Morrow models — inspect and select model routes",
      "",
      "Usage:",
      "  morrow models [list] [--all] [--refresh]",
      "  morrow models refresh",
      "  morrow models select [<model-id>]",
      "  morrow models info <model-id>",
      "",
      "--refresh fetches public model metadata (context windows, reasoning capability).",
      "Morrow never fetches it on its own, so a fresh install shows \"?\" until you do.",
    ].join("\n"),
  };
  // A command with no dedicated entry still must not fall through to running:
  // name it, and point at the command list rather than printing a bare title.
  const help = helpByCommand[command]
    ?? [`Morrow ${command}`, "", "Run `morrow --help` for the full command list."].join("\n");
  if (out.json) out.data({ version: VERSION, command, help });
  else out.print(help);
  return EXIT.OK;
}

async function status(ctx: Context): Promise<number> {
  const health = await ctx.api().health();
  const provider = await ctx.api().providerStatus();
  if (ctx.out.json) ctx.out.data({ health, provider });
  else
    ctx.out.keyValue([
      ["service", health.service],
      ["status", health.ok ? "healthy" : "unhealthy"],
      ["provider", provider.provider],
      ["model", provider.model],
      ["database", ctx.service.dbPath],
      ["web app", webAppUrl(ctx.service.baseUrl)],
    ]);
  return health.ok ? EXIT.OK : EXIT.SERVICE_UNAVAILABLE;
}

async function doctor(ctx: Context): Promise<number> {
  const pnpm = probePnpm(process.env);
  const checks: DoctorCheck[] = [
    { name: "version", ok: true, detail: VERSION, critical: true },
    {
      name: "platform",
      ok: true,
      detail: `${platform()} ${arch()}`,
      critical: false,
    },
    {
      name: "node",
      ok: Number(process.versions.node.split(".")[0]) >= 22,
      detail: process.versions.node,
      critical: true,
    },
    {
      name: "pnpm",
      ok: pnpm.ok,
      detail: pnpm.executable
        ? `${pnpm.detail} (${pnpm.executable})`
        : pnpm.detail,
      critical: pnpmIsCritical(process.env),
      fix: "Install pnpm only when running Morrow from source.",
    },
    { name: "config", ok: true, detail: "parsed", critical: true },
    writableDirectoryCheck(ctx.paths.home),
    databaseCheck(ctx.service.dbPath),
    skillsCheck(ctx.paths.home),
    {
      name: "terminal",
      ok: true,
      detail: `tty ${Boolean(process.stdout.isTTY)}; columns ${process.stdout.columns ?? "unknown"}; color ${ctx.out.color}`,
      critical: false,
    },
    {
      name: "unicode",
      ok: true,
      detail:
        process.platform === "win32"
          ? "UTF-8 output requested; use a modern Windows Terminal profile if glyphs render incorrectly"
          : "UTF-8 runtime",
      critical: false,
    },
    {
      name: "PATH",
      ok: Boolean(process.env.PATH),
      detail: process.env.PATH ? "available" : "not set",
      critical: false,
    },
  ];
  try {
    const health = await ctx.api().health();
    const identityOk =
      health.ok === true && health.service === "morrow-orchestrator";
    checks.push({
      name: "orchestrator",
      ok: identityOk,
      detail: identityOk
        ? `${health.service}; api ${health.apiVersion}; port ${ctx.service.port}; migrations ${health.migrations.applied}/${health.migrations.latest ?? "?"}`
        : "unexpected service identity",
      critical: true,
      fix: "Stop the process on the configured port, then run `morrow start`.",
    });
    const providers = await ctx.api().listProviders();
    const configured = providers.filter(
      (provider) => provider.configured,
    ).length;
    checks.push({
      name: "providers",
      ok: configured > 0,
      detail: `${configured} configured`,
      critical: false,
      fix: "Run `morrow auth login`.",
    });
    const projects = await ctx.api().listProjects();
    const registered = Boolean(
      ctx.paths.repoRoot &&
      projects.some(
        (project) =>
          project.workspacePath.toLowerCase() ===
          ctx.paths.repoRoot!.toLowerCase(),
      ),
    );
    checks.push({
      name: "repository",
      ok: registered,
      detail: ctx.paths.repoRoot
        ? registered
          ? "current repository registered"
          : "current repository not registered"
        : "not running inside a Morrow workspace",
      critical: false,
      fix: "Run `morrow init` from the repository.",
    });
    const terminal = await ctx.api().terminalCapabilities().catch(() => null);
    if (terminal) {
      checks.push({
        name: "process modes",
        ok: terminal.pipe.available,
        detail: terminal.pty.available ? "pipe + interactive PTY" : `pipe only; ${terminal.pty.detail}`,
        critical: false,
        ...(terminal.pty.available ? {} : { fix: "Use pipe mode, or install the optional node-pty dependency for interactive processes." }),
      });
    }
  } catch {
    checks.push({
      name: "orchestrator",
      ok: false,
      detail: `not reachable on ${ctx.service.host}:${ctx.service.port}`,
      critical: true,
      fix: "Run `morrow start`, then retry `morrow doctor`.",
    });
  }
  const ok = aggregateDoctor(checks).ok;
  const exportPath = flagBool(ctx.flags, "export")
    ? writeDiagnosticExport(
        doctorPayload(
          ok,
          checks,
          ctx.paths.logFile,
          diagnosticDirectory(ctx.paths.home),
        ),
        ctx.paths.home,
      )
    : undefined;
  const payload = doctorPayload(
    ok,
    checks,
    ctx.paths.logFile,
    exportPath ?? diagnosticDirectory(ctx.paths.home),
  );
  if (ctx.out.json) ctx.out.data(payload);
  else {
    ctx.out.heading("Morrow doctor");
    ctx.out.table(
      ["check", "status", "detail"],
      checks.map((check) => [
        check.name,
        doctorStatus(ctx.out, check),
        check.detail,
      ]),
    );
    // When pnpm resolution fails, surface every ranked candidate we tried so the
    // user can see why each was rejected (rather than a single opaque error).
    if (!pnpm.ok && pnpm.tried && pnpm.tried.length > 0) {
      ctx.out.print();
      ctx.out.heading("pnpm candidates checked");
      for (const attempt of pnpm.tried) {
        ctx.out.print(
          `  ${ctx.out.gray(`[${attempt.source}]`)} ${attempt.path} ${ctx.out.gray(`→ ${attempt.reason}`)}`,
        );
      }
    }
    ctx.out.info(`Logs: ${ctx.paths.logFile}`);
    ctx.out.info(
      `Diagnostics export: ${exportPath ?? `${diagnosticDirectory(ctx.paths.home)} (run with --export)`}`,
    );
    if (exportPath)
      ctx.out.success("Diagnostic export written without secrets.");
  }
  return ok ? EXIT.OK : EXIT.SERVICE_UNAVAILABLE;
}

function invalidConfigDoctor(
  out: Output,
  flags: Record<string, string | boolean>,
  _error: unknown,
): number {
  const paths = resolvePaths();
  const checks: DoctorCheck[] = [
    {
      name: "config",
      ok: false,
      detail: `invalid JSON in ${paths.userConfigFile}`,
      critical: true,
      fix: "Repair or move the config file, then rerun `morrow doctor`.",
    },
  ];
  const exportPath = flagBool(flags, "export")
    ? writeDiagnosticExport(
        doctorPayload(
          false,
          checks,
          paths.logFile,
          diagnosticDirectory(paths.home),
        ),
        paths.home,
      )
    : undefined;
  if (out.json)
    out.data(
      doctorPayload(
        false,
        checks,
        paths.logFile,
        exportPath ?? diagnosticDirectory(paths.home),
      ),
    );
  else {
    out.heading("Morrow doctor");
    out.table(
      ["check", "status", "detail"],
      [["config", out.red("fail"), checks[0]!.detail]],
    );
    out.info(checks[0]!.fix!);
    out.info(
      `Diagnostics export: ${exportPath ?? `${diagnosticDirectory(paths.home)} (run with --export)`}`,
    );
  }
  return EXIT.USAGE;
}

function doctorPayload(
  ok: boolean,
  checks: DoctorCheck[],
  logPath: string,
  diagnosticsExportPath: string,
) {
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

function writeDiagnosticExport(
  payload: ReturnType<typeof doctorPayload>,
  home: string,
): string {
  const directory = diagnosticDirectory(home);
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `morrow-doctor-${Date.now()}.json`);
  writeFileSync(
    path,
    `${JSON.stringify(redactDiagnostics(payload, home), null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  return path;
}

function doctorStatus(out: Output, check: DoctorCheck): string {
  if (check.ok) return out.green("pass");
  return check.critical ? out.red("failure") : out.yellow("warning");
}

function writableDirectoryCheck(home: string): DoctorCheck {
  try {
    accessSync(home, constants.R_OK | constants.W_OK);
    return {
      name: "data directory",
      ok: true,
      detail: `${home} (read/write)`,
      critical: true,
    };
  } catch {
    return {
      name: "data directory",
      ok: false,
      detail: `${home} is missing or not writable`,
      critical: true,
      fix: "Repair directory permissions or reinstall Morrow.",
    };
  }
}

function skillsCheck(home: string): DoctorCheck {
  const directory = process.env.MORROW_SKILLS_DIR ?? join(home, "skills");
  try {
    const count = readdirSync(directory, { withFileTypes: true }).filter(
      (entry) =>
        entry.isDirectory() &&
        existsSync(join(directory, entry.name, "SKILL.md")),
    ).length;
    return {
      name: "skills",
      ok: count > 0,
      detail: `${count} installed`,
      critical: false,
      fix: "Reinstall Morrow to restore bundled skills.",
    };
  } catch {
    return {
      name: "skills",
      ok: false,
      detail: `${directory} is not readable`,
      critical: false,
      fix: "Reinstall Morrow to restore bundled skills.",
    };
  }
}

function databaseCheck(path: string): DoctorCheck {
  if (!existsSync(path))
    return {
      name: "state database",
      ok: false,
      detail: `${path} not created yet`,
      critical: false,
      fix: "Start Morrow once to create local state.",
    };
  try {
    accessSync(path, constants.R_OK | constants.W_OK);
    return {
      name: "state database",
      ok: true,
      detail: `${path} (read/write)`,
      critical: true,
    };
  } catch {
    return {
      name: "state database",
      ok: false,
      detail: `${path} is not readable and writable`,
      critical: true,
      fix: "Repair file permissions or restore from backup.",
    };
  }
}

async function update(ctx: Context): Promise<number> {
  const latest = await fetchLatestVersion();
  if (!latest) {
    if (ctx.out.json)
      ctx.out.data({
        current: MORROW_VERSION,
        latest: null,
        updateAvailable: false,
      });
    else
      ctx.out.warn(
        "Could not check for updates (offline or source unavailable).",
      );
    return EXIT.OK;
  }
  const status = checkForUpdate(MORROW_VERSION, latest);
  if (ctx.out.json) ctx.out.data(status);
  else if (status.updateAvailable) {
    ctx.out.heading("Update available");
    ctx.out.keyValue([
      ["current", status.current],
      ["latest", status.latest],
    ]);
    ctx.out.info("Apply with: git pull && pnpm install && pnpm build");
  } else {
    ctx.out.success(`Morrow is up to date (${status.current}).`);
  }
  return EXIT.OK;
}

async function serviceStop(ctx: Context): Promise<number> {
  const stopped = await stop(ctx);
  if (ctx.out.json) ctx.out.data({ stopped });
  else ctx.out.info(stopped ? "Service stopped." : "Service was not running.");
  return EXIT.OK;
}
async function restart(ctx: Context): Promise<number> {
  await stop(ctx);
  await serveDetached(ctx);
  return EXIT.OK;
}
async function logs(ctx: Context): Promise<number> {
  const content = tailLog(ctx, Number(flagString(ctx.flags, "lines") ?? 100));
  if (ctx.out.json) ctx.out.data({ path: ctx.paths.logFile, content });
  else ctx.out.print(content || `No logs at ${ctx.paths.logFile}.`);
  return EXIT.OK;
}

async function configCommand(
  ctx: Context,
  sub: string | undefined,
  args: string[],
): Promise<number> {
  const scope =
    flagString(ctx.flags, "scope") === "project" ? "project" : "user";
  if (!sub || sub === "list") {
    const values = ctx.config.flat();
    if (ctx.out.json) ctx.out.data(values);
    else
      ctx.out.table(
        ["key", "value", "source"],
        values.map((value) => [value.key, value.value, value.source]),
      );
    return EXIT.OK;
  }
  /**
   * Privacy lives in the service, not in CLI config, because it is a hard gate
   * the runtime enforces: under `local_only` every remote provider is refused
   * outright. It used to be reachable only from the web settings page, so a
   * terminal-first person who connected a cloud provider was told their request
   * was blocked with no way to unblock it from the terminal.
   */
  if (sub === "privacy") {
    const api = ctx.api();
    const requested = (args[0] ?? "").trim().toLowerCase().replaceAll("-", "_");
    if (!requested) {
      const profile = await api.getAssistantProfile();
      if (ctx.out.json) ctx.out.data({ privacy: profile.defaultPrivacyMode });
      else {
        ctx.out.keyValue([["privacy", profile.defaultPrivacyMode]]);
        if (profile.defaultPrivacyMode === "local_only") {
          ctx.out.info("Remote providers are refused. Allow them with: morrow settings privacy controlled-cloud");
        }
      }
      return EXIT.OK;
    }
    if (requested !== "local_only" && requested !== "controlled_cloud" && requested !== "custom") {
      throw usageError(
        "Usage: morrow settings privacy [local-only|controlled-cloud|custom]",
        "local-only refuses every remote provider; controlled-cloud allows the providers you configured.",
      );
    }
    const updated = await api.setPrivacyMode(requested);
    if (ctx.out.json) ctx.out.data({ privacy: updated.defaultPrivacyMode });
    else ctx.out.success(`Privacy set to ${updated.defaultPrivacyMode}.`);
    return EXIT.OK;
  }
  if (sub === "path") {
    const paths = {
      user: ctx.paths.userConfigFile,
      project: ctx.paths.projectConfigFile,
    };
    if (ctx.out.json) ctx.out.data(paths);
    else
      ctx.out.keyValue([
        ["user", paths.user],
        ["project", paths.project ?? "not in project"],
      ]);
    return EXIT.OK;
  }
  const key = args[0];
  if (!key)
    throw usageError(
      `Usage: morrow config ${sub} <key>${sub === "set" ? " <value>" : ""}`,
    );
  if (sub === "get") {
    const value = ctx.config.get(key);
    if (value === undefined)
      throw new CliError(`Config key is not set: ${key}`, {
        exitCode: EXIT.NOT_FOUND,
      });
    if (ctx.out.json) ctx.out.data({ key, value });
    else ctx.out.print(String(value));
    return EXIT.OK;
  }
  if (sub === "set") {
    const value = args.slice(1).join(" ") || flagString(ctx.flags, "value");
    if (!value) throw usageError("Usage: morrow config set <key> <value>");
    ctx.config.set(key, value, scope);
    if (ctx.out.json) ctx.out.data({ key, value, scope });
    else ctx.out.success(`Set ${key}.`);
    return EXIT.OK;
  }
  if (sub === "unset") {
    ctx.config.unset(key, scope);
    if (ctx.out.json) ctx.out.data({ key, unset: true, scope });
    else ctx.out.success(`Unset ${key}.`);
    return EXIT.OK;
  }
  throw usageError(
    `Unknown config subcommand: ${sub}`,
    "Try: list, get, set, unset, path",
  );
}
