import type { ApprovalTimelineBlock } from "./timeline";

export interface ApprovalDetailRow {
  readonly label: string;
  readonly value: string;
}

export interface ApprovalRequestPresentation {
  readonly title: string;
  readonly subtitle: string | null;
  readonly description: string | null;
  readonly details: readonly ApprovalDetailRow[];
  readonly allowSession: boolean;
  readonly allowOnce: boolean;
  readonly allowDeny: boolean;
  readonly allowAlways: boolean;
  readonly approveLabel: string;
  readonly identityLabel: "Terminal" | "Internet access" | "Edit files" | "Ask permission";
  readonly leadingApproval: {
    readonly kind: "network-policy";
    readonly label: string;
  } | null;
  readonly scopedApproval: {
    readonly kind: "session" | "exec-policy";
    readonly label: string;
    readonly info: string | null;
  } | null;
}

type RecordValue = Readonly<Record<string, unknown>>;

function record(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function fileSystemSummary(value: unknown): string | null {
  const source = record(value);
  const entries = Array.isArray(source.entries) ? source.entries : [];
  const paths = entries.flatMap((entry): string[] => {
    const item = record(entry);
    const path = record(item.path);
    const displayPath = string(path.path) ?? string(path.pattern) ?? string(path.value);
    const access = string(item.access);
    return displayPath === null ? [] : [`${access === null ? "access" : access} ${displayPath}`];
  });
  if (paths.length > 0) return paths.join(", ");
  const read = Array.isArray(source.read) ? source.read.filter((entry): entry is string => typeof entry === "string") : [];
  const write = Array.isArray(source.write) ? source.write.filter((entry): entry is string => typeof entry === "string") : [];
  const legacy = [...read.map((path) => `read ${path}`), ...write.map((path) => `write ${path}`)];
  return legacy.length > 0 ? legacy.join(", ") : null;
}

export function presentApprovalRequest(block: ApprovalTimelineBlock): ApprovalRequestPresentation {
  const details: ApprovalDetailRow[] = [];
  if (block.reason !== null) details.push({ label: "Reason", value: block.reason });
  if (block.cwd !== null) details.push({ label: "Working directory", value: block.cwd });
  if (block.grantRoot !== null) details.push({ label: "Write access", value: block.grantRoot });
  if (block.approvalKind === "permissions") {
    const permissions = record(block.permissions);
    if (permissions.network !== null && permissions.network !== undefined) {
      details.push({ label: "Network", value: "Internet access" });
    }
    const fileSystem = fileSystemSummary(permissions.fileSystem);
    if (fileSystem !== null) details.push({ label: "Files", value: fileSystem });
  }
  const decisions = new Set(block.availableDecisions);
  const networkAmendment = (block.proposedNetworkPolicyAmendments ?? []).find((amendment) => amendment.action === "allow") ?? null;
  const hasNetworkContext = block.networkApprovalContext !== null && block.networkApprovalContext !== undefined;
  const canUseSession = block.approvalScopes !== undefined
    ? block.approvalScopes.includes("session")
    : decisions.size === 0 || decisions.has("acceptForSession");
  const execPolicyCommand = (block.proposedExecpolicyAmendment ?? []).join(" ").trim();
  const scopedApproval = hasNetworkContext
    ? canUseSession ? { kind: "session" as const, label: "Allow this conversation", info: null } : null
    : block.approvalKind === "file-change"
      ? canUseSession ? { kind: "session" as const, label: "Allow all edits", info: "Allow this and future file edits in this conversation without asking again" } : null
      : block.approvalKind === "command" && execPolicyCommand.length > 0
        ? { kind: "exec-policy" as const, label: "Allow similar commands", info: `Allow commands that start with ${execPolicyCommand} for this conversation` }
        : canUseSession ? { kind: "session" as const, label: "Allow this conversation", info: null } : null;
  return {
    title: block.title,
    // Network approval uses a policy card, not a command card.
    // The originating shell command is deliberately absent from the surface;
    // the host allow-list explanation occupies the secondary text slot.
    subtitle: block.approvalKind === "command" && !hasNetworkContext ? block.command : null,
    description: hasNetworkContext
      ? block.detail
      : block.approvalKind !== "command" && details.length === 0 ? block.detail : null,
    details,
    allowSession: scopedApproval !== null,
    allowOnce: block.approvalScopes === undefined || block.approvalScopes.includes("once"),
    allowDeny: block.approvalScopes === undefined || block.approvalScopes.includes("deny"),
    allowAlways: block.approvalScopes?.includes("always") === true,
    approveLabel: "Allow once",
    identityLabel: hasNetworkContext ? "Internet access"
      : block.approvalKind === "command" ? "Terminal"
      : block.approvalKind === "file-change" ? "Edit files"
      : "Ask permission",
    leadingApproval: networkAmendment === null ? null : { kind: "network-policy", label: "Always allow" },
    scopedApproval,
  };
}
