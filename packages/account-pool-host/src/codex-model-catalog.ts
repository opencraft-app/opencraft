const DEFAULT_REASONING_LEVELS = ["medium", "low", "minimal", "high", "xhigh", "max"] as const;

/** Codex catalog metadata describes declared capabilities, never guesses from a model name. */
export function codexModelMetadata(
  slug: string,
  provider: { name: string; protocol: string },
  model: {
    id: string;
    name?: string;
    input?: readonly ("text" | "image")[];
    contextWindow?: number;
    customToolCalls?: true;
    reasoningEfforts?: false | Readonly<Record<string, unknown>>;
  },
  defaultEffort?: string,
) {
  const levels = model.reasoningEfforts && Object.keys(model.reasoningEfforts).filter((level) => level !== "off");
  const resolvedDefault =
    levels && levels.length > 0
      ? defaultEffort && levels.includes(defaultEffort)
        ? defaultEffort
        : (DEFAULT_REASONING_LEVELS.find((level) => levels.includes(level)) ?? levels[0]!)
      : null;
  return {
    slug,
    display_name: `${provider.name} · ${model.name ?? model.id}`,
    description: `${provider.protocol === "anthropic-messages" ? "Anthropic Messages" : "Responses API"} · ${provider.name}`,
    default_reasoning_level: resolvedDefault,
    supported_reasoning_levels: (levels || []).map((level) => ({ effort: level, description: level })),
    shell_type: "unified_exec",
    visibility: "list",
    supported_in_api: true,
    priority: 1000,
    additional_speed_tiers: [],
    service_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions:
      "You are Codex, a coding assistant working with the user in a shared workspace. Use the available tools to carry out the user's task and verify the result.",
    include_skills_usage_instructions: false,
    include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false,
    supports_reasoning_summary_parameter: false,
    default_reasoning_summary: "none",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: provider.protocol === "openai-responses" && model.customToolCalls ? "freeform" : null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "bytes", limit: 10000 },
    supports_image_detail_original: false,
    context_window: model.contextWindow ?? null,
    max_context_window: model.contextWindow ?? null,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    input_modalities: model.input ?? (["text"] as const),
    supports_search_tool: false,
    supports_experimental_context: false,
    use_responses_lite: false,
    supports_reasoning_effort_updates: false,
  };
}
