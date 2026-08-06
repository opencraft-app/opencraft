import {
  createContext,
  useContext,
  type ComponentType,
  type ReactElement,
  type ReactNode,
} from "react";

export interface NavigationLinkProps {
  children: ReactElement;
  href: string;
}

export type NavigationLinkComponent = ComponentType<NavigationLinkProps>;

const NavigationLinkContext = createContext<NavigationLinkComponent | null>(
  null,
);

export function NavigationLinkProvider({
  children,
  component,
}: {
  children: ReactNode;
  component: NavigationLinkComponent;
}) {
  return (
    <NavigationLinkContext.Provider value={component}>
      {children}
    </NavigationLinkContext.Provider>
  );
}

/**
 * Wraps a pressable in the host router's link when one is mounted, so a
 * conversation row or a rail button carries a real href on the Web and stays a
 * plain button on native.
 */
export function MaybeLink({
  children,
  href,
}: {
  children: ReactElement;
  href: string | undefined;
}) {
  const NavigationLink = useContext(NavigationLinkContext);
  return href && NavigationLink ? (
    <NavigationLink href={href}>{children}</NavigationLink>
  ) : (
    children
  );
}
