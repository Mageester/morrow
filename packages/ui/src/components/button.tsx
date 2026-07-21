import { Slot } from "@radix-ui/react-slot";
import { clsx } from "clsx";
import type { ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  asChild?: boolean;
  size?: "default" | "compact";
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

export function Button({
  asChild = false,
  className,
  size = "default",
  type,
  variant = "primary",
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : "button";

  return (
    <Component
      className={clsx("morrow-button", className)}
      data-size={size}
      data-variant={variant}
      type={asChild ? undefined : (type ?? "button")}
      {...props}
    />
  );
}
