import { useAuth } from "@clerk/react";
import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn } = useAuth();
  if (!isLoaded) return null;
  if (!isSignedIn) return <Navigate to="/login" />;
  return <>{children}</>;
}
