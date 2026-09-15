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

import { useCallback, useEffect, useState } from "react";

import {
  buildHermesSoulContentReadCommand,
  parseHermesSoulContent,
} from "@/pages/marketing/agent-buddy-command";
import {
  DEFAULT_AVATAR_COLOR,
  DEFAULT_AVATAR_SHAPE,
  type AvatarShapeId,
} from "@/pages/marketing/agent-avatar-shapes";
import { parseBuddyProfileFromSoul } from "@/pages/marketing/agent-buddy-setup";
import type { SetupExec } from "@/pages/marketing/agent-buddy-setup-runner";

export type BuddyProfile = {
  name: string;
  shapeId: AvatarShapeId;
  color: string;
  /** 顿号分隔的标签串，空串表示未设置 */
  tags: string;
  description: string;
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
   * 判据是 SOUL 里有没有 `LightVela-Avatar` 自定义字段 —— 后端建 bot 时
   * 会写一个默认 SOUL.md，所以「SOUL 存在」不能代表「用户配过」。
   * null 表示还没读到（沙箱未就绪等）。
   */
  hasBuddyConfig: boolean | null;
  loading: boolean;
  reload: () => void;
};

/**
 * 已读到的资料缓存（模块级，按 botId）。
 *
 * 切换 section 时页面会重新挂载本 hook，若每次都从 null 起步，
 * 侧边栏头像会先闪回默认 bot 头像再跳成几何体。缓存让切 tab 时
 * 首帧就拿到上次结果，消除闪烁；后台仍会重新读取以保证新鲜度。
 */
const profileCache = new Map<string, {
  profile: BuddyProfile;
  soulExists: boolean | null;
  hasBuddyConfig: boolean | null;
}>();

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

  const cached = botId ? profileCache.get(botId) : undefined;

  const [profile, setProfile] = useState<BuddyProfile>(cached?.profile ?? {
    name: fallbackName,
    shapeId: DEFAULT_AVATAR_SHAPE,
    color: DEFAULT_AVATAR_COLOR,
    tags: "",
    description: "",
  });
  const [soulExists, setSoulExists] = useState<boolean | null>(cached?.soulExists ?? null);
  const [hasBuddyConfig, setHasBuddyConfig] = useState<boolean | null>(cached?.hasBuddyConfig ?? null);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const reload = useCallback(() => setReloadToken((value) => value + 1), []);

  /** 统一落地：同时更新 state 与缓存，避免两者漂移 */
  const commit = useCallback(
    (
      next: BuddyProfile,
      exists: boolean | null,
      configured: boolean | null,
      targetBotId: string,
    ) => {
      profileCache.set(targetBotId, {
        profile: next,
        soulExists: exists,
        hasBuddyConfig: configured,
      });
      setProfile(next);
      setSoulExists(exists);
      setHasBuddyConfig(configured);
    },
    [],
  );

  useEffect(() => {
    if (!botId) return undefined;
    let cancelled = false;
    setLoading(true);

    void (async () => {
      try {
        const result = await exec(
          botId,
          buildHermesSoulContentReadCommand(profileId ?? "main"),
          { timeoutMs: SOUL_READ_TIMEOUT_MS },
        );
        if (cancelled) return;

        const parsed = parseHermesSoulContent(result.output || "");
        if (parsed.status !== "ready") {
          // missing / too_large / invalid：名字回落 bot.name，其余留空
          commit(
            {
              name: fallbackName,
              shapeId: DEFAULT_AVATAR_SHAPE,
              color: DEFAULT_AVATAR_COLOR,
              tags: "",
              description: "",
            },
            parsed.status === "too_large",
            false,
            botId,
          );
          return;
        }

        const fields = parseBuddyProfileFromSoul(parsed.markdown);
        const shapeId = fields.avatar && isKnownShape(fields.avatar.shapeId)
          ? fields.avatar.shapeId
          : DEFAULT_AVATAR_SHAPE;
        commit(
          {
            name: fields.name || fallbackName,
            shapeId,
            color: fields.avatar?.color || DEFAULT_AVATAR_COLOR,
            tags: fields.tags ?? "",
            description: fields.summary ?? "",
          },
          true,
          // 有 avatar 自定义字段才算走过引导（后端默认 SOUL 不含它）
          fields.avatar !== null,
          botId,
        );
      } catch {
        /* 沙箱未就绪或命令失败：保留上次已知结果（缓存），
           只有从未读到过时才置 null（未知）——
           避免把「读不到」误判成「未配置」而把用户困在引导页，
           也避免已显示的头像因一次网络抖动闪回默认图。 */
        if (!cancelled && !profileCache.has(botId)) {
          setSoulExists(null);
          setHasBuddyConfig(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => { cancelled = true; };
  }, [botId, profileId, fallbackName, exec, reloadToken, commit]);

  return { profile, soulExists, hasBuddyConfig, loading, reload };
};
