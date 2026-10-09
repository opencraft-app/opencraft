/**
 * 智能伙伴资料 —— 读真实 SOUL.md
 * ──────────────────────────────────────────────────────────────
 * 资料卡与侧边栏必须同源，都以沙箱里的 SOUL.md 为准：
 *   名字   ← Name:
 *   描述   ← Summary:
 *   标签   ← LightVela-Tags:      （自定义字段）
 *   头像   ← LightVela-Avatar:    （自定义字段，`<shapeId>:<color>`）
 *
 * 之前这里是 sessionStorage 版的 demo 状态，会与真实 bot 数据打架
 * （左上角显示真实名字、资料卡显示旧 demo 名字），已整体替换。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import type { HermesAppearance } from '@/lib/hermes-appearance';

import {
  buildHermesSoulContentReadCommand,
  parseHermesSoulContent,
} from "@/pages/marketing/agent-buddy-command";
import {
  DEFAULT_AVATAR_COLOR,
  DEFAULT_AVATAR_SHAPE,
  type AvatarShapeId,
} from "@/pages/marketing/agent-avatar-shapes";
import {
  EMPTY_PROFILE_META,
  buildProfileMetaReadCommand,
  parseProfileMetaOutput,
} from "@/lib/hermes-profile-meta";
import { parseBuddyProfileFromSoul } from "@/pages/marketing/agent-buddy-setup";
import type { SetupExec } from "@/pages/marketing/agent-buddy-setup-runner";

export type BuddyProfile = {
  name: string;
  shapeId: AvatarShapeId;
  color: string;
  description: string;
  appearance?: HermesAppearance | null;
};

const SOUL_READ_TIMEOUT_MS = 30_000;

/** 合法形状集合，用于校验 SOUL 里读到的值 */
const isKnownShape = (value: string): value is AvatarShapeId => (
  [
    "blob", "circle", "squircle", "square", "teardrop",
    "hexagon", "burst", "triangle", "egg",
  ].includes(value)
);

export type BuddyProfileState = {
  profile: BuddyProfile;
  /** SOUL.md 是否存在 */
  soulExists: boolean | null;
  /**
   * 是否已走过本引导流程写入过配置。
   *
   * 判据是 profile.yaml 或旧 SOUL 中有没有头像字段。后端建 Bot 时
   * 会写一个默认 SOUL.md，所以「SOUL 存在」不能代表「用户配过」。
   * null 表示还没读到（沙箱未就绪等）。
   */
  hasBuddyConfig: boolean | null;
  loading: boolean;
  reload: () => void;
};

/**
 * 已读到的资料缓存（模块级，按 botId + profileId）。
 *
 * 切换 section 时页面会重新挂载本 hook，若每次都从 null 起步，
 * 侧边栏头像会先闪回默认 bot 头像再跳成几何体。缓存让切 tab 时
 * 首帧就拿到上次结果，消除闪烁；后台仍会重新读取以保证新鲜度。
 */
type ProfileSnapshot = {
  profile: BuddyProfile;
  soulExists: boolean | null;
  hasBuddyConfig: boolean | null;
};
const profileCache = new Map<string, ProfileSnapshot>();

/**
 * 读取当前 bot 的资料。
 *
 * fallbackName 用 bot.name，保证 SOUL 还没写时资料卡也有名字可显示，
 * 与左上角保持一致而不是显示占位文案。
 */
export const useBuddyProfile = (params: {
  botId: string | undefined;
  profileId: string | undefined;
  fallbackName: string;
  exec: SetupExec;
}): BuddyProfileState => {
  const { botId, profileId, fallbackName, exec } = params;

  // profile 未就绪时不能猜 main；它代表主 Bot 的真实目录。
  const resolvedProfileId = profileId?.trim() ?? "";
  const scopeKey = botId && resolvedProfileId ? JSON.stringify([botId, resolvedProfileId]) : "";
  const [loaded, setLoaded] = useState<{ key: string; value: ProfileSnapshot } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const reload = useCallback(() => setReloadToken((value) => value + 1), []);
  const fallback = useMemo<ProfileSnapshot>(() => ({
    profile: {
      name: fallbackName,
      shapeId: DEFAULT_AVATAR_SHAPE,
      color: DEFAULT_AVATAR_COLOR,
      description: "",
    },
    soulExists: null,
    hasBuddyConfig: null,
  }), [fallbackName]);
  // 切 Bot/profile 的首帧也不能展示上一个目标的数据。
  const snapshot = (scopeKey && (loaded?.key === scopeKey ? loaded.value : profileCache.get(scopeKey))) || fallback;
  const { profile, soulExists, hasBuddyConfig } = snapshot;
  const loading = Boolean(scopeKey && loadingKey === scopeKey);

  useEffect(() => {
    if (!botId || !resolvedProfileId) return undefined;
    let cancelled = false;
    setLoadingKey(scopeKey);

    void (async () => {
      try {
        /*
         * 两个来源并行读：
         *   profile.yaml —— 展示名 / 描述 / 头像（hermes 的正统元数据落点）
         *   SOUL.md      —— 人设正文，以及存量用户遗留的 Name / Summary / 头像
         *
         * profile.yaml 优先：新写入都落在那里。SOUL 只作为存量回落，
         * 这样既不丢老数据，也不必为了读头像去解析整份人设。
         */
        const [metaResult, soulResult] = await Promise.all([
          exec(botId, buildProfileMetaReadCommand(resolvedProfileId), {
            timeoutMs: SOUL_READ_TIMEOUT_MS,
          }).catch(() => null),
          exec(botId, buildHermesSoulContentReadCommand(resolvedProfileId), {
            timeoutMs: SOUL_READ_TIMEOUT_MS,
          }),
        ]);
        if (cancelled) return;

        const meta = metaResult
          ? parseProfileMetaOutput(metaResult.output || "")
          : EMPTY_PROFILE_META;

        const parsed = parseHermesSoulContent(soulResult.output || "");
        const soulFields = parsed.status === "ready"
          ? parseBuddyProfileFromSoul(parsed.markdown)
          : { name: null, summary: null, avatar: null };

        // 头像：profile.yaml 的 ui_meta 优先，回落到 SOUL 的遗留字段
        const avatar = meta.avatar ?? soulFields.avatar;
        const shapeId = avatar && isKnownShape(avatar.shapeId)
          ? avatar.shapeId
          : DEFAULT_AVATAR_SHAPE;

        const value: ProfileSnapshot = {
          profile: {
            name: meta.displayName || soulFields.name || fallbackName,
            shapeId,
            color: avatar?.color || DEFAULT_AVATAR_COLOR,
            description: meta.description || soulFields.summary || "",
            appearance: meta.appearance,
          },
          soulExists: parsed.status === "ready" || parsed.status === "too_large",
          hasBuddyConfig: avatar !== null || meta.appearance !== null,
        };
        profileCache.set(scopeKey, value);
        setLoaded({ key: scopeKey, value });
      } catch {
        // 暂时读不到时只保留同一 Bot/profile 的缓存；无缓存则仍为未知。
      } finally {
        if (!cancelled) setLoadingKey(null);
      }
    })();

    return () => { cancelled = true; };
  }, [botId, resolvedProfileId, scopeKey, fallbackName, exec, reloadToken]);

  /*
   * 必须 memo。
   *
   * 这个返回值会被页面塞进 useCallback 的依赖数组（如 handleBuddyCreated），
   * 每次渲染都返回新对象字面量的话，那些回调的引用也跟着每次渲染变；一旦这类
   * 回调又出现在某个 effect 的依赖里，那个 effect 就会每渲染一次就 cleanup +
   * 重跑。创建引导的写配置流程正是这么被反复中断、并重复建 bot 的。
   */
  return useMemo(
    () => ({ profile, soulExists, hasBuddyConfig, loading, reload }),
    [profile, soulExists, hasBuddyConfig, loading, reload],
  );
};
