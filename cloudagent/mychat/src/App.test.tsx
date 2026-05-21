import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GATEWAY_URL,
  Header,
  SettingsPage,
  SessionPage,
  parseSessionCreateMetaJSON,
  resolveInitialGatewayURL,
  summarizeSessionCreateMeta,
} from "./App";
import type { SessionRow } from "./lib/sessionState";

describe("Header session entry", () => {
  it("renders the status capsule as a session properties button", () => {
    let opened = false;
    const element = Header({
      sessionId: "session_d7fc1234567890",
      status: "connected",
      commandCount: 0,
      sidebarOpen: true,
      onToggleSidebar: () => {},
      onOpenSession: () => {
        opened = true;
      },
    });

    const button = findElementByAriaLabel(element, "Open session properties");
    expect(button).toBeTruthy();
    expect(typeof button?.props.onClick).toBe("function");
    button?.props.onClick?.();
    expect(opened).toBe(true);

    const html = renderToStaticMarkup(element);
    expect(html).toContain("connected · session_d7fc");
  });
});

describe("SessionPage", () => {
  it("renders draft session placeholders without raw JSON", () => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={sessionFixture({ sessionId: undefined })}
        status="disconnected"
        metadataAvailable={false}
        onBack={() => {}}
      />,
    );

    expect(html).toContain("Draft session");
    expect(html).toContain("Not exposed");
    expect(html).toContain("Disconnected");
    expect(html).not.toContain("{&quot;");
  });

  it("renders live session configuration", () => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={sessionFixture({
          sessionId: "session_live1234567890",
          restoreState: "live",
          configOptions: [
            {
              id: "model",
              category: "model",
              type: "select",
              currentValue: "agent-sidecar-chat",
              options: [{ value: "agent-sidecar-chat", name: "主AGENTS" }],
            },
            {
              id: "mode",
              category: "mode",
              type: "select",
              currentValue: "chat",
              options: [{ value: "chat", name: "Chat" }],
            },
          ],
        })}
        status="connected"
        metadataAvailable={false}
        onBack={() => {}}
      />,
    );

    expect(html).toContain("session_live12345678");
    expect(html).toContain("主AGENTS");
    expect(html).toContain("Chat");
    expect(html).toContain("Connected");
    expect(html).toContain("Live");
  });

  it("renders read-only reason in the access row", () => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={sessionFixture({
          readOnly: true,
          readOnlyReason: "runtime_not_recovered",
          restoreState: "blocked",
        })}
        status="connected"
        metadataAvailable={false}
        onBack={() => {}}
      />,
    );

    expect(html).toContain("Blocked");
    expect(html).toContain("Read-only: runtime_not_recovered");
  });

  it("renders CloudAgent metadata as fields instead of raw status JSON", () => {
    const html = renderToStaticMarkup(
      <SessionPage
        session={sessionFixture({ sessionId: "session_meta" })}
        status="connected"
        metadataAvailable
        metadata={{
          sessionId: "session_meta",
          runtimeGeneration: 2,
          closed: false,
          promptInFlight: false,
          cleanupPending: false,
          lastRuntimeError: "ags http 404: The requested resource does not exist",
          sandbox: {
            backend: "ags",
            sandboxTemplateId: "498c6c11-74d7-426e-bdb1-13d8aa73997e",
            runtimeId: "rt_session_meta_2",
            outerSandboxId: "outer_sandbox_123",
            innerSandboxId: "inner_sandbox_456",
            outerSandboxDomain: "ap-beijing.tencentags.com",
          },
        }}
        onBack={() => {}}
      />,
    );

    expect(html).toContain("Metadata");
    expect(html).toContain("outer_sandbox_123");
    expect(html).toContain("498c6c11-74d7-426e-bdb1-13d8aa73997e");
    expect(html).toContain("inner_sandbox_456");
    expect(html).toContain("rt_session_meta_2");
    expect(html).toContain("The requested resource does not exist");
    expect(html).not.toContain("outer_sandbox_id");
  });
});

describe("SettingsPage", () => {
  it("uses the CloudAgent gateway as the default endpoint", () => {
    expect(resolveInitialGatewayURL()).toBe(DEFAULT_GATEWAY_URL);
  });

  it("keeps a persisted gateway endpoint over the default", () => {
    expect(resolveInitialGatewayURL("http://127.0.0.1:18094")).toBe(
      "http://127.0.0.1:18094",
    );
  });

  it("renders session create params templates in settings", () => {
    const html = renderToStaticMarkup(
      <SettingsPage
        gatewayURLInput="http://127.0.0.1:18094"
        resolvedGatewayURL="ws://127.0.0.1:18094/acp"
        onChangeGatewayURL={() => {}}
        sessionMetaTemplates={[
          {
            id: "default",
            name: "Default",
            description: "Use defaults",
            json: "{}",
          },
          {
            id: "talos",
            name: "Talos",
            description: "Use Talos backend",
            json: '{"_meta":{"cloudagent":{"sandbox_backend":"talos","sandbox_template_id":"498c6c11-74d7-426e-bdb1-13d8aa73997e"}}}',
          },
          {
            id: "custom",
            name: "Custom",
            description: "Edit JSON",
            json: "{}",
          },
        ]}
        sessionMetaTemplateId="talos"
        sessionMetaJSON='{"_meta":{"cloudagent":{"sandbox_backend":"talos","sandbox_template_id":"498c6c11-74d7-426e-bdb1-13d8aa73997e"}}}'
        sessionMetaSummary="Backend: talos · template 498c6c11"
        onSessionMetaTemplateChange={() => {}}
        onSessionMetaJSONChange={() => {}}
        onSave={() => {}}
        onReset={() => {}}
        onCancel={() => {}}
      />,
    );

    expect(html).toContain("Session create params");
    expect(html).toContain("Talos");
    expect(html).toContain("Backend: talos · template 498c6c11");
    expect(html).toContain("sandbox_backend");
    expect(html).toContain("sandbox_template_id");
    expect(html).toContain("This only applies when a new ACP session is created.");
  });
});

describe("session/new meta JSON", () => {
  it("parses cloudagent backend meta and summarizes the selected backend", () => {
    const parsed = parseSessionCreateMetaJSON(
      '{"_meta":{"cloudagent":{"sandbox_backend":"talos","sandbox_template_id":"498c6c11-74d7-426e-bdb1-13d8aa73997e"}}}',
    );

    expect(parsed.error).toBeUndefined();
    expect(parsed.value).toMatchObject({
      _meta: {
        cloudagent: {
          sandbox_backend: "talos",
          sandbox_template_id: "498c6c11-74d7-426e-bdb1-13d8aa73997e",
        },
      },
    });
    expect(summarizeSessionCreateMeta(parsed.value)).toBe(
      "Backend: talos · template 498c6c11",
    );
  });

  it("rejects non-object session params JSON", () => {
    expect(parseSessionCreateMetaJSON("[]")).toMatchObject({
      error: "expected a JSON object",
    });
  });
});

function sessionFixture(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session_fixture",
    title: "Fixture session",
    subtitle: "today",
    sessionId: "session_fixture",
    cwd: "/workspace",
    mcpServersAuthoritative: false,
    configOptions: [],
    restoreState: "new",
    source: "acp",
    ...overrides,
  };
}

function findElementByAriaLabel(
  node: ReactNode,
  ariaLabel: string,
): ReactElement<{ "aria-label"?: string; onClick?: () => void }> | undefined {
  if (!isValidElement<Record<string, unknown>>(node)) return undefined;
  if (node.props["aria-label"] === ariaLabel) {
    return node as ReactElement<{
      "aria-label"?: string;
      onClick?: () => void;
    }>;
  }
  const children = node.props.children as ReactNode;
  if (Array.isArray(children)) {
    for (const child of children) {
      const found = findElementByAriaLabel(child, ariaLabel);
      if (found) return found;
    }
    return undefined;
  }
  return findElementByAriaLabel(children, ariaLabel);
}
