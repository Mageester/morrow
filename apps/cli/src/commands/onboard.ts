import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { Context } from "../cli/context.js";
import { flagBool } from "../cli/args.js";
import { EXIT, CliError } from "../cli/errors.js";
import { ensureRunning, isRunning } from "../service/lifecycle.js";
import { ask, askMultiline, confirm, select, validateDirectory } from "./common.js";
import { pickProvider, setupProvider } from "./provider-setup.js";
import { discoverSkills, isSafeDefaultSkill } from "../skills/registry.js";
import { localSkillsRoot } from "./skills.js";
import { chatCommand } from "./chat.js";
import { shouldUseInteractive, resolveUnicodeFlag } from "../terminal/capabilities.js";
import { runOnboardingLaunchpad } from "./onboard-ink.js";

const STEPS = [
  "welcome",
  "profile",
  "usecase",
  "provider",
  "mode",
  "skills",
  "project",
  "mission",
];

export async function onboardCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  if (sub === "reset") {
    ctx.config.unset("user.onboarded", "user");
    ctx.config.unset("user.onboardingStep", "user");
    ctx.config.unset("user.useCase", "user");
    ctx.config.unset("user.name", "user");
    ctx.config.unset("defaults.mode", "user");
    ctx.config.unset("defaults.autoApprove", "user");
    ctx.config.unset("defaults.project", "user");

    try {
      const skills = discoverSkills(localSkillsRoot());
      for (const skill of skills) {
        ctx.config.unset(`skills.${skill.id}.enabled`, "user");
      }
    } catch {
      // ignore
    }

    try {
      if (await isRunning(ctx)) {
        await ctx.api().resetOnboardingState();
      }
    } catch {
      // ignore
    }

    ctx.out.success("Onboarding state has been reset successfully.");
    return EXIT.OK;
  }

  if (sub === "status") {
    const onboarded = ctx.config.get("user.onboarded") === true;
    const step = (ctx.config.get("user.onboardingStep") as string) || "None";
    const name = (ctx.config.get("user.name") as string) || "None";
    const useCase = (ctx.config.get("user.useCase") as string) || "None";
    const mode = (ctx.config.get("defaults.mode") as string) || "None";
    const autoApprove = ctx.config.get("defaults.autoApprove") === true;
    const project = (ctx.config.get("defaults.project") as string) || "None";

    ctx.out.heading("Morrow Onboarding Status");
    ctx.out.keyValue([
      ["Onboarded", onboarded ? ctx.out.green("Yes") : ctx.out.yellow("No")],
      ["Current Step", step],
      ["Name", name],
      ["Use Case", useCase],
      ["Default Mode", mode],
      ["Auto Approve", autoApprove ? ctx.out.yellow("YOLO") : "No"],
      ["Default Project", project],
    ]);
    return EXIT.OK;
  }

  // A capable terminal gets the fast, value-first Ink path. The legacy flow
  // remains an explicit escape hatch (`morrow onboard classic`) and the safe
  // fallback for redirected/non-interactive terminals.
  if (sub !== "classic" && shouldUseInteractive({
    json: flagBool(ctx.flags, "json"),
    isTTY: Boolean(process.stdout.isTTY),
    stdinIsTTY: Boolean(process.stdin.isTTY),
    env: process.env,
  })) {
    const result = await runInkOnboarding(ctx);
    if (result !== "classic") return result;
  }

  // Guided Flow
  let currentStepIdx = 0;
  const savedStep = ctx.config.get("user.onboardingStep") as string;
  if (savedStep && STEPS.includes(savedStep) && sub !== "new") {
    ctx.out.print();
    const resume = await confirm(
      `Onboarding was interrupted at step '${savedStep}'. Would you like to resume?`,
      true
    );
    if (resume) {
      currentStepIdx = STEPS.indexOf(savedStep);
    }
  }

  while (currentStepIdx < STEPS.length) {
    const step = STEPS[currentStepIdx]!;
    ctx.config.set("user.onboardingStep", step, "user");

    try {
      if (await isRunning(ctx)) {
        await ctx.api().saveOnboardingState({ onboardingStep: step });
      }
    } catch {
      // ignore
    }

    ctx.out.print(ctx.out.gray(`─────────────────────────────────────────────────────────────`));
    ctx.out.print(
      ctx.out.bold(`Step ${currentStepIdx + 1} of ${STEPS.length}: ${step.toUpperCase()}`)
    );
    ctx.out.print(ctx.out.gray(`─────────────────────────────────────────────────────────────`));
    ctx.out.print();

    let success = false;
    try {
      success = await runStep(step, ctx);
    } catch (e: any) {
      ctx.out.error(`Error in step '${step}': ${e.message}`);
      const retry = await confirm("Would you like to retry this step?", true);
      if (!retry) {
        ctx.out.warn("Onboarding interrupted. Resume later by running `morrow onboard`.");
        return EXIT.ERROR;
      }
      continue;
    }

    if (success) {
      currentStepIdx++;
    } else {
      ctx.out.warn("Setup paused. Run `morrow onboard` to continue setup.");
      return EXIT.OK;
    }
  }

  await completeOnboarding(ctx);

  ctx.out.print();
  ctx.out.success("Morrow setup complete! Welcome aboard.");
  ctx.out.print();
  ctx.out.print(ctx.out.bold("Start utilizing your companion with these commands:"));
  ctx.out.print("  Launch interactive chat:       " + ctx.out.cyan("morrow"));
  ctx.out.print("  Build a new project from zero: " + ctx.out.cyan('morrow build "<what you want>"'));
  ctx.out.print("  Start with project autonomy:   " + ctx.out.cyan("morrow yolo"));
  ctx.out.print("  Check setup status:            " + ctx.out.cyan("morrow onboard status"));
  ctx.out.print("  Reset and rerun onboarding:    " + ctx.out.cyan("morrow onboard reset"));
  ctx.out.print();
  return EXIT.OK;
}

async function persistOnboardingStep(ctx: Context, step: string): Promise<void> {
  ctx.config.set("user.onboardingStep", step, "user");
  try {
    if (await isRunning(ctx)) await ctx.api().saveOnboardingState({ onboardingStep: step });
  } catch {
    // Local config remains the resumable source when the service is unavailable.
  }
}

async function completeOnboarding(ctx: Context): Promise<void> {
  // Collaborative agent mode is the safe useful default: workspace reads are
  // automatic; writes and commands still retain their approval boundary.
  if (!ctx.config.get("defaults.mode")) ctx.config.set("defaults.mode", "agent", "user");
  if (ctx.config.get("defaults.autoApprove") === undefined) ctx.config.set("defaults.autoApprove", "false", "user");
  ctx.config.set("user.onboarded", "true", "user");
  ctx.config.unset("user.onboardingStep", "user");
  try {
    if (await isRunning(ctx)) await ctx.api().saveOnboardingState({ onboarded: true, onboardingStep: null });
  } catch {
    // Completion is durable locally and will reconcile when the service starts.
  }
}

export async function runInkOnboarding(ctx: Context): Promise<number | "classic"> {
  await ensureRunning(ctx);
  const api = ctx.api();
  const unicode = resolveUnicodeFlag(ctx.config.get("ui.unicode") as boolean | undefined, process.env);
  let configured = (await api.listProviders()).some((provider) => provider.configured);
  await persistOnboardingStep(ctx, configured ? "launch" : "provider");

  let choice = await runOnboardingLaunchpad({ providerConfigured: configured, unicode });
  if (choice === "classic") return "classic";
  if (choice === "cancel") {
    ctx.out.info("Setup paused. Run `morrow onboard` to resume.");
    return EXIT.OK;
  }
  if (choice === "explore") {
    await completeOnboarding(ctx);
    ctx.out.success("Morrow is ready to explore.");
    ctx.out.info("Connect a model when you want to run a task: `morrow providers configure`.");
    return EXIT.OK;
  }

  if (choice === "connect") {
    const target = await pickProvider(ctx, api);
    if (target) {
      const result = await setupProvider(ctx, api, target, { interactive: true });
      if (!result.ok && result.detail) ctx.out.warn(result.detail);
    }
    configured = (await api.listProviders()).some((provider) => provider.configured);
    if (!configured) {
      ctx.out.warn("No model is connected yet. Setup is saved at this step.");
      ctx.out.info("Run `morrow onboard` to resume, or `morrow providers configure` directly.");
      return EXIT.OK;
    }
    await persistOnboardingStep(ctx, "launch");
    choice = await runOnboardingLaunchpad({ providerConfigured: true, unicode });
    if (choice === "classic") return "classic";
    if (choice === "cancel") {
      ctx.out.info("Your model connection is saved. Run `morrow onboard` to finish.");
      return EXIT.OK;
    }
  }

  await completeOnboarding(ctx);
  if (choice === "start") return chatCommand(ctx);
  ctx.out.success("Morrow setup is complete.");
  ctx.out.print("Run `morrow` to open the terminal, or `morrow config` for optional customization.");
  return EXIT.OK;
}

async function runStep(step: string, ctx: Context): Promise<boolean> {
  switch (step) {
    case "welcome": {
      ctx.out.print(ctx.out.cyan(`   __  ______  ___  ___  _____  _      __`));
      ctx.out.print(ctx.out.cyan(`  /  |/  / __ \\/ _ \\/ _ \\/ __ \\| |    / /`));
      ctx.out.print(ctx.out.cyan(` / /|_/ / /_/ / , _/ , _/ /_/ /| | /\\ / / `));
      ctx.out.print(ctx.out.cyan(`/_/  /_/\\____/_/|_/_/|_|\\____/  \\_/\\_/  `));
      ctx.out.print();
      ctx.out.print(ctx.out.bold("Private intelligence, built around you."));
      ctx.out.print();
      ctx.out.print(
        "Morrow is your private intelligence companion. Designed to run completely"
      );
      ctx.out.print(
        "on your local hardware, it keeps your code, indices, and memories strictly"
      );
      ctx.out.print(
        "confidential. Bring your own keys to access models directly, without intermediation."
      );
      ctx.out.print();
      ctx.out.print(ctx.out.gray("Estimated setup time: ~3 minutes"));
      ctx.out.print();
      await ask("Press Enter to begin guided setup...");
      return true;
    }

    case "profile": {
      ctx.out.print("Please tell us your name so Morrow can personalize interactions.");
      ctx.out.print();
      let name = "";
      while (!name) {
        name = await ask("What is your name? ");
      }
      ctx.config.set("user.name", name, "user");
      try {
        if (await isRunning(ctx)) {
          await ctx.api().saveOnboardingState({ name });
        }
      } catch {
        // ignore
      }
      ctx.out.success(`Thanks, ${name}!`);
      return true;
    }

    case "usecase": {
      ctx.out.print("Select your primary use case to help tailor prompt responses.");
      ctx.out.print();
      const options = [
        "Software Development",
        "AI Research",
        "Business & Operations",
        "General Productivity",
        "Custom / Personal",
      ];
      const idx = await select(ctx, "Primary Use Case", options, (item) => item);
      const chosen = options[idx]!;
      ctx.config.set("user.useCase", chosen, "user");
      try {
        if (await isRunning(ctx)) {
          await ctx.api().saveOnboardingState({ useCase: chosen });
        }
      } catch {
        // ignore
      }
      return true;
    }

    case "provider": {
      await ensureRunning(ctx);
      const api = ctx.api();

      ctx.out.print("Morrow talks directly to model providers using your own credentials.");
      ctx.out.print("Pick as many as you like — you can switch between them at any time.");
      ctx.out.print();
      ctx.out.print(
        ctx.out.gray(
          "Some providers let you sign in with a subscription you already pay for; the rest use an API key from their console."
        )
      );
      ctx.out.print(ctx.out.gray(`Credentials are stored locally at ${ctx.paths.secretsFile} and never sent anywhere but the provider you chose.`));

      // The whole flow — sign-in or key, persistence through the running
      // service, verification, and model discovery — is shared with
      // `morrow providers configure`, so onboarding is never the weaker path.
      while (true) {
        const target = await pickProvider(ctx, api);
        if (!target) break;

        try {
          // `onboard` is a guided, human-driven flow by definition, so it may
          // always prompt regardless of TTY detection.
          const result = await setupProvider(ctx, api, target, { interactive: true });
          if (!result.ok && result.detail) ctx.out.warn(result.detail);
        } catch (e: any) {
          // A failure on one provider must not abandon the whole setup step.
          ctx.out.error(`Could not set up ${target.label}: ${e.message}`);
        }

        ctx.out.print();
        if (!(await confirm("Set up another provider?", false))) break;
      }

      const configured = (await api.listProviders()).filter((p) => p.configured);
      if (configured.length === 0) {
        ctx.out.print();
        ctx.out.warn("No provider is configured yet — Morrow cannot run a model until one is.");
        ctx.out.info("Add one any time with `morrow providers configure`.");
      } else {
        ctx.out.print();
        ctx.out.success(`${configured.length} provider${configured.length === 1 ? "" : "s"} ready: ${configured.map((p) => p.label).join(", ")}.`);
      }
      return true;
    }

    case "mode": {
      ctx.out.print("Choose Morrow's execution and autonomy profile.");
      ctx.out.print();

      const options = [
        {
          id: "plan-only",
          title: "Plan",
          desc: "Designs plans for coding and inspections but NEVER writes to disk or runs code.",
        },
        {
          id: "read-only",
          title: "Inspect",
          desc: "Read-only access. Answers questions using local project indexing.",
        },
        {
          id: "agent",
          title: "Agent",
          desc: "Collaborative assistant. Auto-reads but requests approvals for writes & commands.",
        },
        {
          id: "yolo",
          title: "YOLO (Project Autonomy)",
          desc: "Autonomous execution scoped strictly to the project workspace. Hard-denies secret reads, escapes, destructive git, privilege escalation. Full diff/undo & panic stop are always active.",
        },
      ];

      const idx = await select(ctx, "Autonomy Level", options, (item) => `${item.title} - ${item.desc}`);
      const choice = options[idx]!;
      const mappedMode = choice.id === "yolo" ? "agent" : choice.id;
      ctx.config.set("defaults.mode", mappedMode, "user");
      ctx.config.set("defaults.autoApprove", String(choice.id === "yolo"), "user");

      if (choice.id === "yolo") {
        ctx.out.print();
        ctx.out.info(
          "YOLO mode enabled. Morrow is workspace-autonomous: it edits, runs, and verifies inside the workspace without prompting — not unlimited system access. Hard safety denials protect your secrets and system, while full audit logs, diffs, and undo commands remain active."
        );
      }
      return true;
    }

    case "skills": {
      const skills = discoverSkills(localSkillsRoot());
      const safe = skills.filter((s) => isSafeDefaultSkill(s.id, s.manifest.riskClass));
      const highRisk = skills.filter((s) => !isSafeDefaultSkill(s.id, s.manifest.riskClass));

      ctx.out.print("Skills are local scripts carrying out task operations on your files.");
      ctx.out.print("All skills run 100% locally. Morrow does not support remote skills or hosted marketplaces.");
      ctx.out.print();

      ctx.out.print(ctx.out.bold("Safe default skills:"));
      for (const skill of safe) {
        ctx.out.print(`  ${ctx.out.cyan(skill.id)} ${ctx.out.gray(`(${skill.manifest.riskClass} risk)`)}`);
        ctx.out.print(`    ${ctx.out.gray(skill.manifest.description)}`);
      }
      ctx.out.print();

      if (highRisk.length > 0) {
        ctx.out.print(ctx.out.bold(ctx.out.yellow("High-risk / red-team skills (disabled by default):")));
        ctx.out.print(
          ctx.out.gray(
            "  These probe or bypass model safety and can send data to external providers."
          )
        );
        ctx.out.print(ctx.out.gray("  They are never enabled by a blanket recommendation and must be approved one by one."));
        ctx.out.print();
      }

      const actions = [
        "Enable the safe default skills (Recommended)",
        "Review and select skills individually",
        "Skip / Leave current setup",
      ];
      const actionIdx = await select(ctx, "Choose Skill Setup Action:", actions, (item) => item);

      if (actionIdx === 0) {
        // Recommended path enables ONLY vetted safe-default skills; every
        // high-risk skill is explicitly left disabled.
        for (const skill of safe) ctx.config.set(`skills.${skill.id}.enabled`, "true", "user");
        for (const skill of highRisk) ctx.config.set(`skills.${skill.id}.enabled`, "false", "user");
        ctx.out.success(`Enabled ${safe.length} safe default skill${safe.length === 1 ? "" : "s"}.`);
        if (highRisk.length > 0) {
          ctx.out.info(
            `Left ${highRisk.length} high-risk skill${highRisk.length === 1 ? "" : "s"} disabled. Enable individually later with \`morrow skills enable <id>\`.`
          );
        }
      } else if (actionIdx === 1) {
        // Safe skills default to on; high-risk skills default to off and show
        // their risk and requested permissions before the individual prompt.
        for (const skill of safe) {
          const enable = await confirm(`Enable safe skill '${skill.manifest.name}'?`, true);
          ctx.config.set(`skills.${skill.id}.enabled`, String(enable), "user");
        }
        for (const skill of highRisk) {
          ctx.out.print();
          ctx.out.warn(`${skill.manifest.name} — ${skill.manifest.riskClass} risk`);
          ctx.out.print(`    ${ctx.out.gray(skill.manifest.description)}`);
          ctx.out.print(`    ${ctx.out.gray("Requested permissions:")} ${skill.manifest.requestedTools.join(", ")}`);
          if (skill.manifest.requestedNetworkDomains.length > 0) {
            ctx.out.print(`    ${ctx.out.gray("Network:")} ${skill.manifest.requestedNetworkDomains.join(", ")}`);
          }
          const enable = await confirm(`Enable HIGH-RISK skill '${skill.manifest.name}'?`, false);
          ctx.config.set(`skills.${skill.id}.enabled`, String(enable), "user");
        }
      }
      return true;
    }

    case "project": {
      await ensureRunning(ctx);
      const api = ctx.api();

      const cwdPath = resolve(process.cwd());
      const cwdName = basename(cwdPath) || "current-directory";

      ctx.out.print("Scanning home directory for projects and Git repositories…");
      const repos = discoverLocalGitRepos().filter((r) => resolve(r.path) !== cwdPath);

      ctx.out.print();
      ctx.out.print(ctx.out.bold("Discovered Local Repositories:"));
      ctx.out.print(`  1. [Current Directory] ${cwdName} - ${cwdPath}`);
      repos.forEach((r, i) => {
        ctx.out.print(`  ${ctx.out.cyan(String(i + 2))}. [Git] ${r.name} - ${r.path}`);
      });
      ctx.out.print();

      const options = [
        { type: "cwd", name: `${cwdName} (Current Directory)`, path: cwdPath },
        ...repos.map((r) => ({ type: "discovered", name: r.name, path: r.path })),
        { type: "custom", name: "Add a custom workspace path…", path: "" },
        { type: "skip", name: "Skip project registration", path: "" },
      ];

      const idx = await select(ctx, "Select a default project workspace:", options, (item) => item.name);
      const choice = options[idx]!;

      if (choice.type === "skip") {
        return true;
      }

      let workspacePath = choice.path;
      let name = choice.name;

      if (choice.type === "custom") {
        workspacePath = "";
        while (!workspacePath) {
          const custom = await ask("Workspace folder path: ");
          try {
            workspacePath = validateDirectory(custom);
            name = basename(workspacePath) || "Custom Workspace";
          } catch (e: any) {
            ctx.out.error(e.message);
          }
        }
      } else if (choice.type === "cwd") {
        name = cwdName;
      }

      ctx.out.info(`Registering project: ${name}…`);
      const project = await api.createProject(name, workspacePath);
      ctx.config.set("defaults.project", project.id, "user");
      ctx.out.success(`Registered successfully! Scoped to: ${project.workspacePath}`);
      return true;
    }

    case "mission": {
      await ensureRunning(ctx);
      const api = ctx.api();
      let defaultProjId = ctx.config.get("defaults.project") as string;

      if (!defaultProjId) {
        ctx.out.warn("No default project workspace registered.");
        ctx.out.print("Morrow works best when scoped to a project folder.");
        ctx.out.print();

        const noProjectOptions = [
          "Register current directory",
          "Enter a workspace path",
          "Start without a project",
          "Exit onboarding",
        ];

        const actionIdx = await select(ctx, "How would you like to proceed?", noProjectOptions, (item) => item);

        if (actionIdx === 0) {
          const cwdPath = resolve(process.cwd());
          const name = basename(cwdPath) || "Current Directory";
          ctx.out.info(`Registering project: ${name}…`);
          const project = await api.createProject(name, cwdPath);
          ctx.config.set("defaults.project", project.id, "user");
          ctx.out.success(`Registered successfully! Scoped to: ${project.workspacePath}`);
          defaultProjId = project.id;
        } else if (actionIdx === 1) {
          let workspacePath = "";
          let name = "";
          while (!workspacePath) {
            const custom = await ask("Workspace folder path: ");
            try {
              workspacePath = validateDirectory(custom);
              name = basename(workspacePath) || "Custom Workspace";
            } catch (e: any) {
              ctx.out.error(e.message);
            }
          }
          ctx.out.info(`Registering project: ${name}…`);
          const project = await api.createProject(name, workspacePath);
          ctx.config.set("defaults.project", project.id, "user");
          ctx.out.success(`Registered successfully! Scoped to: ${project.workspacePath}`);
          defaultProjId = project.id;
        } else if (actionIdx === 2) {
          ctx.out.info("Starting without a project workspace scope.");
        } else {
          ctx.out.info("Exiting onboarding.");
          return false;
        }
      }

      let project: any = null;
      if (defaultProjId) {
        project = await api.getProject(defaultProjId);
        ctx.out.print(`Morrow is ready to begin a mission inside: ${project.name}`);
      } else {
        ctx.out.print("Morrow is ready to begin a mission.");
      }
      ctx.out.print("Provide a query, or choose an example mission below.");
      ctx.out.print();

      // Identified by id rather than position: the previous version compared
      // the selected index against hardcoded 3 and 4, so inserting or
      // reordering an option silently changed which branch ran.
      const examples = [
        { id: "explain", label: "Explain the project entry point and structure." },
        { id: "document", label: "Scan this workspace for files and document them." },
        { id: "check", label: "Locate configuration scripts and check for errors." },
        { id: "custom", label: "Enter a custom mission prompt…" },
        { id: "finish", label: "Finish setup without launching a mission" },
      ];

      const idx = await select(ctx, "Select initial mission:", examples, (item) => item.label);
      const selected = examples[idx]!;
      if (selected.id === "finish") {
        return true;
      }

      let missionText = selected.label;
      if (selected.id === "custom") {
        missionText = "";
        while (!missionText) {
          missionText = await askMultiline("What would you like Morrow to help you with?");
          if (!missionText.trim()) {
            ctx.out.warn("Mission prompt cannot be empty.");
            missionText = "";
          }
        }
      }

      if (!project) {
        const cwdPath = resolve(process.cwd());
        const name = basename(cwdPath) || "Current Directory";
        ctx.out.info(`Auto-registering current directory: ${name} to launch mission…`);
        project = await api.createProject(name, cwdPath);
        ctx.config.set("defaults.project", project.id, "user");
      }

      ctx.out.info(`Starting mission: "${missionText}"…`);
      const conv = await api.createConversation(project.id, "First Mission");

      // Run chat interactive session directly with the prompt
      const chatCtx = new Context({
        out: ctx.out,
        config: ctx.config,
        paths: ctx.paths,
        flags: {
          ...ctx.flags,
          message: missionText,
          resume: conv.id,
          project: project.id,
          ...(ctx.config.get("defaults.autoApprove") === true ? { yolo: true } : {}),
        },
      });

      // Directly launch the interactive chat TUI
      await chatCommand(chatCtx);
      return true;
    }

    default:
      return true;
  }
}

function discoverLocalGitRepos(): Array<{ name: string; path: string }> {
  const home = homedir();
  const searchDirs = ["Documents", "Projects", "Code", "Repositories", "src"];
  const found: Array<{ name: string; path: string }> = [];

  for (const dirName of searchDirs) {
    const target = resolve(home, dirName);
    if (!existsSync(target)) continue;

    try {
      const children = readdirSync(target);
      for (const child of children) {
        const full = join(target, child);
        try {
          const stats = statSync(full);
          if (stats.isDirectory() && !child.startsWith(".")) {
            // Check if it contains .git
            const gitFolder = join(full, ".git");
            if (existsSync(gitFolder) && statSync(gitFolder).isDirectory()) {
              found.push({ name: child, path: full });
            }
          }
        } catch {
          // ignore subdirectory errors
        }
      }
    } catch {
      // ignore parent directory errors
    }
  }

  // Fallback to process.cwd() if it is a git repo
  try {
    const cwdGit = join(process.cwd(), ".git");
    if (existsSync(cwdGit) && statSync(cwdGit).isDirectory()) {
      const cwdName = basename(process.cwd());
      if (!found.some((r) => r.path === process.cwd())) {
        found.unshift({ name: cwdName, path: process.cwd() });
      }
    }
  } catch {
    // ignore
  }

  return found.slice(0, 10);
}
