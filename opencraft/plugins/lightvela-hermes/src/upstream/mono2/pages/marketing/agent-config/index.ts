// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/**
 * @fileoverview agent-config —— Agent 配置面板本地模块统一出口
 *
 * 从 tea-sdk-internal 演化而来：原 SDK 内联副本去 SDK 化，重构为独立业务模块。
 * 外部消费方一律从本 barrel 导入；模块内部文件之间保持相对路径直连、不走本出口，
 * 避免 barrel 循环依赖。
 */

// ─── 类型（统一 types.ts）───
export type {
  IProductConfig,
  IModelProvider,
  IStandardPanelBaseProps,
  ModelPanelProps,
  ModelConfigKind,
  CustomApiMode,
  CustomInputMode,
  ChannelPanelProps,
} from './types';

// ─── 产品配置 ───
export { createLighthouseConfig } from './product-config';
export type { ICreateLighthouseConfigOptions } from './product-config';

// ─── Hooks ───
export { useModelProviders } from './hooks/useModelProviders';
export { useModelOperations } from './hooks/useModelOperations';
export { useChannelOperations } from './hooks/useChannelOperations';

// ─── 运行时 ───
export { getHermesScriptCommands } from './scripts-runtime';
export { createLocalCommandExecutor } from './local-command-executor';
export type { ICommandExecutor } from './local-command-executor';

// ─── 工具 ───
export { CUSTOM_JSON_PLACEHOLDER, normalizeCustomProvider } from './utils/model-providers';
export { message } from './utils/message';
export { parseJsonWithNormalizedWhitespace } from './utils/json';
export { getModelSwitchFailureMessage } from './utils/model-operation-errors';
export { isHermesModelProbeSuccessful } from './utils/hermes-parsers';
export type { IHermesModelProbeParams, IHermesModelProbeResult } from './utils/hermes-parsers';

// ─── UI 组件 ───
export { default as HermesQrCodeModal } from './components/HermesQrCodeModal';
export type { IHermesQrCodeModalHandle } from './components/HermesQrCodeModal';
export { FeishuIcon } from './components/FeishuIcon';
export { WecomIcon } from './components/WecomIcon';
