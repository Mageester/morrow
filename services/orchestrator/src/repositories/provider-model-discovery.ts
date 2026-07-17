import type Database from "better-sqlite3";
import { DiscoveredModelSchema, ProviderAuthModeSchema, ProviderIdSchema, type DiscoveredModel, type ProviderAuthMode, type ProviderId } from "@morrow/contracts";

export interface ProviderModelDiscovery {
  providerId: ProviderId;
  authMode: ProviderAuthMode;
  status: "available" | "unavailable";
  models: DiscoveredModel[];
  errorKind: string | null;
  fetchedAt: string;
}

function fromRow(row: any): ProviderModelDiscovery | null {
  try {
    const parsed = DiscoveredModelSchema.array().safeParse(JSON.parse(row.models_json));
    const providerId = ProviderIdSchema.safeParse(row.provider_id);
    const authMode = ProviderAuthModeSchema.safeParse(row.auth_mode);
    if (!parsed.success || !providerId.success || !authMode.success
      || (row.status !== "available" && row.status !== "unavailable")
      || typeof row.fetched_at !== "string" || Number.isNaN(Date.parse(row.fetched_at))) return null;
    return {
      providerId: providerId.data,
      authMode: authMode.data,
      status: row.status,
      models: parsed.data,
      errorKind: row.error_kind ?? null,
      fetchedAt: row.fetched_at,
    };
  } catch {
    return null;
  }
}

export function providerModelDiscoveryRepository(db: Database.Database) {
  return {
    upsert(input: ProviderModelDiscovery): ProviderModelDiscovery {
      db.prepare(`INSERT INTO provider_model_discovery
        (provider_id,auth_mode,status,models_json,error_kind,fetched_at)
        VALUES(?,?,?,?,?,?)
        ON CONFLICT(provider_id,auth_mode) DO UPDATE SET
          status=excluded.status,models_json=excluded.models_json,error_kind=excluded.error_kind,fetched_at=excluded.fetched_at`)
        .run(input.providerId, input.authMode, input.status, JSON.stringify(input.models), input.errorKind, input.fetchedAt);
      return this.get(input.providerId, input.authMode)!;
    },
    get(providerId: ProviderId, authMode: ProviderAuthMode): ProviderModelDiscovery | null {
      const row = db.prepare("SELECT * FROM provider_model_discovery WHERE provider_id=? AND auth_mode=?")
        .get(providerId, authMode);
      return row ? fromRow(row) : null;
    },
    list(): ProviderModelDiscovery[] {
      return (db.prepare("SELECT * FROM provider_model_discovery ORDER BY provider_id,auth_mode").all() as any[])
        .map(fromRow)
        .filter((item): item is ProviderModelDiscovery => item !== null);
    },
  };
}
