import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { pairingQueries } from "../../api/pairing.js";

/**
 * "unpaired" and "inactive" are the only states shown — always a soft,
 * dismissible-feeling note, never a lockout. "active" and "unknown" (paired
 * but hosted-api unreachable, e.g. a network blip) both render nothing: a
 * transient remote hiccup must never alarm a user about their local work.
 * See Plans/generic-sprouting-dragon.md Phase 4.
 */
export function PairingBanner() {
  const status = useQuery(pairingQueries.status());
  const state = status.data?.status ?? "unpaired";

  if (status.isPending || state === "active" || state === "unknown") return null;

  if (state === "unpaired") {
    return (
      <div aria-live="polite" className="morrow-pairing-banner" role="status">
        <span>Not connected to an account. Pairing is optional and only affects billing sync.</span>
        <Link to="/pair">Pair this install</Link>
      </div>
    );
  }

  return (
    <div aria-live="polite" className="morrow-pairing-banner morrow-pairing-banner--warn" role="status">
      Subscription inactive. Your local work is unaffected.
    </div>
  );
}
