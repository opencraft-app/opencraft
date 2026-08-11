/**
 * @fileoverview StandardPanel 类型定义
 *
 * 定义 Standard 变体面板组件的 Props 和内部类型。
 * Standard 面板不依赖 TEA Component，只输出 HTML + BEM class name。
 */

import type { IOpenClawComponentBaseProps } from './hooks/useOpenClawInternals';
import type { IChannelConfig } from './config/types';

// ─── 公共 Props 基类 ───

export interface IStandardPanelBaseProps extends IOpenClawComponentBaseProps {
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

export interface ModelPanelProps extends IStandardPanelBaseProps {
  /** 操作成功回调 */
  onSaveSuccess?: () => void;
  /** 操作失败回调 */
  onSaveError?: (error: string) => void;
  /** 删除成功回调 */
  onDeleteSuccess?: () => void;
  /**
   * 自定义渲染 Select 组件
   * SDK 不内置 Select 组件，业务侧通过此 prop 注入
   */
  renderSelect?: (props: IRenderSelectProps) => React.ReactElement | null;
  /**
   * 自定义渲染 Input 组件
   */
  renderInput?: (props: IRenderInputProps) => React.ReactElement | null;
  /**
   * 自定义渲染 Button 组件
   */
  renderButton?: (props: IRenderButtonProps) => React.ReactElement | null;
  /**
   * 自定义渲染已配置模型标题栏右侧操作区
   */
  renderRegistryHeaderAction?: (props: IRenderRegistryHeaderActionProps) => React.ReactNode;
}

export interface IRenderRegistryHeaderActionProps {
  configuredCount: number;
  loading: boolean;
  busy: boolean;
}

export interface IRenderSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; description?: string }>;
  placeholder?: string;
  disabled?: boolean;
}

export interface IRenderInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  type?: 'text' | 'password';
  disabled?: boolean;
}

export interface IRenderButtonProps {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  variant?: 'primary' | 'outline' | 'danger';
}

// ─── ChannelPanel ───

export interface ChannelPanelProps extends IStandardPanelBaseProps {
  /** 连接成功回调 */
  onConnectSuccess?: (channelValue: string) => void;
  /** 断开成功回调 */
  onDisconnectSuccess?: (channelValue: string) => void;
  /**
   * 自定义渲染通道卡片
   * 不传则使用内置的简单 HTML 渲染
   */
  renderChannelCard?: (props: IRenderChannelCardProps) => React.ReactNode;
  /**
   * 自定义渲染 Modal（QQ 表单 / 扫码）
   * 不传则使用内置的简单 dialog
   */
  renderModal?: (props: IRenderModalProps) => React.ReactNode;
}

export interface IRenderChannelCardProps {
  channel: IChannelConfig;
  isBound: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
  loading?: boolean;
}

export interface IRenderModalProps {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}

// ─── SkillPanel ───

export interface SkillPanelProps extends IStandardPanelBaseProps {
  /** SkillHub 搜索 API 的基础 URL */
  skillHubApiUrl?: string;
  /** SkillHub 网站链接 */
  skillHubWebUrl?: string;
  /** 安装成功回调 */
  onInstallSuccess?: (skillSlug: string) => void;
}

// ─── 内部辅助类型 ───

export interface IProviderSelectOption {
  value: string;
  label: string;
  description?: string;
  apiKeyUrl?: string;
  models: Array<{ id: string; name: string }>;
}
