export type VelaSettingControl = "switch" | "select" | "text" | "readonly";

export type VelaSettingStatus = "loading" | "ready" | "saving" | "error";

export interface VelaSettingOption<T> {
  description?: string;
  label: string;
  value: T;
}

export interface VelaSetting<T> {
  control: VelaSettingControl;
  description?: string;
  id: string;
  inputType?: "password" | "text" | "url";
  load: () => Promise<T> | T;
  options?: Array<VelaSettingOption<T>>;
  save?: (value: T) => Promise<void> | void;
  title: string;
}

export interface VelaSettingState<T> {
  canSave: boolean;
  error: Error | null;
  isLoading: boolean;
  isSaving: boolean;
  reload: () => Promise<void>;
  setValue: (value: T) => Promise<void>;
  status: VelaSettingStatus;
  value: T | undefined;
}
