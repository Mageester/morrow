import { ClerkProvider } from "@clerk/react";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@morrow/ui/styles.css";
import { AppProviders } from "./app/providers.js";
import { createDashboardRouter } from "./app/router.js";
import "./styles/app.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("The Morrow dashboard root was not found.");
}

const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!publishableKey) {
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set (see apps/dashboard/.env.local).");
}

const router = createDashboardRouter();

createRoot(root).render(
  <StrictMode>
    <ClerkProvider afterSignOutUrl="/login" publishableKey={publishableKey}>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </ClerkProvider>
  </StrictMode>,
);
