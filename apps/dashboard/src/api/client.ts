import { ApiErrorSchema } from "@morrow/hosted-contracts";
import { z } from "zod";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

// In dev, relative /api paths go through vite.config.ts's proxy to a local
// hosted-api. In production there's no proxy — the dashboard (Pages) and
// hosted-api (Workers) are different origins — so VITE_HOSTED_API_URL (set
// in .env.production) is prepended instead.
const API_BASE = import.meta.env.VITE_HOSTED_API_URL ?? "";

export async function authedPost<T>(path: string, token: string, schema: z.ZodType<T>): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const structuredError = ApiErrorSchema.safeParse(body);
    throw new ApiClientError(
      response.status,
      structuredError.success ? structuredError.data.error.code : "HTTP_ERROR",
      structuredError.success ? structuredError.data.error.message : "The request could not be completed.",
    );
  }

  return schema.parse(body);
}
