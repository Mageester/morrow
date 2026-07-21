import { StructuredApiErrorSchema } from "@morrow/contracts";
import { z } from "zod";

export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly traceId: string | null,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(
  path: string,
  init: RequestInit,
  schema: z.ZodType<T>,
): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  const body: unknown = await response.json().catch(() => null);

  if (!response.ok) {
    const structuredError = StructuredApiErrorSchema.safeParse(body);
    throw new ApiClientError(
      response.status,
      structuredError.success ? structuredError.data.error.code : "HTTP_ERROR",
      structuredError.success
        ? structuredError.data.error.message
        : "The request could not be completed.",
      response.headers.get("x-trace-id"),
    );
  }

  return schema.parse(body);
}

export const api = {
  get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return request(path, { method: "GET" }, schema);
  },

  post<TInput, TOutput>(
    path: string,
    input: TInput,
    schema: z.ZodType<TOutput>,
  ): Promise<TOutput> {
    return request(
      path,
      { body: JSON.stringify(input), method: "POST" },
      schema,
    );
  },
};
