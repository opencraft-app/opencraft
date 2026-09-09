import type { ReactNode } from "react";
import { useState, useSyncExternalStore } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";
import { AdaptivePanel, projectPanel, type PanelPage } from "@opencraft/workbench-runtime";

interface NativePanelPage extends PanelPage {
  readonly title: string;
  readonly content: ReactNode;
}
/** Native geometry adapter; page content owns its ScrollView, not selection. */
export function AdaptivePanelView({ controller, pages }: {
  readonly controller: AdaptivePanel;
  readonly pages: readonly [NativePanelPage, ...NativePanelPage[]];
}) {
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [width, setWidth] = useState(0);
  const secondary = pages.find(page => page.id === state.secondaryId);
  const { visible, canGoBack } = projectPanel(state, pages[0], secondary, width);
  const ordered = secondary ? [pages[0], secondary] : [pages[0]];
  return <View style={styles.root} onLayout={event => setWidth(event.nativeEvent.layout.width)}>
    {ordered.map((page, index) => {
      const shown = visible.includes(page.id);
      return <View key={page.id} accessibilityElementsHidden={!shown} importantForAccessibility={shown ? "auto" : "no-hide-descendants"}
        style={[styles.pane, page.id === visible[visible.length - 1] ? styles.trailing : { width: page.minWidth }, !shown && styles.hidden]}>
        {index > 0 && canGoBack ? <Pressable accessibilityRole="button" accessibilityLabel={`Back to ${pages[0].title}`} onPress={controller.back} style={styles.back}><Text>‹ {pages[0].title}</Text></Pressable> : null}
        {page.content}
      </View>;
    })}
  </View>;
}
const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: "row", minWidth: 0 },
  pane: { minWidth: 0 }, trailing: { flex: 1 }, hidden: { display: "none" },
  back: { padding: 16, minHeight: 44 },
});
