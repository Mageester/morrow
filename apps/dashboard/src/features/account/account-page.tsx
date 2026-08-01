import { useAuth, useUser } from "@clerk/react";
import { Button, StatusPill, Surface } from "@morrow/ui";
import { useMutation } from "@tanstack/react-query";
import { RequireAuth } from "../../app/require-auth.js";
import { ApiClientError } from "../../api/client.js";
import { pairingApi } from "../../api/pairing.js";

function safeError(error: unknown, fallback: string): string {
  return error instanceof ApiClientError ? error.message : fallback;
}

// TODO(Phase 4 remainder): "Connected local installs" (listing already-paired
// agents) still needs a GET /api/pairing/agents endpoint. This button only
// covers generating a code — redeeming it happens in apps/web's /pair screen.
function AccountContent() {
  const { user } = useUser();
  const { getToken } = useAuth();

  const createCode = useMutation({
    mutationFn: async () => {
      const token = await getToken();
      if (!token) throw new Error("No active session.");
      return pairingApi.createCode(token);
    },
  });

  return (
    <div className="dashboard-body">
      <h1>Account</h1>
      <Surface className="account-surface" variant="raised">
        <h3>Identity</h3>
        <div className="row">
          <div className="grow">
            <div>{user?.primaryEmailAddress?.emailAddress}</div>
          </div>
        </div>
      </Surface>
      <Surface className="account-surface" variant="raised">
        <h3>Connected local installs</h3>
        <p className="hint">
          No installs paired yet. Pair a local install to sync it with this account.
        </p>
        {createCode.data ? (
          <div className="row">
            <StatusPill variant="accent">{createCode.data.code}</StatusPill>
            <span className="hint">
              Expires in {Math.round(createCode.data.expiresInSeconds / 60)} minutes. Enter this code in
              your local Morrow install's Pair screen.
            </span>
          </div>
        ) : (
          <Button
            disabled={createCode.isPending}
            onClick={() => createCode.mutate()}
            variant="secondary"
          >
            {createCode.isPending ? "Generating…" : "Pair another install"}
          </Button>
        )}
        {createCode.isError ? (
          <p role="alert">{safeError(createCode.error, "Could not generate a pairing code. Try again.")}</p>
        ) : null}
      </Surface>
    </div>
  );
}

export function AccountPage() {
  return (
    <RequireAuth>
      <AccountContent />
    </RequireAuth>
  );
}
