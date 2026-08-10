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

const NavigationLinkContext = createContext<NavigationLinkComponent | null>(null);

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
 * Wraps a control in the host router's link when one is mounted. Keeping this
 * adapter beside the primitives prevents a reusable row from reaching upward
 * into the layout layer.
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
  ) : children;
}
