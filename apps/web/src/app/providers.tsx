import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { RuntimeStatusProvider } from "../state/runtime-status.js";
import { ThemeProvider } from "../state/theme.js";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            refetchOnWindowFocus: false,
            retry: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <RuntimeStatusProvider>{children}</RuntimeStatusProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
