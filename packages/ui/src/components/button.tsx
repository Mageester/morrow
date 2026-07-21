import { Slot } from "@radix-ui/react-slot";
import { clsx } from "clsx";
import type { ComponentPropsWithRef, Ref } from "react";

interface ButtonOwnProps {
  size?: "default" | "compact";
  variant?: "primary" | "secondary" | "ghost" | "danger";
}

type NativeButtonProps = Omit<
  ComponentPropsWithRef<"button">,
  keyof ButtonOwnProps | "asChild"
> & {
  asChild?: false;
};

type ComposedButtonProps = Omit<
  ComponentPropsWithRef<"button">,
  keyof ButtonOwnProps | "asChild" | "ref"
> & {
  asChild: true;
  ref?: Ref<HTMLElement>;
};

export type ButtonProps = ButtonOwnProps &
  (NativeButtonProps | ComposedButtonProps);

export function Button(props: ButtonProps) {
  const {
    asChild = false,
    className,
    ref,
    size = "default",
    type,
    variant = "primary",
    ...elementProps
  } = props;

  const sharedProps = {
    className: clsx("morrow-button", className),
    "data-size": size,
    "data-variant": variant,
    ...elementProps,
  };

  if (asChild) {
    return <Slot {...sharedProps} ref={ref as Ref<HTMLElement>} />;
  }

  return (
    <button
      {...sharedProps}
      ref={ref as Ref<HTMLButtonElement>}
      type={type ?? "button"}
    />
  );
}
