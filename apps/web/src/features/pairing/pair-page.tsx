import { Button, Surface } from "@morrow/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { ApiClientError } from "../../api/client.js";
import { pairingApi } from "../../api/pairing.js";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

export function PairPage() {
  const queryClient = useQueryClient();
  const [code, setCode] = useState("");

  const redeem = useMutation({
    mutationFn: () => pairingApi.redeem({ code: code.trim() }),
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
                maxLength={32}
                name="pairing-code"
                onChange={(event) => setCode(event.target.value)}
                placeholder="XXX-XXX"
                value={code}
              />
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
