import { View, StyleSheet } from "react-native";
import { Bot, CircleUserRound, CreditCard, Settings2 } from "lucide-react-native";
import { Button } from "heroui-native";
import type { LightVelaSiteTab } from "../runtime/lightvela-site-webview";
import { mobileLanguageCopy, type MobileLanguage } from "../runtime/mobile-language";

const styles = StyleSheet.create({
  bar: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#e9e5ef", backgroundColor: "#fff", paddingHorizontal: 8, paddingTop: 5, paddingBottom: 2 },
  button: { flex: 1, height: 54, paddingHorizontal: 0, borderRadius: 12, backgroundColor: "transparent" },
  content: { alignItems: "center", justifyContent: "center", gap: 2 },
  icon: { width: 31, height: 29, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  activeIcon: { backgroundColor: "#f0eaff" },
  label: { fontSize: 11, lineHeight: 14, fontWeight: "500", color: "#89818f" },
  activeLabel: { fontWeight: "600", color: "#672ad4" },
});

export function LightVelaSiteTabs({ language, activeTab, onSelect, onSettings }: {
  readonly language: MobileLanguage;
  readonly activeTab: LightVelaSiteTab | "settings" | null;
  readonly onSelect: (tab: LightVelaSiteTab) => void;
  readonly onSettings: () => void;
}) {
  const copy = mobileLanguageCopy(language);
  const items = [
    { id: "agents", label: copy.agents, Icon: Bot },
    { id: "account", label: copy.account, Icon: CircleUserRound },
    { id: "billing", label: copy.billing, Icon: CreditCard },
    { id: "settings", label: copy.settings, Icon: Settings2 },
  ] as const;
  return (
    <View style={styles.bar}>
      {items.map(({ id, label, Icon }) => {
        const selected = activeTab === id;
        return <Button
          key={id}
          variant="ghost"
          feedbackVariant="scale"
          size="sm"
          style={styles.button}
          accessibilityRole="tab"
          accessibilityState={{ selected }}
          accessibilityLabel={label}
          onPress={() => id === "settings" ? onSettings() : onSelect(id)}
        >
          <View style={styles.content}>
            <View style={[styles.icon, selected && styles.activeIcon]}>
              <Icon size={19} strokeWidth={selected ? 2.2 : 1.9} color={selected ? "#672ad4" : "#89818f"} />
            </View>
            <Button.Label style={[styles.label, selected && styles.activeLabel]}>{label}</Button.Label>
          </View>
        </Button>;
      })}
    </View>
  );
}
