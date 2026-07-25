import { SignUp } from "@clerk/react";

const CLERK_APPEARANCE = { variables: { colorPrimary: "#6558d9", borderRadius: "8px" } };

// See login-page.tsx — Clerk's own card replaces our redundant wrapper card.
export function SignupPage() {
  return (
    <div className="auth-wrap">
      <div className="auth-mark" aria-hidden="true">
        M
      </div>
      <SignUp appearance={CLERK_APPEARANCE} forceRedirectUrl="/account" routing="hash" signInUrl="/login" />
    </div>
  );
}
