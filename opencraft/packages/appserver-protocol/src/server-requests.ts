import type {
  CommandExecutionRequestApprovalParams,
  CommandExecutionRequestApprovalResponse,
  DynamicToolCallParams,
  DynamicToolCallResponse,
  FileChangeRequestApprovalParams,
  FileChangeRequestApprovalResponse,
  McpServerElicitationRequestParams,
  McpServerElicitationRequestResponse,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from "./generated/v2";

export interface OptionPickerRequestOption {
  readonly label: string;
  readonly description?: string | null;
}

/** Desktop compatibility request used before option picking moved behind item/tool/call. */
export interface OptionPickerRequestParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId?: string | null;
  readonly callId?: string | null;
  readonly question: string;
  readonly options: readonly OptionPickerRequestOption[];
  readonly allowMultiple?: boolean;
  readonly submitLabel?: string | null;
  readonly skipLabel?: string | null;
}

export interface OptionPickerResponse {
  readonly action: "submit" | "skip" | "dismiss";
  readonly selectedOptions: readonly string[];
  readonly freeformAnswer: string | null;
}

/** Desktop compatibility request used by setup builds that predate dynamic tool calls. */
export interface SetupCodexContextPickerRequestParams {
  readonly threadId: string;
  readonly turnId: string;
  readonly itemId?: string | null;
  readonly callId?: string | null;
}

export interface SetupCodexContextPickerResponse {
  readonly action: "continue" | "dismiss";
  readonly selectedSources: readonly string[];
}

/** Server-to-client RPCs that require durable UI interaction state. */
export interface AppServerServerRequestMap {
  "item/commandExecution/requestApproval": {
    params: CommandExecutionRequestApprovalParams & {
      /** Provider-owned persistent grant; absent on native Codex requests. */
      approvalScopes?: Array<"once" | "session" | "always" | "deny">;
    };
    result: CommandExecutionRequestApprovalResponse & {
      /** Valid only when the provider explicitly offers the persistent scope. */
      _meta?: { persist: "always" };
    };
  };
  "item/fileChange/requestApproval": {
    params: FileChangeRequestApprovalParams;
    result: FileChangeRequestApprovalResponse;
  };
  "item/tool/requestUserInput": {
    params: ToolRequestUserInputParams;
    result: ToolRequestUserInputResponse;
  };
  "mcpServer/elicitation/request": {
    params: McpServerElicitationRequestParams;
    result: McpServerElicitationRequestResponse;
  };
  "item/permissions/requestApproval": {
    params: PermissionsRequestApprovalParams;
    result: PermissionsRequestApprovalResponse;
  };
  /** Current AppServer route for product-owned dynamic tools. */
  "item/tool/call": {
    params: DynamicToolCallParams;
    result: DynamicToolCallResponse;
  };
  /** Older/newer Desktop builds may expose the picker as a dedicated request. */
  "item/tool/requestOptionPicker": {
    params: OptionPickerRequestParams;
    result: OptionPickerResponse;
  };
  /** Compatibility route retained by Codex Desktop beside setup_codex_context_picker. */
  "item/tool/requestSetupCodexContextPicker": {
    params: SetupCodexContextPickerRequestParams;
    result: SetupCodexContextPickerResponse;
  };
}

export type AppServerServerMethod = keyof AppServerServerRequestMap & string;
export type AppServerServerRequestParams<TMethod extends AppServerServerMethod> =
  AppServerServerRequestMap[TMethod]["params"];
export type AppServerServerRequestResult<TMethod extends AppServerServerMethod> =
  AppServerServerRequestMap[TMethod]["result"];

export type TypedAppServerServerRequest<TMethod extends AppServerServerMethod> = {
  readonly id: string | number;
  readonly method: TMethod;
  readonly params: AppServerServerRequestParams<TMethod>;
};
