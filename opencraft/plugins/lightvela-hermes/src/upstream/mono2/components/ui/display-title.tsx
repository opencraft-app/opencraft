// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { ElementType, HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export type DisplayTitleSize = "card" | "dialog" | "section" | "page" | "hero";

export const displayTitleBaseClass = "font-display-zh font-semibold tracking-[-0.05em] text-[var(--text-primary)]";

export const displayTitleSizeClasses: Record<DisplayTitleSize, string> = {
  card: "text-lg sm:text-xl",
  dialog: "text-xl",
  section: "text-xl sm:text-2xl",
  page: "text-2xl sm:text-[2rem]",
  hero: "text-4xl sm:text-5xl lg:text-[4.4rem]",
};

export const displayTitleClass = (size: DisplayTitleSize, className?: string) =>
  cn(displayTitleBaseClass, displayTitleSizeClasses[size], className);

interface DisplayTitleProps extends HTMLAttributes<HTMLElement> {
  as?: ElementType;
  children: ReactNode;
  size?: DisplayTitleSize;
}

export const DisplayTitle = ({
  as: Comp = "h1",
  children,
  className,
  size = "page",
  ...props
}: DisplayTitleProps) => {
  return (
    <Comp
      className={displayTitleClass(size, className)}
      {...props}
    >
      {children}
    </Comp>
  );
};
