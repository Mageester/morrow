import type { OAuthFinding } from "@morrow/contracts";

/**
 * Findings on subscription-based OAuth sign-in for Codex (OpenAI), Claude
 * (Anthropic), and Gemini (Google).
 *
 * Operator decision: Morrow now implements subscription sign-in for Claude and
 * Codex using the same first-party OAuth client ids and PKCE flow the official
 * CLIs use (see provider/oauth-flow.ts). This is enabled deliberately and is
 * surfaced to the user with an explicit security/ToS warning. We still do NOT
 * scrape cookies or reuse an existing browser session — sign-in goes through the
 * provider's real OAuth endpoints. These integrations reuse first-party client
 * ids and may be subject to provider terms; provider-side changes can break
 * them. Gemini has no comparable consumer-subscription OAuth and stays API-key.
 */
export const OAUTH_FINDINGS: OAuthFinding[] = [
  {
    id: "codex-oauth",
    label: "Codex / ChatGPT OAuth (OpenAI)",
    status: "available",
    reason:
      "Subscription sign-in is available via the Codex CLI's first-party OAuth client and PKCE. This reuses a first-party client id and may be subject to OpenAI's terms of service; ChatGPT/Codex tokens target OpenAI's Codex backend and may need extra configuration for general chat. Tokens are stored locally.",
    recommendation: "Sign in below, or use the OpenAI provider with an API key (set OPENAI_API_KEY) for the documented path.",
    documentationUrl: "https://platform.openai.com/docs/api-reference/authentication",
  },
  {
    id: "claude-oauth",
    label: "Claude OAuth (Anthropic)",
    status: "available",
    reason:
      "Subscription sign-in is available via Claude Code's first-party OAuth client and PKCE. This reuses a first-party client id and may be subject to Anthropic's terms of service; subscription inference is intended for Anthropic's own tools and may be rejected. Tokens are stored locally.",
    recommendation: "Sign in below, or use the Anthropic provider with an API key (set ANTHROPIC_API_KEY) for the documented path.",
    documentationUrl: "https://docs.anthropic.com/en/api/getting-started",
  },
  {
    id: "gemini-oauth",
    label: "Gemini OAuth (Google)",
    status: "unavailable",
    reason:
      "The documented Gemini Generative Language API uses API keys. Google OAuth 2.0 exists for Google Cloud / Vertex AI via service or user cloud credentials, but that is a cloud-account flow, not a consumer-subscription third-party OAuth sign-in for a desktop app.",
    recommendation:
      "Use the Gemini provider with an API key (set GEMINI_API_KEY), or run a fully private local model via Ollama.",
    documentationUrl: "https://ai.google.dev/gemini-api/docs/api-key",
  },
];
