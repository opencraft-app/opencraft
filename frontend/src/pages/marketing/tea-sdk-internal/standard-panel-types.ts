/**
 * @fileoverview StandardPanel 类型定义
 *
 * 定义 Standard 变体面板组件的 Props 和内部类型。
 * Standard 面板不依赖 TEA Component，只输出 HTML + BEM class name。
 */

import type { IAgentComponentBaseProps } from './hooks/useAgentInternals';

// ─── 公共 Props 基类 ───

export interface IStandardPanelBaseProps extends IAgentComponentBaseProps {
  /** 数据是否准备就绪 */
  isDataReady?: boolean;
  /** 操作禁用提示（有值时禁用所有操作） */
  operationDisabledTip?: string;
  /** 自定义 CSS class name */
  className?: string;
}

// ─── ModelPanel ───

export type ModelConfigKind = 'coding_plan' | 'api' | 'custom';
export type CustomApiMode = 'openai-completions' | 'anthropic-messages';
export type CustomInputMode = 'form' | 'json';

export interface ModelPanelProps extends IStandardPanelBaseProps {}

// ─── ChannelPanel ───

export interface ChannelPanelProps extends IStandardPanelBaseProps {}
