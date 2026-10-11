/**
 * Hermes profile 元数据（profile.yaml）读写
 * ──────────────────────────────────────────────────────────────
 * 为什么不写 SOUL.md：
 *   SOUL.md 是 hermes 的 auto-loaded context file，整份喂给模型
 *   （见 hermes_cli/config_defaults.py 的 "one auto-loaded context file"）。
 *   名字 / 描述 / 头像这类展示用元数据塞进去有三个代价：
 *     1. 每轮对话都占 token，模型读到 `LightVela-Avatar: blob:#F9A8C4` 毫无意义
 *     2. 迫使整体覆盖 SOUL.md —— 用户在对话里调教的人设会被冲掉
 *     3. 拿不到 hermes 为 ui_meta 准备的并发保护
 *
 * hermes 的正统落点（见 hermes_cli/profiles.py、tui_gateway/methods_profiles.py）：
 *   display_name  ← 展示名（`name` 是 profile 目录名，不可变，参与 spawn/解析）
 *   description   ← 1-2 句角色描述，供 kanban 调度器按角色分派
 *   ui_meta       ← 客户端 UI 元数据（key 级合并，64KB 上限）
 *   assets/avatar.{png,jpg,webp} ← 图片头像（本模块暂不涉及）
 *
 * 实现方式：直接调 hermes 自己的 read_profile_meta / write_profile_meta。
 * 好处是白拿它的原子写（utils.atomic_yaml_write）与「只覆盖传入字段、
 * 其余原样保留」语义 —— 已实测 ui_meta 和未知顶层字段都不会被抹掉。
 */

import { DEFAULT_HERMES_AGENT_ID, getHermesProfileRootCommand } from "@/lib/hermes-agent-command";
import { parseHermesAppearance, type HermesAppearance } from "@/lib/hermes-appearance";

/**
 * UTF-8 安全的 base64。
 *
 * 就地实现而不是复用 agent-buddy-setup 的同名函数 —— lib/ 不该反向依赖 pages/。
 * btoa 只接受 latin1，中文必须先转字节。
 */
const encodeBase64 = (input: string): string => {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** 几何体头像在 ui_meta 里的 key */
export const UI_META_AVATAR_KEY = "lightvela_avatar";
export const UI_META_APPEARANCE_KEY = "lightvela_appearance";

export type HermesProfileMeta = {
  displayName: string;
  description: string;
  /** 描述是否为自动生成（模板套用）而非用户手填 */
  descriptionAuto: boolean;
  /** 几何体头像，null 表示未设置（存量用户） */
  avatar: { shapeId: string; color: string } | null;
  appearance: HermesAppearance | null;
};

export const EMPTY_PROFILE_META: HermesProfileMeta = {
  displayName: "",
  description: "",
  descriptionAuto: false,
  avatar: null,
  appearance: null,
};

/**
 * 把 hermes 的 venv python 包进命令。
 *
 * 不用 `hermes` 可执行文件 —— 沙箱里不保证存在（见 hermes-skills-client 的同类说明）。
 * 走 venv python + sys.path 注入，与 buildInstalledSkillsListCommand 同构。
 *
 * 脚本用 quoted heredoc 传入而不是 `python -c "..."`：
 * -c 需要把换行编码进字符串字面量，JSON.stringify 会产出 `\n` 字面量导致
 * SyntaxError；quoted heredoc（<<'EOF'）原样传递且不做变量展开，
 * 脚本里的 $ 和引号都不会被 shell 碰。
 */
const withHermesPython = (script: string, profileId: string): string => {
  const base = '"${HERMES_HOME:-$HOME/.hermes}"';
  return [
    "set -eo pipefail",
    getHermesProfileRootCommand(profileId, "HERMES_PROFILE_ROOT"),
    // 必须 export：python 是子进程，不 export 读不到（os.environ 会 KeyError）
    "export HERMES_PROFILE_ROOT",
    `HERMES_APP=${base}/hermes-agent`,
    'cd "$HERMES_APP"',
    "./venv/bin/python - <<'__LV_PY_EOF__'",
    script,
    "__LV_PY_EOF__",
  ].join("\n");
};

/** 读 profile.yaml，输出单行 JSON 便于前端解析 */
export const buildProfileMetaReadCommand = (
  profileId: string = DEFAULT_HERMES_AGENT_ID,
): string => withHermesPython(
  [
    "import sys, json, os",
    "sys.path.insert(0, '.')",
    "from pathlib import Path",
    "d = Path(os.environ['HERMES_PROFILE_ROOT'])",
    "out = {'displayName': '', 'description': '', 'descriptionAuto': False, 'ui_meta': {}}",
    "try:",
    "    from hermes_cli.profiles import read_profile_meta",
    "    m = read_profile_meta(d)",
    "    out['displayName'] = m.get('display_name') or ''",
    "    out['description'] = m.get('description') or ''",
    "    out['descriptionAuto'] = bool(m.get('description_auto'))",
    "except Exception:",
    "    pass",
    // ui_meta 不在 read_profile_meta 的返回里，单独读
    "try:",
    "    import yaml",
    "    raw = yaml.safe_load((d / 'profile.yaml').read_text(encoding='utf-8')) or {}",
    "    um = raw.get('ui_meta')",
    "    out['ui_meta'] = um if isinstance(um, dict) else {}",
    "except Exception:",
    "    pass",
    "print('__LV_META__' + json.dumps(out, ensure_ascii=False))",
  ].join("\n"),
  profileId,
);

/**
 * 写 profile.yaml。
 *
 * 只传需要改的字段，未传的保持原样 —— 这是 write_profile_meta 的语义，
 * 也是「改头像不该碰描述」的保证。ui_meta 同样 key 级合并。
 */
export const buildProfileMetaWriteCommand = (
  input: {
    displayName?: string;
    description?: string;
    descriptionAuto?: boolean;
    avatar?: { shapeId: string; color: string };
    appearance?: HermesAppearance;
  },
  profileId: string = DEFAULT_HERMES_AGENT_ID,
): string => {
  /*
   * 值经 base64 传入，而不是把 JSON 直接嵌进 python 源码。
   *
   * 直接嵌入的写法（无论 "..." 还是 r'''...'''）都存在注入面：用户在描述里
   * 打出对应的引号序列就能截断字面量。base64 的字符集只有 A-Za-z0-9+/=，
   * 不可能包含引号或换行，从根上消除这个问题。
   */
  const payloadB64 = encodeBase64(JSON.stringify({
    display_name: input.displayName,
    description: input.description,
    description_auto: input.descriptionAuto,
    avatar: input.avatar ? `${input.avatar.shapeId}:${input.avatar.color}` : undefined,
    appearance: input.appearance,
  }));

  return withHermesPython(
    [
      "import sys, json, os, base64",
      "sys.path.insert(0, '.')",
      "from pathlib import Path",
      `data = json.loads(base64.b64decode("${payloadB64}").decode('utf-8'))`,
      "d = Path(os.environ['HERMES_PROFILE_ROOT'])",
      "d.mkdir(parents=True, exist_ok=True)",
      "from hermes_cli.profiles import write_profile_meta",
      "kw = {}",
      "if data.get('display_name') is not None: kw['display_name'] = data['display_name']",
      "if data.get('description') is not None: kw['description'] = data['description']",
      "if data.get('description_auto') is not None: kw['description_auto'] = data['description_auto']",
      "if kw: write_profile_meta(d, **kw)",
      // 头像写 ui_meta：读全量 → 只改这一个 key → 原子写回
      "if data.get('avatar') is not None or data.get('appearance') is not None:",
      "    import yaml",
      "    from utils import atomic_yaml_write",
      "    p = d / 'profile.yaml'",
      "    try:",
      "        raw = yaml.safe_load(p.read_text(encoding='utf-8')) or {}",
      "    except Exception:",
      "        raw = {}",
      "    if not isinstance(raw, dict): raw = {}",
      "    um = raw.get('ui_meta')",
      "    if not isinstance(um, dict): um = {}",
      `    if data.get('avatar') is not None: um[${JSON.stringify(UI_META_AVATAR_KEY)}] = data['avatar']`,
      `    if data.get('appearance') is not None: um[${JSON.stringify(UI_META_APPEARANCE_KEY)}] = data['appearance']`,
      "    raw['ui_meta'] = um",
      "    atomic_yaml_write(p, raw, sort_keys=False)",
      "print('__LV_META_OK__')",
    ].join("\n"),
    profileId,
  );
};

/** 解析读命令的输出 */
export const parseProfileMetaOutput = (output: string): HermesProfileMeta => {
  const marker = "__LV_META__";
  const index = output.lastIndexOf(marker);
  if (index < 0) return EMPTY_PROFILE_META;
  try {
    const raw = JSON.parse(output.slice(index + marker.length).trim()) as {
      displayName?: string;
      description?: string;
      descriptionAuto?: boolean;
      ui_meta?: Record<string, unknown>;
    };
    const avatarRaw = raw.ui_meta?.[UI_META_AVATAR_KEY];
    let avatar: HermesProfileMeta["avatar"] = null;
    if (typeof avatarRaw === "string") {
      const at = avatarRaw.lastIndexOf(":");
      if (at > 0) {
        avatar = { shapeId: avatarRaw.slice(0, at), color: avatarRaw.slice(at + 1) };
      }
    }
    return {
      displayName: raw.displayName ?? "",
      description: raw.description ?? "",
      descriptionAuto: Boolean(raw.descriptionAuto),
      avatar,
      appearance: parseHermesAppearance(raw.ui_meta?.[UI_META_APPEARANCE_KEY]),
    };
  } catch {
    return EMPTY_PROFILE_META;
  }
};
