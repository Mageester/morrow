import { describe, expect, it } from "vitest";
import { redactSecrets, redactSecretsExhaustive, redactionCandidate } from "../src/provider/credentials.js";

/**
 * `redactSecrets` short-circuits on a cheap superset test before running the
 * seven-pass chain. These tests are the contract for that guard: the fast path
 * must be indistinguishable from the unguarded chain for every input, so a
 * performance change can never silently leak a credential.
 */

const CORPUS = [
  "",
  "no secrets here, just prose about carts and receipts",
  "const total = items.reduce((sum, item) => sum + item.price, 0);",
  "Authorization: Bearer sk-abcdefghijklmnop",
  "authorization: Basic dXNlcjpwYXNzd29yZA==",
  "proxy-authorization: Bearer abcdefgh12345678",
  "authorization: none",
  "authorization: disabled",
  "Set-Cookie: session=abcdefgh12345678; Path=/; HttpOnly",
  "cookie: sid=abcdefgh12345678; theme=dark",
  "x-api-key: abcdefgh12345678",
  "x-goog-api-key: 'abcdefgh12345678'",
  "api-token: \"abcdefgh12345678\"",
  "x-client-secret: abcdefgh12345678",
  "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrst",
  "ANTHROPIC_AUTH_TOKEN=abcdefghijklmnopqrst",
  "cache_key=abcdefghijklmnopqrst",
  "index_key: abcdefghijklmnopqrst",
  "object_key = abcdefghijklmnopqrst",
  "KEY=abcdefghijklmnopqrst",
  "key=short",
  "refresh_token: abcdefghijklmnopqrst",
  "private_key: '-----BEGIN PRIVATE KEY-----'",
  "passphrase: correct-horse-battery",
  "passwd: hunter22hunter22",
  "https://user:pa55word@example.com/path",
  "postgres://admin:secretpw@db.internal:5432/morrow",
  "ghp_abcdefghijklmnopqrst and gho_abcdefghijklmnopqrst",
  "xoxb-1234567890-abcdefghijkl",
  "AIzaSyABCDEFGHIJKLMNOPQRSTUVWX",
  "AKIAIOSFODNN7EXAMPLE",
  "aizasyabcdefghijklmnopqrstuvwx",
  "The word keystone appears but no assignment",
  "session",
  "://",
  "jwt",
  "token: {nested: true}",
  "token: [1,2,3]",
];

const ALPHABET = "abcdefgh ABC012_-=:;\"'`{}[],./\n\tkeytokensecretauthcookiejwtpasssessionbearer:/sk-ghp_xoxb-AIzaAKIA";

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

describe("redactSecrets fast path", () => {
  it("matches the unguarded chain across the curated corpus", () => {
    for (const input of CORPUS) {
      expect(redactSecrets(input), `input: ${JSON.stringify(input)}`).toBe(redactSecretsExhaustive(input));
    }
  });

  it("never skips an input the unguarded chain would have rewritten", () => {
    for (const input of CORPUS) {
      if (redactSecretsExhaustive(input) !== input) {
        expect(redactionCandidate(input), `guard rejected a redactable input: ${JSON.stringify(input)}`).toBe(true);
      }
    }
  });

  it("matches the unguarded chain across seeded random strings", () => {
    const random = seededRandom(0x5eed);
    for (let iteration = 0; iteration < 20_000; iteration++) {
      const length = 1 + Math.floor(random() * 64);
      let input = "";
      for (let index = 0; index < length; index++) {
        input += ALPHABET[Math.floor(random() * ALPHABET.length)];
      }
      const guarded = redactSecrets(input);
      const exhaustive = redactSecretsExhaustive(input);
      if (guarded !== exhaustive) {
        throw new Error(`fast path diverged for ${JSON.stringify(input)}: ${JSON.stringify(guarded)} !== ${JSON.stringify(exhaustive)}`);
      }
    }
  });
});
