import { useEffect, useState, type ReactNode } from "react";
import { StyleSheet, View } from "react-native";
import { resolveHostPanelGeometry, type BotCommand, type HostPanelState } from "@opencraft/mobile-bot-bridge";
import { MobileShellPanelButton } from "./mobile-shell-panel-button.shared";

type Props = { state: HostPanelState | null; enabled: boolean; zh: boolean; send: (command: BotCommand) => void };

export function MobileAgentPanelToggle({ state, enabled, zh, send }: Props) {
  if (!enabled || !state?.available) return null;
  const label = state.open ? (zh ? "返回对话" : "Back to chat") : (zh ? "文件与预览" : "Files and previews");
  return <MobileShellPanelButton side="right" open={state.open} label={label}
    onPress={() => send({ type: "chat-panel", command: { ownerId: state.ownerId, action: "open", open: !state.open } })} />;
}

/** Native container geometry only. The complete original RightPanel, including
 * tabs, menus and renderer residency, stays in the same local DOM runtime. */
export function MobileAgentPanelSurface({ state, enabled, send, children }: Props & { children: ReactNode }) {
  const [width, setWidth] = useState(0);
  const geometry = resolveHostPanelGeometry(width, enabled ? state : null, 0);
  const geometryWire = JSON.stringify(geometry);
  useEffect(() => {
    if (!state || width <= 0) return;
    send({ type: "chat-panel-geometry", ownerId: state.ownerId, geometry: JSON.parse(geometryWire) as typeof geometry });
  }, [state?.ownerId, geometryWire, send, width]);
  return <View style={styles.plane} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    {children}
  </View>;
}
const styles = StyleSheet.create({
  plane: { flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" },
});
