import { useAuth, useClerk, useUser } from "@clerk/react";
import { Link, Outlet } from "@tanstack/react-router";

// Deliberately no sidebar — the design gate (docs/redesign/06-hosted-accounts-design-gate.md)
// calls for a thin top bar since the dashboard is only 4 screens. apps/web keeps its full
// sidebar shell; this is a separate trust boundary, not a second copy of that product.
export function AppShell() {
  const { isLoaded, isSignedIn } = useAuth();
  const { user } = useUser();
  const { signOut } = useClerk();

  return (
    <div className="dashboard-shell">
      <header className="dashboard-shell__top">
        <span className="dashboard-shell__mark" aria-hidden="true" />
        <Link className="dashboard-shell__brand" to="/">
          Morrow
        </Link>
        <div className="dashboard-shell__spacer" />
        {isLoaded && isSignedIn && user ? (
          <>
            <span className="dashboard-shell__who">{user.primaryEmailAddress?.emailAddress}</span>
            <Link className="dashboard-shell__nav-link" to="/billing">
              Billing
            </Link>
            <Link className="dashboard-shell__nav-link" to="/account">
              Account
            </Link>
            <button className="dashboard-shell__nav-link" onClick={() => void signOut()} type="button">
              Sign out
            </button>
          </>
        ) : null}
      </header>
      <Outlet />
    </div>
  );
}
