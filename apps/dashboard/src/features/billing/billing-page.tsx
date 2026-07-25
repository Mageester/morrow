import { StatusPill, Surface } from "@morrow/ui";
import { RequireAuth } from "../../app/require-auth.js";

// No paid plan exists yet (confirmed 2026-07-24 — free only for now), so
// there is nothing to sell and no Upgrade button to stub. When a paid plan
// is defined, this page grows a real Stripe Checkout button — see
// Plans/generic-sprouting-dragon.md Phase 3. Until then this page just
// states the truth: everyone is on Free.
function BillingContent() {
  return (
    <div className="dashboard-body">
      <h1>Billing</h1>
      <Surface className="account-surface" variant="raised">
        <div className="row">
          <div className="grow">
            <h3>
              Free <StatusPill>free</StatusPill>
            </h3>
            <p className="hint">
              Morrow is free right now — no paid plan exists yet.
            </p>
          </div>
        </div>
      </Surface>
    </div>
  );
}

export function BillingPage() {
  return (
    <RequireAuth>
      <BillingContent />
    </RequireAuth>
  );
}
