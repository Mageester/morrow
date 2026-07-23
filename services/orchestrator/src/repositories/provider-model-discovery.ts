import type Database from "better-sqlite3";
import { DiscoveredModelSchema, ProviderAuthModeSchema, ProviderIdSchema, type DiscoveredModel, type ProviderAuthMode, type ProviderId } from "@morrow/contracts";

export interface ProviderModelDiscovery {
  providerId: ProviderId;
  authMode: ProviderAuthMode;
  status: "available" | "unavailable";
  models: DiscoveredModel[];
  errorKind: string | null;
  fetchedAt: string;
  expiresAt?: string;
  lastSuccessAt?: string | null;
  credentialIdentity?: string | null;
}

function fromRow(row: any): ProviderModelDiscovery | null {
  try {
    const parsed = DiscoveredModelSchema.array().safeParse(JSON.parse(row.models_json));
    const providerId = ProviderIdSchema.safeParse(row.provider_id);
    const authMode = ProviderAuthModeSchema.safeParse(row.auth_mode);
    if (!parsed.success || !providerId.success || !authMode.success
      || (row.status !== "available" && row.status !== "unavailable")
      || typeof row.fetched_at !== "string" || Number.isNaN(Date.parse(row.fetched_at))
      || typeof row.expires_at !== "string" || Number.isNaN(Date.parse(row.expires_at))
      || (row.last_success_at !== null && (typeof row.last_success_at !== "string" || Number.isNaN(Date.parse(row.last_success_at))))
      || (row.credential_identity !== null && (typeof row.credential_identity !== "string" || !/^[a-f0-9]{64}$/i.test(row.credential_identity)))) return null;
    return {
      providerId: providerId.data,
      authMode: authMode.data,
      status: row.status,
      models: parsed.data,
      errorKind: row.error_kind ?? null,
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      lastSuccessAt: row.last_success_at ?? null,
      credentialIdentity: row.credential_identity ?? null,
    };
  } catch {
    return null;
  }
}

export function providerModelDiscoveryRepository(db: Database.Database) {
  return {
    upsert(input: ProviderModelDiscovery): ProviderModelDiscovery {
      const prior = this.get(input.providerId, input.authMode);
      const models = input.status === "unavailable" && input.models.length === 0 ? prior?.models ?? [] : input.models;
      const lastSuccessAt = input.status === "available"
        ? input.lastSuccessAt ?? input.fetchedAt
        : input.lastSuccessAt ?? prior?.lastSuccessAt ?? null;
      const expiresAt = input.expiresAt ?? new Date(Date.parse(input.fetchedAt) + 15 * 60_000).toISOString();
      db.prepare(`INSERT INTO provider_model_discovery
        (provider_id,auth_mode,status,models_json,error_kind,fetched_at,expires_at,last_success_at,credential_identity)
        VALUES(?,?,?,?,?,?,?,?,?)
        ON CONFLICT(provider_id,auth_mode) DO UPDATE SET
          status=excluded.status,models_json=excluded.models_json,error_kind=excluded.error_kind,fetched_at=excluded.fetched_at,
          expires_at=excluded.expires_at,last_success_at=excluded.last_success_at,credential_identity=excluded.credential_identity`)
        .run(input.providerId, input.authMode, input.status, JSON.stringify(models), input.errorKind, input.fetchedAt, expiresAt, lastSuccessAt, input.credentialIdentity ?? prior?.credentialIdentity ?? null);
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
    isFresh(providerId: ProviderId, authMode: ProviderAuthMode, at = new Date(), credentialIdentity?: string | null): boolean {
      const item = this.get(providerId, authMode);
      return item !== null
        && item.expiresAt !== undefined
        && Date.parse(item.expiresAt) > at.getTime()
        && (credentialIdentity === undefined || item.credentialIdentity === credentialIdentity);
    },
  };
}
