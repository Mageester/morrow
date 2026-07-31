import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@morrow/ui/styles.css";
import { AppProviders } from "./app/providers.js";
import { createAppRouter } from "./app/router.js";
import "./styles/app.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("The Morrow application root was not found.");
}

const router = createAppRouter();

let rootErrorSequence = 0;

function reportSafeRootError(kind: "caught" | "uncaught"): void {
  rootErrorSequence += 1;
  console.error("Morrow interface error.", {
    correlationId: `ui-${Date.now().toString(36)}-${rootErrorSequence.toString(36)}`,
    kind,
  });
}

createRoot(root, {
  onCaughtError: (_error, _errorInfo) => reportSafeRootError("caught"),
  onUncaughtError: (_error, _errorInfo) => reportSafeRootError("uncaught"),
}).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
