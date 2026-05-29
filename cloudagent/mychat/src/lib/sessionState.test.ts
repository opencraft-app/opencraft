import { describe, expect, it } from "vitest";
import {
  canStartSessionOpen,
  createDraftRow,
  markRowsDisconnected,
  promoteDraftToSession,
  removeTranscriptForSession,
  removeSessionRow,
  resolveActiveRowId,
  rowsFromListedSessions,
  sanitizeStoredUiState,
  updateRowRestoreState,
  type SessionRow,
} from "./sessionState";

const defaultCwd = "/workspace";

describe("ACP session rows", () => {
  it("builds sidebar rows from ACP session/list and preserves sessionId identity", () => {
    const rows = rowsFromListedSessions(
      [
        {
          sessionId: "session-1",
          title: "Weather",
          cwd: defaultCwd,
          updatedAt: "2026-05-09T03:00:00Z",
        },
      ],
      [],
      defaultCwd,
    );

    expect(rows).toMatchObject([
      {
        id: "session-1",
        sessionId: "session-1",
        title: "Weather",
        cwd: defaultCwd,
        mcpServersAuthoritative: false,
        restoreState: "new",
        source: "acp",
      },
    ]);
  });

  it("does not mark listed rows as having authoritative mcpServers from session/list alone", () => {
    const rows = rowsFromListedSessions(
      [{ sessionId: "session-1", title: "Real ACP", cwd: defaultCwd }],
      [],
      defaultCwd,
    );

    expect(rows[0].mcpServers).toBeUndefined();
    expect(rows[0].mcpServersAuthoritative).toBe(false);
  });

  it("maps read-only listed sessions into blocked restore state with reason", () => {
    const rows = rowsFromListedSessions(
      [
        {
          sessionId: "session-1",
          title: "Read only",
          cwd: defaultCwd,
          readOnly: true,
          readOnlyReason: "runtime_not_recovered",
        },
      ],
      [],
      defaultCwd,
    );

    expect(rows[0]).toMatchObject({
      readOnly: true,
      readOnlyReason: "runtime_not_recovered",
      restoreState: "blocked",
    });
  });

  it("preserves known additional directories when session/list omits them", () => {
    const previous = rowsFromListedSessions(
      [
        {
          sessionId: "session-1",
          title: "Real ACP",
          cwd: defaultCwd,
          additionalDirectories: ["/tmp/extra"],
        },
      ],
      [],
      defaultCwd,
    );
    const next = rowsFromListedSessions(
      [{ sessionId: "session-1", title: "Real ACP", cwd: defaultCwd }],
      previous,
      defaultCwd,
    );

    expect(next[0].additionalDirectories).toEqual(["/tmp/extra"]);
  });

  it("keeps unsaved drafts but does not merge local historical rows into ACP list", () => {
    const localHistorical: SessionRow = {
      id: "conv-local",
      title: "Fake local",
      subtitle: "主AGENTS",
      sessionId: "missing-from-acp",
      cwd: defaultCwd,
      mcpServers: [],
      mcpServersAuthoritative: true,
      configOptions: [],
      restoreState: "live",
      source: "acp",
    };
    const draft = createDraftRow("draft-1", defaultCwd);

    const rows = rowsFromListedSessions(
      [{ sessionId: "session-1", title: "Real ACP", cwd: defaultCwd }],
      [localHistorical, draft],
      defaultCwd,
    );

    expect(rows.map((row) => row.id)).toEqual(["draft-1", "session-1"]);
  });

  it("promotes a draft to the returned ACP session id", () => {
    const rows = promoteDraftToSession(
      [createDraftRow("draft-1", defaultCwd)],
      "draft-1",
      "session-1",
      [],
    );

    expect(rows[0]).toMatchObject({
      id: "session-1",
      sessionId: "session-1",
      source: "acp",
      restoreState: "live",
    });
  });

  it("resolves stored selection only when the row exists in ACP-derived rows", () => {
    const rows = rowsFromListedSessions(
      [{ sessionId: "session-1", title: "Real ACP", cwd: defaultCwd }],
      [],
      defaultCwd,
    );

    expect(resolveActiveRowId(rows, "session-1")).toBe("session-1");
    expect(resolveActiveRowId(rows, "fake-local")).toBe("session-1");
  });
});

describe("transcript isolation", () => {
  it("clears only the target session transcript before historical load replay", () => {
    const messages = [
      { id: "a1", conversationId: "session-a" },
      { id: "b1", conversationId: "session-b" },
    ];

    expect(removeTranscriptForSession(messages, "session-a")).toEqual([
      { id: "b1", conversationId: "session-b" },
    ]);
  });

  it("tracks restore states without creating local-only fallback states", () => {
    const row = rowsFromListedSessions(
      [{ sessionId: "session-1", title: "A", cwd: defaultCwd }],
      [],
      defaultCwd,
    );

    expect(
      updateRowRestoreState(row, "session-1", "error")[0].restoreState,
    ).toBe("error");
  });

  it("marks restoring rows as errored and clears stale live rows after transport loss", () => {
    const rows = rowsFromListedSessions(
      [
        { sessionId: "session-1", title: "A", cwd: defaultCwd },
        { sessionId: "session-2", title: "B", cwd: defaultCwd },
      ],
      [],
      defaultCwd,
    );
    const withStates = updateRowRestoreState(
      updateRowRestoreState(rows, "session-1", "restoring"),
      "session-2",
      "live",
    );

    expect(
      markRowsDisconnected(withStates).map((row) => row.restoreState),
    ).toEqual(["error", "new"]);
  });

  it("prevents duplicate ACP open requests while a row is already restoring", () => {
    expect(canStartSessionOpen({ restoreState: "restoring" })).toBe(false);
    expect(canStartSessionOpen({ restoreState: "new" })).toBe(true);
    expect(canStartSessionOpen({ restoreState: "live" })).toBe(true);
    expect(canStartSessionOpen({ restoreState: "error" })).toBe(true);
  });
});

describe("stored UI state", () => {
  it("keeps only selected id from old localStorage shapes and ignores conversations/messages payloads", () => {
    const stored = sanitizeStoredUiState({
      conversations: [{ id: "conv-demo", title: "Fake" }],
      messages: [{ id: "m1", conversationId: "conv-demo", content: "fake" }],
      activeConversationId: "conv-demo",
    });

    expect(stored).toEqual({ activeSessionId: "conv-demo" });
  });

  it("keeps persisted gatewayURL when present", () => {
    const stored = sanitizeStoredUiState({
      activeSessionId: "conv-demo",
      gatewayURL: "ws://127.0.0.1:18094/acp",
      sessionMetaTemplateId: "talos",
      sessionCreateMetaJSON:
        '{"_meta":{"cloudagent":{"sandbox_backend":"talos","agent_version":"builtin.v1","workspace_version":"builtin.v1"}}}',
    });

    expect(stored).toEqual({
      activeSessionId: "conv-demo",
      gatewayURL: "ws://127.0.0.1:18094/acp",
      sessionMetaTemplateId: "talos",
      sessionCreateMetaJSON:
        '{"_meta":{"cloudagent":{"sandbox_backend":"talos","agent_version":"builtin.v1","workspace_version":"builtin.v1"}}}',
    });
  });
});


describe("session removal", () => {
  it("drops the deleted conversation row from the sidebar model", () => {
    const rows = rowsFromListedSessions(
      [
        { sessionId: "session-1", title: "A", cwd: defaultCwd },
        { sessionId: "session-2", title: "B", cwd: defaultCwd },
      ],
      [],
      defaultCwd,
    );

    expect(removeSessionRow(rows, "session-1").map((row) => row.id)).toEqual([
      "session-2",
    ]);
  });
});
