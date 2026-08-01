import { Button, Surface } from "@morrow/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ApiClientError } from "../../api/client.js";
import { pairingApi } from "../../api/pairing.js";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

const CODE_LENGTH = 6;

/** Codes are issued from an uppercase alphabet with no separators. Accept what
 * people actually type — lowercase, a pasted trailing space, a hand-added dash
 * — instead of rejecting it as an unknown code. The orchestrator normalises
 * again on the way out; this is so the field visibly matches the dashboard.
 *
 * The length cap belongs here rather than on the input's maxLength: the DOM
 * enforces maxLength against the raw keystrokes, so a typed "ABC-234" hit the
 * limit on the separator and dropped the final character. Trimming after the
 * separators are gone is what actually bounds it to a real code. */
function normalizeCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, CODE_LENGTH);
}

const ACCOUNT_URL = "https://morrowapp.getaxiom.ca";

export function PairPage() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");

  const redeem = useMutation({
    mutationFn: () => pairingApi.redeem({ code: normalizeCode(code) }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["pairing", "status"] });
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!code.trim() || redeem.isPending) return;
    redeem.mutate();
  }

  return (
    <section aria-labelledby="pair-heading" className="morrow-page morrow-pair">
      <div className="morrow-page__heading">
        <h1 id="pair-heading">Pair this install</h1>
        <p>
          This links your account for billing and entitlement only — Morrow still runs entirely on
          this machine.
        </p>
      </div>

      {redeem.isSuccess ? (
        <Surface className="morrow-pair__result">
          <p role="status">This install is now paired.</p>
        </Surface>
      ) : (
        <Surface className="morrow-pair__form-surface">
          <form className="morrow-pair__form" onSubmit={submit}>
            <label className="morrow-pair__field">
              <span>Code from your Morrow account dashboard</span>
              <input
                autoComplete="off"
                // Six characters, no separator — the placeholder used to read
                // "XXX-XXX", so people typed the dash they were shown.
                // maxLength is deliberately loose; normalizeCode does the real
                // trimming once separators are stripped.
                maxLength={32}
                name="pairing-code"
                onChange={(event) => setCode(normalizeCode(event.target.value))}
                placeholder="ABC234"
                spellCheck={false}
                value={code}
              />
              <span className="morrow-pair__hint">
                Generate one under “Connected local installs” at{" "}
                <a href={ACCOUNT_URL} rel="noreferrer" target="_blank">
                  morrowapp.getaxiom.ca
                </a>
                . Codes expire after 10 minutes and work once.
              </span>
            </label>
            <Button disabled={!code.trim() || redeem.isPending} type="submit">
              {redeem.isPending ? "Connecting…" : "Connect"}
            </Button>
          </form>
          {redeem.isError ? (
            <p role="alert">
              {safeError(redeem.error, "Could not pair this install. Check the code and try again.")}
            </p>
          ) : null}
        </Surface>
      )}
    </section>
  );
}
