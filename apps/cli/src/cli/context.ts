import { MorrowApi } from "../client/api.js";
import { ConfigStore } from "../config/config.js";
import type { MorrowPaths } from "../config/paths.js";
import { Output } from "./output.js";
import { flagString } from "./args.js";

export interface ServiceConfig {
  host: string;
  port: number;
  baseUrl: string;
  dbPath: string;
}

/** Everything a command needs: output, config, resolved service target, flags. */
export class Context {
  readonly out: Output;
  readonly config: ConfigStore;
  readonly paths: MorrowPaths;
  readonly flags: Record<string, string | boolean>;
  readonly service: ServiceConfig;

  constructor(opts: {
    out: Output;
    config: ConfigStore;
    paths: MorrowPaths;
    flags: Record<string, string | boolean>;
    /** Programmatic override of the resolved service base URL, e.g. for
     *  pointing a test harness at an ephemeral server. Never set from CLI
     *  argv — no `--url`-style flag feeds this, to keep the service target
     *  independent from any subcommand's own `--url` (see resolveService). */
    serviceBaseUrl?: string;
  }) {
    this.out = opts.out;
    this.config = opts.config;
    this.paths = opts.paths;
    this.flags = opts.flags;
    this.service = resolveService(opts.config, opts.flags, opts.paths, opts.serviceBaseUrl);
  }

  api(): MorrowApi {
    return new MorrowApi(this.service.baseUrl);
  }

  /** Resolve the active preset: flag > config default > "balanced". */
  preset(): string {
    return flagString(this.flags, "preset") ?? (this.config.get("defaults.preset") as string | undefined) ?? "balanced";
  }
  provider(): string | undefined {
    return flagString(this.flags, "provider") ?? (this.config.get("defaults.provider") as string | undefined);
  }
  model(): string | undefined {
    return flagString(this.flags, "model") ?? (this.config.get("defaults.model") as string | undefined);
  }
}

function resolveService(config: ConfigStore, flags: Record<string, string | boolean>, paths: MorrowPaths, explicitBaseUrl?: string): ServiceConfig {
  const svc = config.merged.service ?? {};
  const host = flagString(flags, "host") ?? svc.host ?? process.env.MORROW_BIND_HOST ?? "127.0.0.1";
  const portRaw = flagString(flags, "port") ?? (svc.port !== undefined ? String(svc.port) : undefined) ?? process.env.PORT;
  const port = portRaw ? Number(portRaw) : 4317;
  // No CLI flag resolves the target Morrow service's own base URL: `--url` is
  // already the documented, tested flag for `providers configure`'s provider
  // endpoint (e.g. `providers configure openai-compatible --url <endpoint>`),
  // and a shared global `flags` object means the two would otherwise collide —
  // `providers configure ... --url https://example.com` would silently point
  // the CLI's own API client at https://example.com instead of the local
  // service. Point the CLI at a remote/non-default service via the
  // MORROW_SERVICE_URL env var, the `service.baseUrl` config key, or (for
  // programmatic/test callers only) Context's `serviceBaseUrl` option instead
  // (configFromEnvironment() already folds MORROW_SERVICE_URL into svc.baseUrl).
  const baseUrl = explicitBaseUrl ?? svc.baseUrl ?? `http://${host}:${port}`;
  const dbPath = flagString(flags, "db") ?? svc.dbPath ?? process.env.DATABASE_URL ?? paths.defaultDbPath;
  return { host, port, baseUrl, dbPath };
}
