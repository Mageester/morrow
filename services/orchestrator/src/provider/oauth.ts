import type { OAuthFinding } from "@morrow/contracts";

/**
 * Honest findings on subscription-based "OAuth" sign-in for Codex (OpenAI),
 * Claude (Anthropic), and Gemini (Google).
 *
 * Morrow's hard rule: a flow is only labeled "OAuth" when it is an officially
 * supported, documented third-party integration. We do NOT reverse-engineer
 * private authentication, extract browser cookies, reuse session tokens, imitate
 * another application's OAuth client, or implement undocumented token exchange.
 *
 * As of this milestone, none of the three consumer subscriptions publish a
 * documented third-party OAuth client flow that an independent desktop app may
 * use to act on a user's subscription. The documented programmatic path for all
 * three is an API key (Vertex AI additionally uses Google Cloud service
 * credentials, which is a cloud-account flow rather than consumer OAuth).
 * Operators should re-verify the linked documentation, as provider terms change.
 */
export const OAUTH_FINDINGS: OAuthFinding[] = [
  {
    id: "codex-oauth",
    label: "Codex / ChatGPT OAuth (OpenAI)",
    status: "unavailable",
    reason:
      "OpenAI does not publish a third-party OAuth client flow that lets an independent application sign in to a user's ChatGPT or Codex subscription. The documented programmatic path is API keys.",
    recommendation: "Use the OpenAI provider with an API key (set OPENAI_API_KEY).",
    documentationUrl: "https://platform.openai.com/docs/api-reference/authentication",
  },
  {
    id: "claude-oauth",
    label: "Claude OAuth (Anthropic)",
    status: "unavailable",
    reason:
      "Anthropic does not offer a public third-party OAuth flow for signing an arbitrary application into a consumer Claude subscription. The documented programmatic path is API keys.",
    recommendation: "Use the Anthropic provider with an API key (set ANTHROPIC_API_KEY).",
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
