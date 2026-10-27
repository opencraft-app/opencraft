import type {
  AutomaticApprovalReview,
  AutomaticApprovalReviewAction,
} from "./timeline";

export function summarizeAutomaticApprovalReviewAction(action: AutomaticApprovalReviewAction | null): string {
  if (action === null) return "Request";
  switch (action.type) {
    case "command": return action.command;
    case "execve": return [action.program, ...action.argv].join(" ");
    case "applyPatch": return action.files.length === 1
      ? `Editing ${action.files[0]}`
      : `Editing ${action.files.length === 1 ? "a file" : `${action.files.length} files`}`;
    case "networkAccess": return `Network access to ${action.target}`;
    case "mcpToolCall": return `MCP ${action.toolName} on ${action.connectorName ?? action.server}`;
    case "requestPermissions": return action.reason === null
      ? "Permission request"
      : `Permission request: ${action.reason}`;
  }
}

export function formatAutomaticApprovalReviewTitle(review: AutomaticApprovalReview): string {
  switch (review.status) {
    case "inProgress": return "Auto-reviewing";
    case "approved": return "Auto-review approved";
    case "denied": return review.riskLevel === "high" ? "Auto-review denied high risk" : "Auto-review denied";
    case "timedOut": return "Auto-review timed out";
    case "aborted": return "Auto-review stopped";
  }
}

export function formatAutomaticApprovalReviewSummary(review: AutomaticApprovalReview): string {
  const rationale = review.rationale?.trim();
  if (rationale) return rationale;
  switch (review.status) {
    case "inProgress": return "Reviewing this request.";
    case "approved": return "This request was approved.";
    case "denied": return "This request was denied.";
    case "timedOut": return "Review timed out.";
    case "aborted": return "Review was stopped.";
  }
}

export function isAutomaticApprovalReviewWarning(review: AutomaticApprovalReview): boolean {
  return review.status === "denied" && review.riskLevel === "high";
}
