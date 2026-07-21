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

createRoot(root).render(
  <StrictMode>
    <AppProviders>
      <RouterProvider router={router} />
    </AppProviders>
  </StrictMode>,
);
