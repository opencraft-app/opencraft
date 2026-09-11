export interface SetupCodexRoleOption {
  readonly id: string;
  readonly label: string;
}

export interface SetupCodexTaskOption {
  readonly id: string;
  readonly label: string;
  readonly description: string;
}

/**
 * ChatUI owns selection and rendering; the product host owns discovery,
 * authentication and installation for sources outside the conversation domain.
 */
export interface SetupCodexContextSource {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly kind: "local" | "app" | "plugin";
  readonly connected: boolean;
  readonly available: boolean;
}

export const codexSetupRoleOptions: readonly SetupCodexRoleOption[] = Object.freeze([
  { id: "engineering", label: "Engineering" },
  { id: "data_science", label: "Data science" },
  { id: "product_management", label: "Product" },
  { id: "design", label: "Design" },
  { id: "marketing", label: "Marketing" },
  { id: "sales", label: "Sales" },
  { id: "finance", label: "Finance" },
  { id: "operations", label: "Operations" },
  { id: "people_hr", label: "People & HR" },
  { id: "legal", label: "Legal" },
  { id: "student", label: "Student" },
  { id: "something_else", label: "Something else" },
]);

export const codexSetupTaskOptions: readonly SetupCodexTaskOption[] = Object.freeze([
  { id: "understand", label: "Understand a project", description: "Inspect a repository and explain how it works" },
  { id: "build", label: "Build something", description: "Implement a feature or start a new project" },
  { id: "fix", label: "Fix an issue", description: "Debug a problem and verify the repair" },
]);

/** Empty-state exemplars only; a host should replace these with its live catalog. */
export const codexSetupContextSourceExamples: readonly SetupCodexContextSource[] = Object.freeze([
  { id: "google-drive", label: "Google Drive", description: "Find launch docs and source material", kind: "app", connected: false, available: false },
  { id: "slack", label: "Slack", description: "Read decisions and team context", kind: "app", connected: false, available: false },
  { id: "gmail", label: "Gmail", description: "Read customer and sales threads", kind: "app", connected: false, available: false },
]);
