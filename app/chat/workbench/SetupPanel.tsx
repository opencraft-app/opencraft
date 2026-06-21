import type {
  BackendKindWire,
  BackendWire,
  PermissionModeWire,
} from "../../../packages/vela-chat-client/src";

export function SetupPanel({
  baseUrl,
  sessionId,
  workingDirectory,
  backends,
  backendKinds,
  resolvedSelectedBackend,
  setupModelOptions,
  setupSelectedModel,
  setupReasoningOptions,
  setupSelectedReasoningEffort,
  setupPermissionOptions,
  setupSelectedPermissionMode,
  error,
  isCreatingSession,
  onBaseUrlChange,
  onSessionIdChange,
  onWorkingDirectoryChange,
  onBackendChange,
  onModelChange,
  onReasoningEffortChange,
  onPermissionModeChange,
  onOpenSession,
  onCreateSession,
}: {
  baseUrl: string;
  sessionId: string;
  workingDirectory: string;
  backends: BackendWire[];
  backendKinds: Set<string>;
  resolvedSelectedBackend: BackendKindWire | "";
  setupModelOptions: BackendWire["models"];
  setupSelectedModel: string;
  setupReasoningOptions: NonNullable<BackendWire["models"][number]["reasoning_efforts"]>;
  setupSelectedReasoningEffort: string;
  setupPermissionOptions: BackendWire["permission_modes"];
  setupSelectedPermissionMode: PermissionModeWire | "";
  error: string | null;
  isCreatingSession: boolean;
  onBaseUrlChange: (value: string) => void;
  onSessionIdChange: (value: string) => void;
  onWorkingDirectoryChange: (value: string) => void;
  onBackendChange: (value: BackendKindWire | "") => void;
  onModelChange: (value: string) => void;
  onReasoningEffortChange: (value: string) => void;
  onPermissionModeChange: (value: PermissionModeWire | "") => void;
  onOpenSession: () => void;
  onCreateSession: () => void;
}) {
  return (
    <main style={setupShellStyle}>
      <section style={setupCardStyle}>
        <h1 style={setupTitleStyle}>连接本地 velad session</h1>
        <label style={setupLabelStyle}>
          Base URL
          <input
            style={setupInputStyle}
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
          />
        </label>
        <label style={setupLabelStyle}>
          Session ID
          <input
            style={setupInputStyle}
            value={sessionId}
            onChange={(event) => onSessionIdChange(event.target.value)}
            placeholder="输入已有 session_id"
          />
        </label>
        <label style={setupLabelStyle}>
          Working Directory
          <input
            style={setupInputStyle}
            value={workingDirectory}
            onChange={(event) => onWorkingDirectoryChange(event.target.value)}
            placeholder="/Users/alice/project"
          />
        </label>
        <label style={setupLabelStyle}>
          Backend
          <select
            style={setupInputStyle}
            value={resolvedSelectedBackend}
            onChange={(event) => {
              const nextBackend = event.target.value;
              onBackendChange(
                backendKinds.has(nextBackend) ? (nextBackend as BackendKindWire) : "",
              );
            }}
          >
            {backends.length ? (
              backends.map((backend) => (
                <option key={backend.kind} value={backend.kind}>
                  {backend.display_name || backend.kind}
                </option>
              ))
            ) : (
              <option value="">Loading backends...</option>
            )}
          </select>
        </label>
        <label style={setupLabelStyle}>
          Model
          {setupModelOptions.length ? (
            <select
              style={setupInputStyle}
              value={setupSelectedModel}
              onChange={(event) => onModelChange(event.target.value)}
            >
              {setupModelOptions.map((modelOption) => (
                <option key={modelOption.id} value={modelOption.id}>
                  {modelOption.label || modelOption.id}
                </option>
              ))}
            </select>
          ) : (
            <input
              style={setupInputStyle}
              value={setupSelectedModel}
              onChange={(event) => onModelChange(event.target.value)}
              placeholder="model id"
            />
          )}
        </label>
        <label style={setupLabelStyle}>
          Thinking
          <select
            style={setupInputStyle}
            value={setupSelectedReasoningEffort}
            onChange={(event) => onReasoningEffortChange(event.target.value)}
          >
            {setupReasoningOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label || option.id}
              </option>
            ))}
          </select>
        </label>
        <label style={setupLabelStyle}>
          Permissions
          <select
            style={setupInputStyle}
            value={setupSelectedPermissionMode}
            onChange={(event) => onPermissionModeChange(event.target.value as PermissionModeWire)}
          >
            {setupPermissionOptions.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label || option.id}
              </option>
            ))}
          </select>
        </label>
        {error ? <p style={setupErrorStyle}>{error}</p> : null}
        <button
          style={setupButtonStyle}
          type="button"
          onClick={onOpenSession}
          disabled={!sessionId.trim()}
        >
          打开 ChatUI
        </button>
        <button
          style={setupSecondaryButtonStyle}
          type="button"
          onClick={onCreateSession}
          disabled={!workingDirectory.trim() || !resolvedSelectedBackend || isCreatingSession}
        >
          {isCreatingSession ? "创建中" : "新建会话"}
        </button>
      </section>
    </main>
  );
}

const setupShellStyle = {
  minHeight: "100dvh",
  display: "grid",
  placeItems: "center",
  background: "#fff",
  color: "#171717",
  fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
} satisfies React.CSSProperties;

const setupCardStyle = {
  width: "min(92vw, 520px)",
  border: "1px solid #e8e8e8",
  borderRadius: 24,
  padding: 28,
  boxShadow: "0 18px 50px rgb(0 0 0 / 6%)",
} satisfies React.CSSProperties;

const setupTitleStyle = {
  margin: "0 0 22px",
  fontSize: 22,
} satisfies React.CSSProperties;

const setupLabelStyle = {
  display: "grid",
  gap: 8,
  marginBottom: 16,
  color: "#6f7176",
  fontSize: 13,
  fontWeight: 650,
} satisfies React.CSSProperties;

const setupInputStyle = {
  border: "1px solid #dedede",
  borderRadius: 14,
  padding: "12px 14px",
  color: "#171717",
  font: "inherit",
} satisfies React.CSSProperties;

const setupButtonStyle = {
  width: "100%",
  border: 0,
  borderRadius: 14,
  padding: "13px 16px",
  background: "#171717",
  color: "#fff",
  font: "inherit",
  fontWeight: 700,
} satisfies React.CSSProperties;

const setupSecondaryButtonStyle = {
  ...setupButtonStyle,
  marginTop: 10,
  border: "1px solid #dedede",
  background: "#fff",
  color: "#171717",
} satisfies React.CSSProperties;

const setupErrorStyle = {
  margin: "0 0 16px",
  color: "#b42318",
  fontSize: 13,
  lineHeight: 1.5,
} satisfies React.CSSProperties;
