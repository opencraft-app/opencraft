export interface BotConfigurationControlInput {
  readonly optionsLoading: boolean;
  readonly busy: boolean;
  readonly provider: string;
  readonly model: string;
  readonly hasProviderCatalog: boolean;
  readonly hasModelCatalog: boolean;
}

export interface BotConfigurationControlState {
  readonly providerControl: "input" | "select";
  readonly modelControl: "input" | "select";
  readonly inputsDisabled: boolean;
  readonly saveDisabled: boolean;
}

export interface BotConfigurationHeaderInput {
  readonly configurationLoading: boolean;
  readonly optionsLoading: boolean;
  readonly optionsError: string | null;
}

export type BotConfigurationHeaderState = "idle" | "loading" | "retry";

export function botConfigurationHeaderState(
  input: BotConfigurationHeaderInput,
): BotConfigurationHeaderState {
  if (input.optionsError !== null) return "retry";
  if (input.configurationLoading || input.optionsLoading) return "loading";
  return "idle";
}

/** Catalog discovery enriches the editor; it never owns form admission. */
export function botConfigurationControlState(
  input: BotConfigurationControlInput,
): BotConfigurationControlState {
  const valid = input.provider.trim() !== "" && input.model.trim() !== "";
  return Object.freeze({
    providerControl: !input.optionsLoading && input.hasProviderCatalog ? "select" : "input",
    modelControl: !input.optionsLoading && input.hasModelCatalog ? "select" : "input",
    inputsDisabled: input.busy,
    saveDisabled: input.busy || !valid,
  });
}
