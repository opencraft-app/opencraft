import { View, StyleSheet } from "react-native";
import { Bot, CircleUserRound, CreditCard } from "lucide-react-native";
import { Button } from "heroui-native";
import type { LightVelaRegion } from "@opencraft/plugin-lightvela-hermes/account-contract";
import type { LightVelaSiteTab } from "../runtime/lightvela-site-webview";

const styles = StyleSheet.create({
  bar: { flexDirection: "row", borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#e9e5ef", backgroundColor: "#fff", paddingHorizontal: 8, paddingTop: 5, paddingBottom: 2 },
  button: { flex: 1, height: 54, paddingHorizontal: 0, borderRadius: 12, backgroundColor: "transparent" },
  content: { alignItems: "center", justifyContent: "center", gap: 2 },
  icon: { width: 31, height: 29, alignItems: "center", justifyContent: "center", borderRadius: 10 },
  activeIcon: { backgroundColor: "#f0eaff" },
  label: { fontSize: 11, lineHeight: 14, fontWeight: "500", color: "#89818f" },
  activeLabel: { fontWeight: "600", color: "#672ad4" },
});

export function LightVelaSiteTabs({ region, language, activeTab, onSelect }: {
  readonly region: LightVelaRegion;
  readonly language: string | null;
  readonly activeTab: LightVelaSiteTab | null;
  readonly onSelect: (tab: LightVelaSiteTab) => void;
}) {
  const chinese = language ? language.toLowerCase().startsWith("zh") : region === "cn";
  const items = [
    { id: "agents", label: chinese ? "我的智能体" : "My agents", Icon: Bot },
    { id: "account", label: chinese ? "账号" : "Account", Icon: CircleUserRound },
    { id: "billing", label: chinese ? "套餐与费用" : "Billing", Icon: CreditCard },
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
          onPress={() => onSelect(id)}
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
