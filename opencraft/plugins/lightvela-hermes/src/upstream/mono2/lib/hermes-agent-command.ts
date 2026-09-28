// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
export const DEFAULT_HERMES_AGENT_ID = "main";
const HERMES_DEFAULT_PROFILE_ID = "default";

const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

export function toHermesNativeProfileId(profileId: string): string {
  return profileId === DEFAULT_HERMES_AGENT_ID ? HERMES_DEFAULT_PROFILE_ID : profileId;
}

export function withHermesAgent(
  command: string,
  agentId: string = DEFAULT_HERMES_AGENT_ID,
): string {
  return `${command} --agent ${shellQuote(agentId)}`;
}

export function requireHermesSkillsProfile(profileId?: string): string {
  const id = profileId?.trim();
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
    throw new Error("当前 Bot 缺少有效的 Profile，无法操作技能");
  }
  return id === HERMES_DEFAULT_PROFILE_ID ? DEFAULT_HERMES_AGENT_ID : id;
}

/** Keep older ACLI list/uninstall scoped while newer releases resolve --agent themselves. */
export function withHermesSkillsProfile(command: string, profileId?: string): string {
  const id = requireHermesSkillsProfile(profileId);
  const runtimeHome = id === DEFAULT_HERMES_AGENT_ID
    ? '"$HERMES_BASE"'
    : `"$HERMES_BASE/profiles/${id}"`;
  return `HERMES_BASE="\${HERMES_HOME:-$HOME/.hermes}"; ACLI_SYS_RUNTIME_HOME="$HERMES_BASE" ACLI_RUNTIME_HOME=${runtimeHome} ${withHermesAgent(command, id)}`;
}

/**
 * 探测 CLI 是否支持 --agent，支持就带上；两个分支都注入 ACLI 运行时变量。
 *
 * 之前 else 分支跑的是**裸命令**（既无 --agent 也无运行时变量）。旧版 ACLI
 * 正是靠 ACLI_RUNTIME_HOME 定位 profile 的，裸命令会落到实例的默认 profile
 * ——也就是主 bot。表现为：在新建 bot 里装 skills.sh 技能，创建流程显示成功，
 * 但新 bot 的技能页是空的，技能实际装进了主 bot。
 *
 * 国内站的 SkillHub 分支早前踩过同一个坑（改用 withHermesSkillsProfile 修
 * 好了），这条 skills.sh 分支当时没一起改。
 */
export function withHermesAgentCompatibility(
  command: string,
  capabilityHelpCommand: string,
  agentId: string = DEFAULT_HERMES_AGENT_ID,
): string {
  const runtimeHome = agentId === DEFAULT_HERMES_AGENT_ID
    ? '"$HERMES_BASE"'
    : `"$HERMES_BASE/profiles/${agentId}"`;
  /*
   * 用 export 而不是 `VAR=x cmd` 前缀：后者只对**简单命令**生效，
   * 下面跟的是 if/then/fi 复合命令，写成前缀是语法错误。
   */
  const runtimeEnv = `HERMES_BASE="\${HERMES_HOME:-$HOME/.hermes}";`
    + ` export ACLI_SYS_RUNTIME_HOME="$HERMES_BASE";`
    + ` export ACLI_RUNTIME_HOME=${runtimeHome};`;
  const scopedCommand = withHermesAgent(command, agentId);
  return `${runtimeEnv} if ${capabilityHelpCommand} --help 2>&1 | grep -q -- '--agent'; then ${scopedCommand}; else ${command}; fi`;
}

export function getHermesChannelStatusCommand(
  agentId: string = DEFAULT_HERMES_AGENT_ID,
): string {
  return withHermesAgent("acli channel status", agentId);
}

export function getHermesProfileRootCommand(
  agentId: string = DEFAULT_HERMES_AGENT_ID,
  variableName = "HERMES_PROFILE_ROOT",
): string {
  const base = "${HERMES_HOME:-$HOME/.hermes}";
  if (agentId === DEFAULT_HERMES_AGENT_ID) return `${variableName}="${base}"`;
  return `${variableName}="${base}/profiles/"${shellQuote(agentId)}`;
}

export function withHermesProfile(
  command: string,
  agentId: string = DEFAULT_HERMES_AGENT_ID,
): string {
  return `hermes -p ${shellQuote(toHermesNativeProfileId(agentId))} ${command}`;
}
