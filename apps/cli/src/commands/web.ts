import type { Context } from "../cli/context.js";
import { EXIT } from "../cli/errors.js";
import { ensureRunning } from "../service/lifecycle.js";
import { flagBool } from "../cli/args.js";
import { openBrowser } from "./provider-oauth.js";

/**
 * Morrow ships a full web interface -- home, missions, connections, settings --
 * served by the same local service the CLI talks to. Until this command existed
 * nothing in the product said so: `morrow --help` listed forty commands and
 * forty-five slash commands without naming the GUI once, and the URL appeared
 * in no output, so the only way to find it was to read the orchestrator source.
 */
export function webAppUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/app/`;
}

export async function webCommand(
  ctx: Context,
  args: string[] = [],
): Promise<number> {
  const url = webAppUrl(ctx.service.baseUrl);

  if (ctx.out.json) {
    // Printing the URL must not depend on the service being up: a script asking
    // where the app lives is not asking for it to be started.
    ctx.out.data({ url });
    return EXIT.OK;
  }

  // The service serves the app, so a URL handed over while it is down is a
  // connection error with extra steps.
  await ensureRunning(ctx);

  ctx.out.print();
  ctx.out.print(`  ${ctx.out.bold("Morrow web interface")}`);
  ctx.out.print(`  ${ctx.out.cyan(url)}`);
  ctx.out.print();
  ctx.out.print(
    ctx.out.gray("  It runs on your machine and talks to the same local"),
  );
  ctx.out.print(
    ctx.out.gray("  service as this CLI. Nothing leaves your computer."),
  );
  ctx.out.print();

  const suppressed =
    flagBool(ctx.flags, "no-open") ||
    args.includes("--no-open") ||
    args.includes("print");
  if (suppressed) return EXIT.OK;

  openBrowser(url);
  ctx.out.print(
    ctx.out.gray(
      "  Opening it in your browser. `morrow web print` just shows the URL.",
    ),
  );
  ctx.out.print();
  return EXIT.OK;
}
