import type {
  BackendKindWire,
  BackendWire,
  PermissionModeWire,
  SessionWire,
} from "../../../../packages/vela-chat-client/src";
import { buildRecentSessionRows } from "./model";

export function DebugSessionLauncher({
  baseUrl,
  sessionId,
  workingDirectory,
  recentSessions,
  isLoadingRecentSessions,
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
  recentSessions: SessionWire[];
  isLoadingRecentSessions: boolean;
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
  onOpenSession: (sessionId?: string) => void;
  onCreateSession: () => void;
}) {
  const recentRows = buildRecentSessionRows(recentSessions);

  return (
    <main style={launcherShellStyle}>
      <section style={launcherCardStyle} aria-label="Debug session launcher">
        <div style={launcherHeaderStyle}>
          <div>
            <h1 style={launcherTitleStyle}>Debug Session Launcher</h1>
            <p style={launcherDescriptionStyle}>
              Connect the demo shell to a local velad session.
            </p>
          </div>
          <span style={launcherPillStyle}>/chat only</span>
        </div>

        <section style={recentSectionStyle} aria-label="Recent sessions">
          <div style={sectionHeaderStyle}>
            <h2 style={sectionTitleStyle}>Recent sessions</h2>
            {isLoadingRecentSessions ? <span style={mutedStyle}>Loading...</span> : null}
          </div>
          {recentRows.length ? (
            <div style={recentListStyle}>
              {recentRows.map((session) => (
                <button
                  key={session.id}
                  type="button"
                  style={recentSessionButtonStyle}
                  onClick={() => onOpenSession(session.id)}
                >
                  <span style={recentSessionMainStyle}>
                    <span style={recentSessionTitleStyle}>{session.title}</span>
                    <span style={recentSessionMetaStyle}>{session.subtitle}</span>
                  </span>
                  <span style={recentSessionAsideStyle}>
                    <span>{session.status}</span>
                    <span>{session.updatedAt}</span>
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <p style={emptyRecentStyle}>
              {isLoadingRecentSessions ? "Loading sessions..." : "No recent sessions yet."}
            </p>
          )}
        </section>

        <div style={manualOpenStyle}>
          <label style={setupLabelStyle}>
            Manual Session ID
            <input
              style={setupInputStyle}
              value={sessionId}
              onChange={(event) => onSessionIdChange(event.target.value)}
              placeholder="ses_..."
            />
          </label>
          <button
            style={setupButtonStyle}
            type="button"
            onClick={() => onOpenSession()}
            disabled={!sessionId.trim()}
          >
            Open
          </button>
        </div>

        <details style={advancedStyle}>
          <summary style={advancedSummaryStyle}>Create session</summary>
          <div style={advancedGridStyle}>
            <label style={setupLabelStyle}>
              Base URL
              <input
                style={setupInputStyle}
                value={baseUrl}
                onChange={(event) => onBaseUrlChange(event.target.value)}
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
            {setupReasoningOptions.length > 0 ? (
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
            ) : null}
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
          </div>
          <button
            style={setupSecondaryButtonStyle}
            type="button"
            onClick={onCreateSession}
            disabled={!workingDirectory.trim() || !resolvedSelectedBackend || isCreatingSession}
          >
            {isCreatingSession ? "Creating..." : "Create session"}
          </button>
        </details>

        {error ? <p style={setupErrorStyle}>{error}</p> : null}
      </section>
    </main>
  );
}

const launcherShellStyle = {
  minHeight: "100dvh",
  display: "grid",
  placeItems: "center",
  padding: 24,
  background: "#fff",
  color: "#171717",
  fontFamily: "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
} satisfies React.CSSProperties;

const launcherCardStyle = {
  width: "min(94vw, 760px)",
  border: "1px solid #e8e8e8",
  borderRadius: 20,
  padding: 24,
  boxShadow: "0 18px 50px rgb(0 0 0 / 6%)",
} satisfies React.CSSProperties;

const launcherHeaderStyle = {
  display: "flex",
  alignItems: "flex-start",
  justifyContent: "space-between",
  gap: 16,
  marginBottom: 22,
} satisfies React.CSSProperties;

const launcherTitleStyle = {
  margin: 0,
  fontSize: 22,
  lineHeight: 1.2,
} satisfies React.CSSProperties;

const launcherDescriptionStyle = {
  margin: "6px 0 0",
  color: "#7b7f86",
  fontSize: 14,
} satisfies React.CSSProperties;

const launcherPillStyle = {
  border: "1px solid #ececee",
  borderRadius: 999,
  padding: "5px 10px",
  color: "#7b7f86",
  fontSize: 12,
  whiteSpace: "nowrap",
} satisfies React.CSSProperties;

const recentSectionStyle = {
  borderTop: "1px solid #eeeeef",
  borderBottom: "1px solid #eeeeef",
  padding: "16px 0",
  marginBottom: 18,
} satisfies React.CSSProperties;

const sectionHeaderStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  marginBottom: 10,
} satisfies React.CSSProperties;

const sectionTitleStyle = {
  margin: 0,
  fontSize: 13,
  color: "#6f737a",
  textTransform: "uppercase",
  letterSpacing: 0,
} satisfies React.CSSProperties;

const mutedStyle = {
  color: "#9ca0a6",
  fontSize: 13,
} satisfies React.CSSProperties;

const recentListStyle = {
  display: "grid",
  gap: 6,
} satisfies React.CSSProperties;

const recentSessionButtonStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  gap: 12,
  width: "100%",
  border: 0,
  borderRadius: 10,
  padding: "10px 12px",
  background: "transparent",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
} satisfies React.CSSProperties;

const recentSessionMainStyle = {
  display: "grid",
  gap: 3,
  minWidth: 0,
} satisfies React.CSSProperties;

const recentSessionTitleStyle = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 15,
  fontWeight: 600,
} satisfies React.CSSProperties;

const recentSessionMetaStyle = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "#858991",
  fontSize: 13,
} satisfies React.CSSProperties;

const recentSessionAsideStyle = {
  display: "grid",
  gap: 3,
  color: "#9a9ea5",
  fontSize: 12,
  textAlign: "right",
  whiteSpace: "nowrap",
} satisfies React.CSSProperties;

const emptyRecentStyle = {
  margin: 0,
  color: "#9a9ea5",
  fontSize: 14,
} satisfies React.CSSProperties;

const manualOpenStyle = {
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) auto",
  alignItems: "end",
  gap: 10,
  marginBottom: 16,
} satisfies React.CSSProperties;

const advancedStyle = {
  borderTop: "1px solid #f0f0f1",
  paddingTop: 14,
} satisfies React.CSSProperties;

const advancedSummaryStyle = {
  cursor: "pointer",
  color: "#6f737a",
  fontSize: 14,
  fontWeight: 650,
  marginBottom: 14,
} satisfies React.CSSProperties;

const advancedGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  columnGap: 12,
} satisfies React.CSSProperties;

const setupLabelStyle = {
  display: "grid",
  gap: 8,
  marginBottom: 14,
  color: "#6f7176",
  fontSize: 13,
  fontWeight: 650,
} satisfies React.CSSProperties;

const setupInputStyle = {
  border: "1px solid #dedede",
  borderRadius: 12,
  padding: "11px 13px",
  color: "#171717",
  font: "inherit",
  outline: "none",
  minWidth: 0,
} satisfies React.CSSProperties;

const setupButtonStyle = {
  border: 0,
  borderRadius: 12,
  padding: "12px 18px",
  background: "#171717",
  color: "#fff",
  fontWeight: 700,
  cursor: "pointer",
} satisfies React.CSSProperties;

const setupSecondaryButtonStyle = {
  ...setupButtonStyle,
  background: "#f2f2f3",
  color: "#171717",
  marginTop: 4,
} satisfies React.CSSProperties;

const setupErrorStyle = {
  margin: "14px 0 0",
  color: "#b42318",
  fontSize: 13,
} satisfies React.CSSProperties;
