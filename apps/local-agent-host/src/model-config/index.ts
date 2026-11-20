// Public persistence boundary for engine projections. Engines never own this document.
export { ModelConfigurationRepository, ModelCredentialRepository, ModelConfigurationConflict } from "./repository.js";
export type { ModelDocument, ConfiguredModel, ConfiguredProvider } from "./model-document.js";
export { createEngineModelSource, engineEndpointAllowed, localNetworkHost, EngineModelError } from "./engine-models.js";
export type { EngineModelErrorCode, EngineModelProtocol, EngineModelReference, EngineModelRoute } from "./engine-models.js";
export { gatewayContributions } from "./gateway-contributions.js";
