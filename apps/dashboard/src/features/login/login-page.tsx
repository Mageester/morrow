import { SignIn } from "@clerk/react";

const CLERK_APPEARANCE = { variables: { colorPrimary: "#bb5836", borderRadius: "8px" } };

// Clerk's <SignIn/> already renders its own full card (heading, OAuth
// buttons, form, footer) — wrapping it in a second branded card duplicated
// the heading and nested two boxes visually. Just the mark sits above it.
export function LoginPage() {
  return (
    <div className="auth-wrap">
      <div className="auth-mark" aria-hidden="true">
        M
      </div>
      <SignIn appearance={CLERK_APPEARANCE} forceRedirectUrl="/account" routing="hash" signUpUrl="/signup" />
    </div>
  );
}
