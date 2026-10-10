import {Fragment, type ReactNode, useCallback, useRef} from "react";

import type {
  ConversationPageModel,
  HumanClientPresenter,
  ManagementPageModel,
  ManagementShellModel,
  PresentationAction,
  PresentationField,
  PresentationForm,
  WorkspaceSetupModel,
} from "../ui/presentation";
import {
  Button,
  NavigationStack,
  Overlay,
  Segmented,
  Text,
  TextInput,
  View,
  VirtualList,
} from "./primitives";

function Action({action, prefix}: {action: PresentationAction; prefix: string}) {
  const latest = useRef(action);
  latest.current = action;
  const onPress = useCallback(() => {
    const current = latest.current;
    if (!current.disabled) void current.run();
  }, []);
  return (
    <Button
      disabled={action.disabled}
      onPress={onPress}
      testID={`${prefix}-${action.id}`}
      title={action.label}
    />
  );
}

function ServerOption({
  server,
}: {
  server: NonNullable<ManagementShellModel["serverOptions"]>[number];
}) {
  const latest = useRef(server);
  latest.current = server;
  const onPress = useCallback(() => void latest.current.onSelect(), []);
  return (
    <Button
      onPress={onPress}
      testID={`terminal-server-option-${server.id}`}
      title={`${server.selected ? "当前 · " : ""}${server.label}`}
    />
  );
}

function Shell({model}: {model: ManagementShellModel}) {
  return (
    <View
      style={{direction: "column", mainAlign: "spaceBetween", paddingX: 1, paddingY: 1, surface: "raised", width: 18}}
      testID="terminal-navigation"
    >
      <View style={{direction: "column", gap: 1}}>
        <Text maxLines={2}>
          {model.serverName ?? "Server"}
          {model.accountLabel ? `\n${model.accountLabel}` : ""}
        </Text>
        {model.serverOptions && model.serverOptions.length > 1 ? (
          <View style={{direction: "column"}} testID="terminal-server-switcher">
            <Text maxLines={1}>Server</Text>
            {model.serverOptions.map((server) => (
              <ServerOption key={server.id} server={server} />
            ))}
          </View>
        ) : null}
        {model.navigation.map((action) => (
          <Action action={action} key={action.id} prefix="terminal-navigation" />
        ))}
      </View>
      {model.onLogout ? (
        <Button onPress={() => void model.onLogout?.()} title="账号" />
      ) : null}
    </View>
  );
}

function Field({field, prefix}: {field: PresentationField; prefix: string}) {
  const latest = useRef(field);
  latest.current = field;
  const onChange = useCallback((payload: Record<string, unknown>) => {
    latest.current.onChange(
      typeof payload.value === "string" ? payload.value : "",
    );
  }, []);
  return (
    <View style={{direction: "column"}}>
      <Text maxLines={1}>{field.label}</Text>
      {field.options && field.options.length > 0 ? (
        <Segmented
          disabled={field.disabled}
          onValueChange={onChange}
          segments={field.options}
          testID={`${prefix}-${field.id}`}
          value={field.value}
        />
      ) : (
        <TextInput
          disabled={field.disabled}
          onChangeText={onChange}
          placeholder={field.placeholder}
          testID={`${prefix}-${field.id}`}
          value={field.value}
        />
      )}
      {field.error ? <Text maxLines={2}>{field.error}</Text> : null}
    </View>
  );
}

function Form({form, prefix}: {form: PresentationForm; prefix: string}) {
  return (
    <Overlay alignment="center" modal testID={`${prefix}-overlay`}>
      <View
        style={{direction: "column", gap: 1, paddingX: 2, paddingY: 1, surface: "raised", width: 68}}
      >
        <Text maxLines={2}>{form.title}</Text>
        {form.fields.map((field) => (
          <Field field={field} key={field.id} prefix={`${prefix}-field`} />
        ))}
        <View style={{direction: "row", gap: 1}}>
          {form.actions.map((action) => (
            <Action action={action} key={action.id} prefix={`${prefix}-action`} />
          ))}
        </View>
      </View>
    </Overlay>
  );
}

function Conversation({model}: {model: ConversationPageModel}) {
  return (
    <NavigationStack activeRouteKey="conversation" testID="human-client-navigation-stack">
      <View
        style={{crossAlign: "stretch", direction: "row", flex: 1, surface: "canvas"}}
        testID="terminal-conversation-frame"
      >
        <Shell model={model.shell} />
        {model.conversations.length > 0 ? (
          <View
            style={{direction: "column", paddingX: 1, surface: "raised", width: 30}}
            testID="terminal-conversation-list"
          >
            <Text maxLines={1}>会话</Text>
            <VirtualList
              estimatedItemExtent={3}
              itemExtent={3}
              layoutVersion={`conversations:${model.conversations.length}`}
              overscan={2}
            >
              {model.conversations.map((conversation) => (
                <Button
                  key={conversation.id}
                  label={conversation.subtitle}
                  onPress={() => void conversation.onSelect()}
                  selected={conversation.selected}
                  testID={`terminal-conversation-item-${conversation.id}`}
                  title={conversation.title}
                  trailing={
                    conversation.unreadCount
                      ? String(conversation.unreadCount)
                      : undefined
                  }
                />
              ))}
            </VirtualList>
          </View>
        ) : null}
        <View style={{direction: "column", flex: 1, surface: "surface"}}>
          <View
            style={{direction: "row", mainAlign: "spaceBetween", paddingX: 2, paddingY: 1, surface: "surface"}}
            testID="terminal-conversation-header"
          >
            <Text maxLines={3}>
              {model.header.eyebrow}
              {model.header.summary ? `\n${model.header.summary}` : ""}
              {`\n${model.header.title}`}
            </Text>
            <View style={{direction: "row", gap: 1}}>
              {model.commands.map((action) => (
                <Action action={action} key={action.id} prefix="terminal-header-command" />
              ))}
            </View>
          </View>
          {model.error ? (
            <Text maxLines={2} testID="terminal-conversation-error">
              {model.error}
            </Text>
          ) : null}
          <View style={{direction: "column", flex: 1, paddingX: 2}}>
            {model.messages.map((message) => (
              <View key={message.id} style={{direction: "column", gap: 1}}>
                <Text maxLines={1}>
                  {message.sender}
                  {message.meta ? ` · ${message.meta}` : ""}
                </Text>
                <Text maxLines={4}>{message.text}</Text>
              </View>
            ))}
            {model.messages.length === 0 && model.empty ? (
              <View style={{direction: "column", gap: 1}}>
                <Text maxLines={2}>{model.empty.title}</Text>
                <Text maxLines={3}>{model.empty.description}</Text>
              </View>
            ) : null}
          </View>
          <View style={{direction: "column", paddingX: 1, surface: "raised"}}>
            <View style={{direction: "row", gap: 1}}>
              {model.composer.actions.map((action) => (
                <Action action={action} key={action.id} prefix="terminal-composer-action" />
              ))}
            </View>
            <View style={{direction: "row"}}>
              <TextInput
                disabled={model.composer.disabled}
                onChangeText={(payload) =>
                  model.composer.onChange(
                    typeof payload.value === "string" ? payload.value : "",
                  )
                }
                placeholder={model.composer.placeholder}
                style={{flex: 1}}
                testID="terminal-conversation-composer"
                value={model.composer.value}
              />
              <Button
                disabled={
                  model.composer.disabled || model.composer.value.trim().length === 0
                }
                onPress={() => void model.composer.onSend()}
                testID="terminal-conversation-send"
                title="发送"
              />
            </View>
          </View>
        </View>
        {model.form ? <Form form={model.form} prefix="terminal-conversation-form" /> : null}
      </View>
    </NavigationStack>
  );
}

function Management({model}: {model: ManagementPageModel}) {
  return (
    <NavigationStack activeRouteKey={model.id} testID="human-client-navigation-stack">
      <View
        style={{direction: "row", flex: 1, surface: "canvas"}}
        testID="terminal-management-frame"
      >
        <Shell model={model.shell} />
        {model.collection ? (
          <View
            style={{direction: "column", paddingX: 1, surface: "raised", width: 30}}
            testID="terminal-management-collection"
          >
            <Text maxLines={1}>{model.collection.label}</Text>
            {model.collection.items.map((item) => (
              <Button
                key={item.id}
                label={[item.status, item.subtitle].filter(Boolean).join(" · ")}
                onPress={item.onSelect}
                selected={item.selected}
                title={item.title}
                trailing={item.meta}
              />
            ))}
          </View>
        ) : null}
        <View style={{direction: "column", flex: 1, gap: 1, paddingX: 2, paddingY: 1}}>
          <View style={{direction: "row", mainAlign: "spaceBetween"}}>
            <Text maxLines={3} testID="terminal-management-header">
              {model.header.eyebrow}
              {`\n${model.header.title}`}
              {model.header.summary ? `\n${model.header.summary}` : ""}
            </Text>
            <View style={{direction: "row", gap: 1}}>
              {model.commands.map((action) => (
                <Action
                  action={action}
                  key={action.id}
                  prefix="terminal-management-command"
                />
              ))}
            </View>
          </View>
          {model.error ? <Text maxLines={2}>{model.error}</Text> : null}
          {model.detail ? (
            <View testID="terminal-management-detail">
              <Text maxLines={2}>{model.detail.title}</Text>
              {model.detail.description ? (
                <Text maxLines={4}>{model.detail.description}</Text>
              ) : null}
              <View style={{direction: "row", gap: 1}}>
                {model.detail.actions.map((action) => (
                  <Action action={action} key={action.id} prefix="terminal-detail-action" />
                ))}
              </View>
            </View>
          ) : model.empty ? (
            <Text maxLines={4} testID="terminal-management-empty">
              {model.empty.title}
              {`\n${model.empty.description}`}
            </Text>
          ) : null}
        </View>
        {model.form ? <Form form={model.form} prefix="terminal-management-form" /> : null}
      </View>
    </NavigationStack>
  );
}

function Setup({model}: {model: WorkspaceSetupModel}) {
  return (
    <View
      style={{direction: "column", flex: 1, gap: 1, paddingX: 3, paddingY: 2, surface: "canvas"}}
      testID="terminal-workspace-setup-frame"
    >
      <Text maxLines={3}>
        {model.title}
        {`\n${model.description}`}
      </Text>
      <View
        style={{direction: "column", gap: 1, paddingX: 2, paddingY: 1, surface: "surface", width: 68}}
      >
        <Text maxLines={1}>{model.form.title}</Text>
        {model.form.fields.map((field) => (
          <Field field={field} key={field.id} prefix="terminal-workspace-setup-field" />
        ))}
        {model.error ? <Text maxLines={2}>{model.error}</Text> : null}
        {model.stage ? <Text maxLines={1}>{model.stage}</Text> : null}
        <View style={{direction: "row", gap: 1}}>
          {model.form.actions.map((action) => (
            <Action action={action} key={action.id} prefix="terminal-workspace-setup-action" />
          ))}
        </View>
      </View>
    </View>
  );
}

export const terminalPresenter: HumanClientPresenter = {
  kind: "terminal",
  renderConversationPage(model: ConversationPageModel): ReactNode {
    return <Conversation model={model} />;
  },
  renderManagementPage(model: ManagementPageModel): ReactNode {
    return <Management model={model} />;
  },
  renderWorkspaceSetup(model: WorkspaceSetupModel): ReactNode {
    return <Setup model={model} />;
  },
};

export const TerminalFragment = Fragment;
