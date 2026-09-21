// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import type { User } from "../domain/types";

// ─────────────────────────────────────────────────────────────────────────
// 账号管理页 —— 本地假数据交互状态预设（仅本地 mock 预览使用）
//
// 目的：用真实账号页组件 + 假数据覆盖所有交互状态，便于本地预览调试。
// 消费方：
//   - fake-repositories.ts 的 getSession（按 ?state= 返回对应假用户）
//   - AccountPreviewStateSwitcher（页面右下角浮层切换器）
// ─────────────────────────────────────────────────────────────────────────

export interface AccountPreviewState {
  /** URL ?state= 的取值 */
  key: string;
  /** 切换器上显示的中文标签 */
  label: string;
  /** 覆盖到基础用户上的字段 */
  overrides: Partial<User>;
}

const BASE_PHONE = "13800138000";
const BASE_EMAIL = "user@example.com";

export const ACCOUNT_PREVIEW_STATES: AccountPreviewState[] = [
  {
    key: "fresh",
    label: "全新用户（无手机/邮箱/未实名）",
    overrides: {
      phone: undefined,
      email: undefined,
      emailVerified: false,
      realnameVerified: false,
      realnameLevel: "none",
      realnameAssuranceMode: "face_required",
      realnameSyncStatus: undefined,
    },
  },
  {
    key: "default",
    label: "默认（有手机 / 未绑邮箱 / 未实名）",
    overrides: {
      phone: BASE_PHONE,
      email: undefined,
      emailVerified: false,
      realnameVerified: false,
      realnameLevel: "none",
      realnameAssuranceMode: "face_required",
    },
  },
  {
    key: "phone-email",
    label: "已绑手机 + 已绑邮箱（未实名）",
    overrides: {
      phone: BASE_PHONE,
      email: BASE_EMAIL,
      emailVerified: true,
      realnameVerified: false,
      realnameLevel: "none",
      realnameAssuranceMode: "face_required",
    },
  },
  {
    key: "realname-idcard",
    label: "实名态2：待人脸认证（idcard_2fa）",
    overrides: {
      phone: BASE_PHONE,
      email: BASE_EMAIL,
      emailVerified: true,
      realnameVerified: false,
      realnameLevel: "idcard_2fa",
      realnameAssuranceMode: "face_required",
      realnameSyncStatus: "pending",
    },
  },
  {
    key: "realname-done",
    label: "实名态3：认证成功（phone_3fa）",
    overrides: {
      phone: BASE_PHONE,
      email: BASE_EMAIL,
      emailVerified: true,
      realnameVerified: true,
      realnameLevel: "phone_3fa",
      realnameAssuranceMode: "face_required",
      realnameSyncStatus: "succeeded",
    },
  },
  {
    key: "realname-sync-failed",
    label: "实名同步失败（可重试）",
    overrides: {
      phone: BASE_PHONE,
      email: BASE_EMAIL,
      emailVerified: true,
      realnameVerified: false,
      realnameLevel: "idcard_2fa",
      realnameAssuranceMode: "face_required",
      realnameSyncStatus: "failed",
    },
  },
  {
    key: "name-pending",
    label: "昵称审核中",
    overrides: {
      phone: BASE_PHONE,
      pendingName: "审核中的新昵称",
      nameAuditStatus: "pending",
    },
  },
  {
    key: "name-failed",
    label: "昵称审核失败",
    overrides: {
      phone: BASE_PHONE,
      nameAuditStatus: "failed",
    },
  },
  {
    key: "avatar-pending",
    label: "头像审核中",
    overrides: {
      phone: BASE_PHONE,
      pendingAvatarUrl: "/auth/profile/avatar",
      avatarAuditStatus: "pending",
    },
  },
  {
    key: "avatar-failed",
    label: "头像审核失败",
    overrides: {
      phone: BASE_PHONE,
      avatarAuditStatus: "failed",
    },
  },
  {
    key: "realname-legacy",
    label: "legacy 模式（旧实名，无 FaceID）",
    overrides: {
      phone: BASE_PHONE,
      realnameVerified: false,
      realnameLevel: "none",
      realnameAssuranceMode: "legacy",
    },
  },
];

export const DEFAULT_ACCOUNT_PREVIEW_KEY = "default";

/** 按 key 取预设覆盖字段；未命中回退到 default。 */
export const getAccountPreviewOverrides = (key: string | null): Partial<User> => {
  const found = key ? ACCOUNT_PREVIEW_STATES.find((s) => s.key === key) : undefined;
  const fallback = ACCOUNT_PREVIEW_STATES.find((s) => s.key === DEFAULT_ACCOUNT_PREVIEW_KEY);
  return (found ?? fallback)?.overrides ?? {};
};
