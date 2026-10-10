import { useEffect, useRef, useState } from "react";
import { Button, Dialog, Input, Menu, Spinner } from "heroui-native";
import { History, MoreHorizontal, Pin, Plus } from "lucide-react-native";
import { StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { nativeTokens } from "@opencraft/design-system/tokens.native";
import type { BotConsoleState, BotSessionAction, BotSessionCommand } from "@opencraft/mobile-bot-bridge";
import { mobileVisualTokens as tokens } from "../runtime/mobile-visual-tokens";
import { MobileMenuFocus, MobileMenuFocusItem } from "./mobile-menu-focus";

const styles = StyleSheet.create({
  heading: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 18, marginBottom: 6, paddingLeft: 12 },
  label: { color: tokens.color.label, flex: 1, fontSize: 12, fontWeight: "600" },
  iconButton: { width: nativeTokens.metrics.toolbar.touchTarget, height: nativeTokens.metrics.toolbar.touchTarget, minWidth: nativeTokens.metrics.toolbar.touchTarget, backgroundColor: "transparent" },
  row: { flexDirection: "row", alignItems: "center", borderRadius: 12, minHeight: 44 },
  selected: { backgroundColor: tokens.color.selected },
  select: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: "flex-start", backgroundColor: "transparent", paddingHorizontal: 12 },
  title: { color: tokens.color.rowText, fontSize: 13, flex: 1 },
  active: { color: tokens.color.accent },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: tokens.color.accent },
  hint: { color: tokens.color.label, fontSize: 12, paddingHorizontal: 12, paddingVertical: 6 },
  menu: { width: "100%", maxWidth: 420, padding: 20, gap: 12 },
  menuTitle: { color: tokens.color.label },
  footer: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 8 },
});

/** Reserve the session layout on a first visit without exposing the previous Bot. */
export function MobileAgentSessionPlaceholder({ rows }: { rows: number }) {
  return <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    <View style={styles.heading}><View style={{ height: nativeTokens.metrics.toolbar.touchTarget }} /></View>
    {Array.from({ length: rows + 1 }, (_, index) => <View key={index} style={styles.row}>
      <View style={{ marginHorizontal: 12, height: 12, width: "65%", borderRadius: 6, backgroundColor: tokens.color.selected }} />
    </View>)}
  </View>;
}

/** Portable Expo presentation; the Web controller retains all mutation authority. */
export function MobileAgentSessions({ state, zh, onCommand }: {
  state: BotConsoleState;
  zh: boolean;
  onCommand: (command: BotSessionCommand) => void;
}) {
  // One transient menu owner for the list; the editor has an independent lifetime.
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ action: "rename" | "delete"; chatId: string } | null>(null);
  const [title, setTitle] = useState("");
  const activeOverlay = useRef({ menuId, editor }); activeOverlay.current = { menuId, editor };
  const { width } = useWindowDimensions();
  const safeArea = useSafeAreaInsets();
  const disabled = !state.commandsReady || state.pending;
  const editorSession = state.sessions.find(session => session.chatId === editor?.chatId);
  useEffect(() => { setMenuId(null); setEditor(null); }, [state.botId, state.selectedChatId, state.section]);
  useEffect(() => {
    if (disabled || (menuId && !state.sessions.some(session => session.chatId === menuId))) setMenuId(null);
    if (editor && !state.sessions.some(session => session.chatId === editor.chatId)) setEditor(null);
  }, [disabled, menuId, editor, state.sessions]);
  const execute = (command: BotSessionAction) => {
    setMenuId(null); setEditor(null);
    onCommand({ type: "session", botId: state.botId, ...command });
  };
  return <>
    <View style={styles.heading}>
      <History size={15} color={tokens.color.label} />
      <Text style={styles.label}>{zh ? "会话" : "Conversations"}</Text>
      <Button variant="ghost" style={styles.iconButton} isDisabled={disabled} accessibilityLabel={zh ? "新对话" : "New conversation"}
        onPress={() => execute({ action: "create" })}><Plus size={19} color={tokens.color.accent} /></Button>
    </View>
    <View style={[styles.row, state.section === "chat" && state.selectedChatId === "" && styles.selected]}>
      <Button variant="ghost" style={styles.select} isDisabled={disabled} onPress={() => execute({ action: "create" })}>
        <Button.Label style={styles.title}>{zh ? "新对话" : "New conversation"}</Button.Label>
      </Button>
    </View>
    {state.loading && state.sessions.length === 0 ? <Spinner size="sm" style={{ margin: 12 }} color={tokens.color.accent} /> : null}
    {state.sessions.filter(session => session.chatId !== "").map(session => <View key={session.chatId} style={[styles.row, state.section === "chat" && state.selectedChatId === session.chatId && styles.selected]}>
      <Button variant="ghost" style={styles.select} isDisabled={disabled} onPress={() => execute({ action: "select", chatId: session.chatId })}>
        <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 5 }}>
          {session.pinned ? <Pin size={12} color={tokens.color.label} /> : null}
          <Button.Label numberOfLines={1} style={[styles.title, state.selectedChatId === session.chatId && styles.active]}>{session.title}</Button.Label>
          {session.unread ? <View style={styles.dot} /> : null}
        </View>
      </Button>
      <Menu isOpen={menuId === session.chatId && !disabled} isDisabled={disabled}
        onOpenChange={open => setMenuId(current => open ? session.chatId : current === session.chatId ? null : current)}>
        <Menu.Trigger asChild isDisabled={disabled}>
          <Button variant="ghost" isIconOnly style={styles.iconButton} isDisabled={disabled}
            accessibilityLabel={zh ? `管理会话 ${session.title}` : `Manage ${session.title}`}>
            <MoreHorizontal size={17} color={tokens.color.label} />
          </Button>
        </Menu.Trigger>
        <Menu.Portal unstable_accessibilityContainerViewIsModal>
          <Menu.Overlay accessibilityLabel={zh ? "关闭会话菜单" : "Close conversation menu"} />
          <MobileMenuFocus dismiss={() => setMenuId(current => current === session.chatId ? null : current)}
            allowReturnFocus={() => !activeOverlay.current.menuId && !activeOverlay.current.editor}>
          <Menu.Content presentation="popover" placement="bottom" align="end" offset={4}
            width={Math.min(240, Math.max(0, width - safeArea.left - safeArea.right - 16))}
            insets={{ top: safeArea.top + 8, bottom: safeArea.bottom + 8, left: safeArea.left + 8, right: safeArea.right + 8 }}
            accessibilityLabel={zh ? "会话操作" : "Conversation actions"}>
            <Menu.Label numberOfLines={1} style={styles.menuTitle}>{session.title}</Menu.Label>
            <MobileMenuFocusItem disabled={disabled}><Menu.Item isDisabled={disabled} onPress={() => { setMenuId(null); setTitle(session.title); setEditor({ action: "rename", chatId: session.chatId }); }}>
              <Menu.ItemTitle>{zh ? "重命名" : "Rename"}</Menu.ItemTitle>
            </Menu.Item></MobileMenuFocusItem>
            {state.pinSupported ? <MobileMenuFocusItem disabled={disabled}><Menu.Item isDisabled={disabled} onPress={() => execute({ action: "pin", chatId: session.chatId, pinned: !session.pinned })}>
              <Menu.ItemTitle>{session.pinned ? zh ? "取消置顶" : "Unpin" : zh ? "置顶" : "Pin"}</Menu.ItemTitle>
            </Menu.Item></MobileMenuFocusItem> : null}
            <MobileMenuFocusItem disabled={disabled}><Menu.Item isDisabled={disabled} onPress={() => execute({ action: "unread", chatId: session.chatId })}>
              <Menu.ItemTitle>{zh ? "标为未读" : "Mark unread"}</Menu.ItemTitle>
            </Menu.Item></MobileMenuFocusItem>
            <MobileMenuFocusItem disabled={disabled}><Menu.Item variant="danger" isDisabled={disabled} onPress={() => { setMenuId(null); setEditor({ action: "delete", chatId: session.chatId }); }}>
              <Menu.ItemTitle>{zh ? "删除" : "Delete"}</Menu.ItemTitle>
            </Menu.Item></MobileMenuFocusItem>
          </Menu.Content>
          </MobileMenuFocus>
        </Menu.Portal>
      </Menu>
    </View>)}
    {state.hasMore ? <Button variant="ghost" isDisabled={disabled || state.loading} onPress={() => execute({ action: "load-more" })}>{zh ? "查看更多" : "Show more"}</Button> : null}
    {state.error ? <Text style={styles.hint}>{zh ? "操作未完成，请重试" : "Could not complete this action. Try again."}</Text> : null}
    <Dialog isOpen={editor !== null && editorSession !== undefined} onOpenChange={open => { if (!open) setEditor(null); }}>
      <Dialog.Portal>
        <Dialog.Overlay />
        <Dialog.Content style={styles.menu}>
          <Dialog.Title>{editor?.action === "rename" ? zh ? "重命名会话" : "Rename conversation" : zh ? "删除会话？" : "Delete conversation?"}</Dialog.Title>
          {editor?.action === "rename" ? <Input value={title} onChangeText={setTitle} maxLength={256} autoFocus accessibilityLabel={zh ? "会话名称" : "Conversation title"} /> : null}
          {editor?.action === "delete" ? <Dialog.Description>{zh ? "删除后无法恢复。" : "This cannot be undone."}</Dialog.Description> : null}
          <View style={styles.footer}>
            <Button variant="ghost" onPress={() => setEditor(null)}>{zh ? "取消" : "Cancel"}</Button>
            {editor && editorSession ? <Button variant={editor.action === "delete" ? "danger" : "primary"}
              isDisabled={disabled || (editor.action === "rename" && !title.trim())}
              onPress={() => execute(editor.action === "rename" ? { action: "rename", chatId: editor.chatId, title: title.trim() } : { action: "delete", chatId: editor.chatId })}>
              {editor.action === "delete" ? zh ? "删除" : "Delete" : zh ? "保存" : "Save"}
            </Button> : null}
          </View>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  </>;
}
