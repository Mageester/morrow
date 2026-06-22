import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { homedir } from "node:os";
import { Context } from "../cli/context.js";
import { EXIT, CliError } from "../cli/errors.js";
import { ensureRunning, stop, isRunning } from "../service/lifecycle.js";
import { ask, askSecret, confirm, select, validateDirectory } from "./common.js";
import { writeSecret } from "../config/env.js";
import { discoverSkills } from "../skills/registry.js";
import { localSkillsRoot } from "./skills.js";
import { chatCommand } from "./chat.js";

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

const KEY_ENV: Record<string, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  gemini: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

export async function onboardCommand(ctx: Context, sub: string, args: string[]): Promise<number> {
  if (sub === "reset") {
    ctx.config.unset("user.onboarded", "user");
    ctx.config.unset("user.onboardingStep", "user");
    ctx.config.unset("user.useCase", "user");
    ctx.config.unset("user.name", "user");
    ctx.config.unset("defaults.mode", "user");
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
    const project = (ctx.config.get("defaults.project") as string) || "None";

    ctx.out.heading("Morrow Onboarding Status");
    ctx.out.keyValue([
      ["Onboarded", onboarded ? ctx.out.green("Yes") : ctx.out.yellow("No")],
      ["Current Step", step],
      ["Name", name],
      ["Use Case", useCase],
      ["Default Mode", mode],
      ["Default Project", project],
    ]);
    return EXIT.OK;
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

    ctx.out.print();
    ctx.out.print(ctx.out.gray(`═ Horizon line ══════════════════════════════════════════════`));
    ctx.out.print(
      ctx.out.bold(`Step ${currentStepIdx + 1} of ${STEPS.length}: ${step.toUpperCase()}`)
    );
    ctx.out.print(ctx.out.gray(`═════════════════════════════════════════════════════════════`));
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

  // Completed Onboarding
  ctx.config.set("user.onboarded", "true", "user");
  ctx.config.unset("user.onboardingStep", "user");
  try {
    if (await isRunning(ctx)) {
      await ctx.api().saveOnboardingState({ onboarded: true, onboardingStep: null });
    }
  } catch {
    // ignore
  }

  ctx.out.success("Morrow setup complete! Welcome aboard.");
  return EXIT.OK;
}

async function runStep(step: string, ctx: Context): Promise<boolean> {
  switch (step) {
    case "welcome": {
      ctx.out.print(ctx.out.cyan(`   __  ______  ___ ___  _____      __`));
      ctx.out.print(ctx.out.cyan(`  /  |/  / __ \\/ _ \\ _ \\/ __ \\ \\    / /`));
      ctx.out.print(ctx.out.cyan(` / /|_/ / /_/ / , _/ , _/ /_/ /\\ \\/\\/ / `));
      ctx.out.print(ctx.out.cyan(`/_/  /_/\\____/_/|_/_/|_|\\____/  \\_/\\_/  `));
      ctx.out.print();
      ctx.out.print(ctx.out.bold("Private intelligence, built around you."));
      ctx.out.print();
      ctx.out.print(
        "Morrow is a self-hosted, private-first AI agent. Your code indices,"
      );
      ctx.out.print(
        "filesystem operations, and memories are kept locally on your machine."
      );
      ctx.out.print(
        "Morrow connects directly to model providers using keys you control."
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

      const options = [
        { id: "openai", label: "OpenAI (API-key Billing)" },
        { id: "anthropic", label: "Anthropic (API-key Billing)" },
        { id: "deepseek", label: "DeepSeek (API-key Billing)" },
        { id: "openrouter", label: "OpenRouter (API-key Billing)" },
        { id: "skip", label: "Skip / Continue with current providers" },
      ];

      while (true) {
        const statuses = await api.listProviders();
        ctx.out.print("Morrow connects directly to provider endpoints using your credentials.");
        ctx.out.print(
          ctx.out.yellow(
            "Note: Consumer subscriptions (ChatGPT Plus, Claude Pro) do NOT provide API credits."
          )
        );
        ctx.out.print("Configure billing on the developer platform of your provider.");
        ctx.out.print();

        ctx.out.print(ctx.out.bold("Current Provider Setup:"));
        for (const p of statuses) {
          const mark = p.configured ? ctx.out.green("● configured") : ctx.out.gray("○ not configured");
          if (["openai", "anthropic", "deepseek", "openrouter"].includes(p.id)) {
            ctx.out.print(`  ${mark}  ${ctx.out.bold(p.label)}`);
          }
        }
        ctx.out.print();

        const idx = await select(ctx, "Select a provider to configure:", options, (item) => item.label);
        const choice = options[idx]!;
        if (choice.id === "skip") {
          break;
        }

        const providerId = choice.id;
        const keyEnv = KEY_ENV[providerId]!;
        const key = await askSecret(`Enter your ${choice.label} API Key: `);
        if (!key) {
          ctx.out.warn("API key cannot be empty.");
          continue;
        }

        // Plaintext secrets warning
        ctx.out.print();
        ctx.out.warn(
          `WARNING: API keys are stored in plaintext in: ${ctx.paths.secretsFile}`
        );
        ctx.out.warn("Ensure you secure this file using filesystem owner-only permissions.");
        ctx.out.print();

        writeSecret(ctx.paths.secretsFile, keyEnv, key);

        // Validation
        ctx.out.info(`Validating connection to ${choice.label}…`);
        const result = await api.testProvider(providerId);
        if (result.ok) {
          ctx.out.success(`Validated! ${choice.label} is reachable (${result.latencyMs ?? 0} ms).`);
        } else {
          ctx.out.error(`Validation failed: ${result.detail}`);
          const retry = await confirm("Keep key anyway?", false);
          if (!retry) {
            writeSecret(ctx.paths.secretsFile, keyEnv, ""); // clear
          }
        }
        ctx.out.print();
      }

      ctx.out.info("Restarting service to load credentials…");
      await stop(ctx);
      await ensureRunning(ctx);
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

      if (choice.id === "yolo") {
        ctx.out.print();
        ctx.out.info(
          "YOLO mode enabled. Run with `morrow yolo` or set default autoApprove flags in presets."
        );
      }
      return true;
    }

    case "skills": {
      const skills = discoverSkills(localSkillsRoot());
      ctx.out.print("Skills are local scripts carrying out task operations on your files.");
      ctx.out.print("All skills run 100% locally. Morrow does not support remote skills or hosted market-places.");
      ctx.out.print();

      ctx.out.print(ctx.out.bold("Available Local Skills:"));
      for (const skill of skills) {
        ctx.out.print(`  ${ctx.out.cyan(skill.id)} (${skill.manifest.version})`);
        ctx.out.print(`    ${ctx.out.gray("Enables:")} ${skill.manifest.description}`);
        ctx.out.print(
          `    ${ctx.out.gray("Requested permissions:")} ${skill.manifest.requestedTools.join(
            ", "
          )}`
        );
        ctx.out.print();
      }

      const actions = [
        "Enable all local skills (Recommended)",
        "Review and select skills individually",
        "Skip / Leave current setup",
      ];
      const actionIdx = await select(ctx, "Choose Skill Setup Action:", actions, (item) => item);

      if (actionIdx === 0) {
        for (const skill of skills) {
          ctx.config.set(`skills.${skill.id}.enabled`, "true", "user");
        }
        ctx.out.success("All local skills enabled.");
      } else if (actionIdx === 1) {
        for (const skill of skills) {
          const enable = await confirm(`Enable skill '${skill.manifest.name}'?`, true);
          ctx.config.set(`skills.${skill.id}.enabled`, String(enable), "user");
        }
      }
      return true;
    }

    case "project": {
      await ensureRunning(ctx);
      const api = ctx.api();

      ctx.out.print("Scanning home directory for projects and Git repositories…");
      const repos = discoverLocalGitRepos();

      ctx.out.print();
      ctx.out.print(ctx.out.bold("Discovered Local Repositories:"));
      repos.forEach((r, i) => {
        ctx.out.print(`  ${ctx.out.cyan(String(i + 1))}. [Git] ${r.name} - ${r.path}`);
      });
      ctx.out.print();

      const options = [
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
      }

      ctx.out.info(`Registering project: ${name}…`);
      const project = await api.createProject(name, workspacePath);
      ctx.config.set("defaults.project", project.id, "user");
      ctx.out.success(`Registered successfully! Scoped to: ${project.workspacePath}`);
      return true;
    }

    case "mission": {
      const defaultProjId = ctx.config.get("defaults.project") as string;
      if (!defaultProjId) {
        ctx.out.info("No default project workspace registered. Skipping first mission launch.");
        return true;
      }

      await ensureRunning(ctx);
      const api = ctx.api();
      const project = await api.getProject(defaultProjId);

      ctx.out.print(`Morrow is ready to begin a mission inside: ${project.name}`);
      ctx.out.print("Provide a query, or choose an example mission below.");
      ctx.out.print();

      const examples = [
        "Explain the project entry point and structure.",
        "Scan this workspace for files and document them.",
        "Locate configuration scripts and check for errors.",
        "Enter a custom mission prompt…",
        "Finish setup without launching a mission",
      ];

      const idx = await select(ctx, "Select initial mission:", examples, (item) => item);
      if (idx === 4) {
        return true;
      }

      let missionText = examples[idx]!;
      if (idx === 3) {
        missionText = "";
        while (!missionText) {
          missionText = await ask("What would you like Morrow to help you with? ");
        }
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
