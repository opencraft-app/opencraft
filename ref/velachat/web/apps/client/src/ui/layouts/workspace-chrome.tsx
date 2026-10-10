import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { View } from "react-native";
import { StyleSheet } from "react-native-unistyles";

import { PlatformFrame, type PlatformFrameProps } from "./app-frame";

/**
 * Stable app chrome for a server workspace. Section screens render body only
 * (`framed={false}`); this host owns the rail / bottom bar so membership and
 * instance identity do not reset when the active section swaps.
 */
export type WorkspaceChromeProps = Omit<
  PlatformFrameProps,
  "navigation" | "renderCompactNavigation"
> & {
  navigation?: ReactNode;
  renderCompactNavigation?(): ReactNode;
};

type CompactNavigationRegistrar = (
  render: (() => ReactNode) | null,
) => void;

const CompactNavigationRegistrarContext =
  createContext<CompactNavigationRegistrar | null>(null);
const WorkspaceChromeHostContext = createContext(false);

/** True when rendered under a parent WorkspaceChrome (server layout / Style Lab). */
export function useWorkspaceChromeHost(): boolean {
  return useContext(WorkspaceChromeHostContext);
}

export function WorkspaceChrome({
  children,
  navigation = null,
  renderCompactNavigation,
  ...frameProps
}: WorkspaceChromeProps) {
  const [registeredCompactNavigation, setRegisteredCompactNavigation] =
    useState<(() => ReactNode) | null>(null);
  const registerCompactNavigation = useRef<CompactNavigationRegistrar>(
    (render) => {
      setRegisteredCompactNavigation(() => render);
    },
  ).current;

  return (
    <WorkspaceChromeHostContext.Provider value={true}>
      <CompactNavigationRegistrarContext.Provider
        value={registerCompactNavigation}
      >
        <PlatformFrame
          {...frameProps}
          navigation={navigation}
          {...(renderCompactNavigation
            ? {renderCompactNavigation}
            : registeredCompactNavigation
              ? {renderCompactNavigation: registeredCompactNavigation}
              : {})}
        >
          {children}
        </PlatformFrame>
      </CompactNavigationRegistrarContext.Provider>
    </WorkspaceChromeHostContext.Provider>
  );
}

/**
 * Chat registers a custom compact bar (conversation picker / search hide).
 * No-op outside WorkspaceChrome. Pass `null` on desktop to clear a prior
 * chat registration when the hosted section is not chat.
 */
export function useRegisterCompactNavigation(
  render: (() => ReactNode) | null | undefined,
): void {
  const register = useContext(CompactNavigationRegistrarContext);
  const renderRef = useRef(render);
  renderRef.current = render;

  useLayoutEffect(() => {
    if (!register || render === undefined) return;
    if (render === null) {
      register(null);
      return () => register(null);
    }
    register(() => renderRef.current?.() ?? null);
    return () => register(null);
  }, [register, render === null, render === undefined]);
}

/**
 * Section body under a parent WorkspaceChrome. An explicit row keeps the
 * collection sidebar and stage as separate flex children — do not rely on
 * fragment flattening into PlatformFrame's shell row.
 */
export function workspaceSectionBody(
  navigation: ReactNode,
  children: ReactNode,
): ReactNode {
  if (!navigation) return children;
  return (
    <View style={styles.sectionBody}>
      {navigation}
      {children}
    </View>
  );
}

const styles = StyleSheet.create(() => ({
  sectionBody: {
    flex: 1,
    flexDirection: "row",
    minHeight: 0,
    minWidth: 0,
  },
}));
