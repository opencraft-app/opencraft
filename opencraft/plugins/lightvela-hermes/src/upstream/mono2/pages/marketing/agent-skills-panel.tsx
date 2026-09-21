// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import { useCallback, useEffect, useId, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import { ArrowUp, Check, File, Folder, FolderOpen, Link2, Loader2, Maximize2, MessageSquareText, Minimize2, Sparkles, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { Textarea } from "../../components/ui/textarea";
import { useRepositories } from "../../contexts/repository-context";
import { useT } from "../../i18n/t";
import { isGlobal } from "../../lib/region";
import { joinTsshPath, parentTsshPath, TencentTsshFileClient, type TsshFileInfo } from "../../lib/tencent-tssh-file-client";
import { cn } from "../../lib/utils";
import {
  ExpertsPanel,
  type ExpertsExecDebugCommand,
} from "./agent-experts-panel";
import {
  SkillsDemoPanel,
  type LearnSkillTriggerOptions,
  type SkillsDemoMode,
  type SkillsDemoTab,
  type SkillsHeaderNavigationProps,
} from "./skills-demo/SkillsDemoPanel";
import type { SkillsDataLayer } from "./skills-demo/skill-registries";
import { ZhHantScope } from "./zh-hant-scope";

type LearnSkillSourceKind = "cloud" | "url" | "notes" | "upload";
type LearnSkillStatus = "idle" | "loading" | "learning" | "success" | "error";
type LearnSkillProgressPhase =
  | "idle"
  | "connecting"
  | "working"
  | "complete"
  | "error";
type LearnSkillProgress = {
  phase: LearnSkillProgressPhase;
  percent: number;
  label: string;
  detail?: string;
};

const LEARN_SKILL_DEFAULT_PATH = "/home/agentuser/.hermes";

export function getSafeUploadFileName(fileName: string): string {
  const basename = fileName.split(/[\\/]/).pop()?.trim() ?? "";
  return basename && basename !== "." && basename !== ".." ? basename : "uploaded-file";
}
const LEARNED_SKILL_ROOTS = [
  "/home/agentuser/.hermes/skills",
  "/home/agentuser/.codex/skills",
  "/home/agentuser/.agents/skills",
  "/home/agentuser/workspace/.codex/skills",
  "/home/agentuser/workspace/.agents/skills",
  "/home/agentuser/.hermes/hermes-agent/.codex/skills",
  "/home/agentuser/.hermes/hermes-agent/.agents/skills",
] as const;
const HERMES_LEARN_TIMEOUT_SECONDS = 900;
const HERMES_LEARN_COMPLETE_SENTINEL = "__LIGHTVELA_HERMES_LEARN_COMPLETE__";
const HERMES_LEARN_BASE_TOOLSETS = "terminal,file,skills";
const HERMES_LEARN_WEB_TOOLSETS = "web,terminal,file,skills";
const MAX_SKILL_SEARCH_DEPTH = 4;
const RECENT_SKILL_ARTIFACT_GRACE_MS = 120_000;
const INITIAL_LEARN_SKILL_PROGRESS: LearnSkillProgress = {
  phase: "idle",
  percent: 0,
  label: "Ready to learn",
};

function getAgentSkillsTabStyle(isActive: boolean): CSSProperties {
  return {
    color: isActive ? "rgba(0,0,0,0.95)" : "rgba(0,0,0,0.38)",
    fontFamily: "inherit",
    fontSize: "18px",
    fontWeight: 600,
    lineHeight: "24px",
  };
}

function getLearnSourcePanelClass(selected: boolean) {
  return [
    "space-y-3 rounded-md border p-3 transition-colors",
    selected
      ? "border-[#2F6BFF] bg-[#F6FAFF] shadow-[inset_0_0_0_1px_rgba(47,107,255,0.12)]"
      : "border-black/10 bg-white",
  ].join(" ");
}

function getLearnSourceIndicatorClass(selected: boolean) {
  return selected
    ? "inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-[#2F6BFF] text-white"
    : "inline-flex size-5 shrink-0 rounded-full border border-black/15 bg-white";
}

const isDirectory = (file: TsshFileInfo) => file.type === "d";

const normalizeSkillFileName = (value: string) => {
  const cleaned = value.trim().replace(/\.md$/i, "").replace(/[\\/:\0]/g, "-");
  return cleaned || null;
};

const getSkillNameCandidates = (skillName: string) => {
  const trimmed = skillName.trim().replace(/\.md$/i, "");
  const kebab = trimmed
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const compact = trimmed.replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();
  const candidates = [trimmed, trimmed.toLowerCase(), kebab, compact].filter(Boolean);
  return Array.from(new Set(candidates));
};

const compactSkillName = (value: string) =>
  value.trim().replace(/\.md$/i, "").replace(/[^a-zA-Z0-9]+/g, "").toLowerCase();

const namesMatchSkill = (entryName: string, candidates: string[]) => {
  const normalizedEntry = entryName.trim().replace(/\.md$/i, "").toLowerCase();
  const compactEntry = compactSkillName(entryName);
  return candidates.some((candidate) => candidate.toLowerCase() === normalizedEntry || compactSkillName(candidate) === compactEntry);
};

const listPathOrEmpty = async (client: TencentTsshFileClient, path: string) => {
  try {
    const entries = await client.listPath(path);
    return Array.isArray(entries) ? entries : [];
  } catch {
    return [];
  }
};

const findSkillMarkdownInDirectory = async (client: TencentTsshFileClient, directoryPath: string) => {
  const entries = await listPathOrEmpty(client, directoryPath);
  const skillFile = entries.find((entry) => !isDirectory(entry) && entry.name.toLowerCase() === "skill.md");
  if (skillFile) {
    return joinTsshPath(directoryPath, skillFile.name);
  }
  const markdownFile = entries.find((entry) => !isDirectory(entry) && entry.name.toLowerCase().endsWith(".md"));
  return markdownFile ? joinTsshPath(directoryPath, markdownFile.name) : null;
};

const findLearnedSkillArtifactInTree = async (
  client: TencentTsshFileClient,
  root: string,
  candidates: string[],
  depth: number,
): Promise<string | null> => {
  const entries = await listPathOrEmpty(client, root);

  for (const entry of entries) {
    if (!namesMatchSkill(entry.name, candidates)) continue;

    const artifactPath = joinTsshPath(root, entry.name);
    if (isDirectory(entry)) {
      return (await findSkillMarkdownInDirectory(client, artifactPath)) ?? artifactPath;
    }
    if (entry.name.toLowerCase().endsWith(".md")) {
      return artifactPath;
    }
  }

  if (depth <= 0) {
    return null;
  }

  for (const entry of entries) {
    if (!isDirectory(entry)) continue;
    const found = await findLearnedSkillArtifactInTree(client, joinTsshPath(root, entry.name), candidates, depth - 1);
    if (found) return found;
  }

  return null;
};

const findLearnedSkillArtifact = async (client: TencentTsshFileClient, skillName: string) => {
  const candidates = getSkillNameCandidates(skillName);

  for (const root of LEARNED_SKILL_ROOTS) {
    const artifactPath = await findLearnedSkillArtifactInTree(client, root, candidates, MAX_SKILL_SEARCH_DEPTH);
    if (artifactPath) return artifactPath;
  }

  return null;
};

type RecentSkillArtifact = {
  path: string;
  modifyTimeMs: number;
};

const getModifyTimeMs = (entry: TsshFileInfo) => {
  if (!entry.modifyTime) return 0;
  return entry.modifyTime > 1_000_000_000_000 ? entry.modifyTime : entry.modifyTime * 1000;
};

const collectRecentSkillArtifacts = async (
  client: TencentTsshFileClient,
  root: string,
  startedAtMs: number,
  depth: number,
): Promise<RecentSkillArtifact[]> => {
  const entries = await listPathOrEmpty(client, root);
  const artifacts: RecentSkillArtifact[] = [];
  const minModifyTimeMs = startedAtMs - RECENT_SKILL_ARTIFACT_GRACE_MS;

  for (const entry of entries) {
    const artifactPath = joinTsshPath(root, entry.name);
    if (isDirectory(entry)) {
      if (depth > 0) {
        artifacts.push(...await collectRecentSkillArtifacts(client, artifactPath, startedAtMs, depth - 1));
      }
      continue;
    }

    const lowerName = entry.name.toLowerCase();
    if (lowerName !== "skill.md" && !lowerName.endsWith(".md")) continue;

    const modifyTimeMs = getModifyTimeMs(entry);
    if (modifyTimeMs >= minModifyTimeMs) {
      artifacts.push({ path: artifactPath, modifyTimeMs });
    }
  }

  return artifacts;
};

const findRecentLearnedSkillArtifact = async (client: TencentTsshFileClient, startedAtMs: number) => {
  const artifacts = (await Promise.all(
    LEARNED_SKILL_ROOTS.map((root) => collectRecentSkillArtifacts(client, root, startedAtMs, MAX_SKILL_SEARCH_DEPTH)),
  )).flat();

  artifacts.sort((a, b) => b.modifyTimeMs - a.modifyTimeMs || a.path.localeCompare(b.path));
  return artifacts[0]?.path ?? null;
};

const shellQuote = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const stripAnsi = (value: string) => value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");

const getOutputTail = (output: string) => {
  const lines = stripAnsi(output)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => line !== HERMES_LEARN_COMPLETE_SENTINEL);
  return lines.slice(-4).join("\n");
};

const buildHermesLearnCliCommand = (prompt: string, toolsets: string) => {
  const script = [
    "set -euo pipefail",
    "export HOME=/home/agentuser",
    "export HERMES_HOME=\"$HOME/.hermes\"",
    "export COLUMNS=10000",
    "mkdir -p \"$HOME/.hermes/skills\"",
    `PROMPT=${shellQuote(prompt)}`,
    `TOOLSETS=${shellQuote(toolsets)}`,
    "if command -v hermes >/dev/null 2>&1; then",
    "  HERMES_BIN=\"$(command -v hermes)\"",
    "  \"$HERMES_BIN\" chat --toolsets \"$TOOLSETS\" -q \"$PROMPT\"",
    "elif [ -x \"$HOME/.hermes/hermes-agent/venv/bin/hermes\" ]; then",
    "  \"$HOME/.hermes/hermes-agent/venv/bin/hermes\" chat --toolsets \"$TOOLSETS\" -q \"$PROMPT\"",
    "elif [ -x \"$HOME/.hermes/hermes-agent/venv/bin/python\" ]; then",
    "  cd \"$HOME/.hermes/hermes-agent\"",
    "  \"$HOME/.hermes/hermes-agent/venv/bin/python\" -m hermes_cli.main chat --toolsets \"$TOOLSETS\" -q \"$PROMPT\"",
    "else",
    "  echo \"Hermes CLI not found in PATH or $HOME/.hermes/hermes-agent/venv\" >&2",
    "  exit 127",
    "fi",
    `printf '\\n${HERMES_LEARN_COMPLETE_SENTINEL}\\n'`,
  ].join("\n");

  return `bash -lc ${shellQuote(script)}`;
};

const buildHermesLearnPrompt = ({
  skillName,
  sourcePaths,
  url,
  notes,
}: {
  skillName: string;
  sourcePaths: string[];
  url: string;
  notes: string;
}) => {
  const lines = [
    `/learn Create a reusable Hermes skill named "${skillName}".`,
    "",
    `Skill name: ${skillName}`,
    `Save the final learned skill in Agent Skills as ${skillName}.md or ${skillName}/SKILL.md.`,
  ];

  if (sourcePaths.length > 0) {
    lines.push("", "Learn from these cloud storage files:");
    lines.push(...sourcePaths.map((path) => `- ${path}`));
  }

  if (url.trim()) {
    lines.push("", "Learn from this website URL:");
    lines.push("Use the Hermes web_extract tool to fetch the URL content before writing the skill.");
    lines.push(url.trim());
  }

  if (notes.trim()) {
    lines.push("", "Additional instructions:");
    lines.push(notes.trim());
  }

  return lines.join("\n");
};

const runHermesLearnCli = async (
  client: TencentTsshFileClient,
  prompt: string,
  toolsets: string,
  t: ReturnType<typeof useT>,
  onProgress?: (progress: LearnSkillProgress) => void,
) => {
  onProgress?.({
    phase: "connecting",
    percent: 18,
    label: t("正在打开 Hermes CLI"),
  });

  onProgress?.({
    phase: "working",
    percent: 48,
    label: t("正在运行 Hermes /learn"),
    detail: toolsets.includes("web")
      ? t("Hermes Agent 正在使用 web_extract 处理 URL、读取来源并写入技能文件。")
      : t("Hermes Agent 正在读取所选来源并写入技能文件。"),
  });

  const result = await client.execCommand(buildHermesLearnCliCommand(prompt, toolsets), HERMES_LEARN_TIMEOUT_SECONDS);
  const outputTail = getOutputTail(result.output);

  if (result.exitCode !== null && result.exitCode !== 0) {
    throw new Error(`Hermes /learn failed with exit code ${result.exitCode}.${outputTail ? `\n${outputTail}` : ""}`);
  }
  if (!result.output.includes(HERMES_LEARN_COMPLETE_SENTINEL)) {
    throw new Error(`Hermes /learn did not finish cleanly.${outputTail ? `\n${outputTail}` : ""}`);
  }

  onProgress?.({
    phase: "working",
    percent: 92,
    label: t("Hermes /learn 已完成"),
    detail: outputTail || undefined,
  });
};

function LearnSkillDialog({
  botId,
  onLearned,
  initialSkillName = "",
  initialUrl = "",
  initialNotes = "",
  triggerLabel,
  hideNotes = false,
  hideName = false,
  inline = false,
}: {
  botId: string;
  onLearned: () => void;
  initialSkillName?: string;
  initialUrl?: string;
  initialNotes?: string;
  triggerLabel?: string;
  hideNotes?: boolean;
  hideName?: boolean;
  inline?: boolean;
}) {
  const repositories = useRepositories();
  const t = useT();
  const urlInputId = useId();
  const nameInputId = useId();
  const extraInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const clientRef = useRef<TencentTsshFileClient | null>(null);
  const [skillName, setSkillName] = useState(initialSkillName);
  const [url, setUrl] = useState(initialUrl);
  const [notes, setNotes] = useState(initialNotes);
  const [notesExpanded, setNotesExpanded] = useState(Boolean(initialNotes));
  const [browseOpen, setBrowseOpen] = useState(false);
  const [path, setPath] = useState(LEARN_SKILL_DEFAULT_PATH);
  const [files, setFiles] = useState<TsshFileInfo[]>([]);
  const [selectedSourceKinds, setSelectedSourceKinds] = useState<LearnSkillSourceKind[]>(() => [
    ...(initialUrl.trim() ? ["url" as const] : []),
    ...(initialNotes.trim() ? ["notes" as const] : []),
  ]);
  const [draftSelectedPaths, setDraftSelectedPaths] = useState<string[]>([]);
  const [selectedSourcePaths, setSelectedSourcePaths] = useState<string[]>([]);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [status, setStatus] = useState<LearnSkillStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<LearnSkillProgress>(INITIAL_LEARN_SKILL_PROGRESS);
  const [learnStartedAt, setLearnStartedAt] = useState<number | null>(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);

  const closeClient = useCallback(() => {
    clientRef.current?.close();
    clientRef.current = null;
  }, []);

  useEffect(() => closeClient, [closeClient]);

  useEffect(() => {
    if (status !== "learning" || learnStartedAt === null) return;
    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - learnStartedAt) / 1_000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1_000);
    return () => window.clearInterval(timer);
  }, [learnStartedAt, status]);

  const getClient = useCallback(async () => {
    if (clientRef.current?.isReady()) {
      return clientRef.current;
    }
    closeClient();
    const bootstrap = await repositories.bots.getTerminalSession(botId);
    const client = new TencentTsshFileClient(bootstrap, {
      channelId: `learn-skill-${botId}`,
      userName: "agentuser",
    });
    clientRef.current = client;
    await client.connect();
    return client;
  }, [botId, closeClient, repositories.bots]);

  const loadPath = useCallback(async (nextPath = path) => {
    setStatus("loading");
    setMessage(null);
    try {
      const entries = await (await getClient()).listPath(nextPath);
      entries.sort((a, b) => Number(isDirectory(b)) - Number(isDirectory(a)) || a.name.localeCompare(b.name));
      setFiles(entries);
      setPath(nextPath);
      setStatus("idle");
    } catch (error) {
      closeClient();
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }, [closeClient, getClient, path]);

  const openBrowser = async () => {
    setBrowseOpen(true);
    await loadPath(path);
  };

  const toggleDraftPath = (remotePath: string) => {
    setDraftSelectedPaths((current) =>
      current.includes(remotePath)
        ? current.filter((item) => item !== remotePath)
        : [...current, remotePath],
    );
  };

  const confirmDraftSelection = () => {
    setSelectedSourcePaths((current) => Array.from(new Set([...current, ...draftSelectedPaths])));
    setDraftSelectedPaths([]);
    setBrowseOpen(false);
  };

  const isSourceSelected = (kind: LearnSkillSourceKind) => selectedSourceKinds.includes(kind);

  const toggleSourceKind = (kind: LearnSkillSourceKind) => {
    setSelectedSourceKinds((current) =>
      current.includes(kind)
        ? current.filter((item) => item !== kind)
        : [...current, kind],
    );
    if (kind === "cloud" && !selectedSourceKinds.includes(kind)) {
      void openBrowser();
    }
  };

  const selectInlineSourceKind = (kind: "cloud" | "url" | "upload") => {
    const alreadySelected = selectedSourceKinds.includes(kind);
    setSelectedSourceKinds((current) => {
      const withoutExternalSources = current.filter((item) => item !== "cloud" && item !== "url" && item !== "upload");
      return alreadySelected ? withoutExternalSources : [...withoutExternalSources, kind];
    });
    if (kind === "cloud" && !alreadySelected) {
      void openBrowser();
    } else if (kind !== "cloud") {
      setBrowseOpen(false);
    }
  };

  const uploadInlineFile = async (file: File) => {
    setStatus("loading");
    setMessage(null);
    try {
      const safeName = getSafeUploadFileName(file.name);
      const remotePath = joinTsshPath(LEARN_SKILL_DEFAULT_PATH, safeName);
      const client = await getClient();
      await client.uploadFile(remotePath, file, (progress) => {
        const percent = progress.totalBytes > 0
          ? Math.round((progress.sentBytes / progress.totalBytes) * 100)
          : 100;
        setProgress({
          phase: "working",
          percent,
          label: t("正在上传文件"),
        });
      });
      setSelectedSourceKinds((current) => [
        ...current.filter((item) => item !== "cloud" && item !== "url" && item !== "upload"),
        "upload",
      ]);
      setSelectedSourcePaths([remotePath]);
      setUploadedFileName(file.name);
      setStatus("idle");
      setProgress({ phase: "complete", percent: 100, label: t("文件已上传") });
    } catch (error) {
      setStatus("error");
      setMessage(error instanceof Error ? error.message : String(error));
      setProgress((current) => ({ ...current, phase: "error", label: t("上传失败") }));
    }
  };

  const selectSourceKind = (kind: LearnSkillSourceKind) => {
    setSelectedSourceKinds((current) => current.includes(kind) ? current : [...current, kind]);
  };

  const learnSkill = async () => {
    const normalizedName = normalizeSkillFileName(skillName);
    if (!normalizedName) {
      setStatus("error");
      setMessage(t("请先命名技能。"));
      setProgress({
        phase: "error",
        percent: 0,
        label: t("缺少技能名称"),
      });
      return;
    }
    setStatus("learning");
    setMessage(null);
    const startedAtMs = Date.now();
    setLearnStartedAt(startedAtMs);
    setElapsedSeconds(0);
    setProgress({
      phase: "connecting",
      percent: 4,
      label: t("正在启动 Hermes /learn"),
    });
    try {
      const learnArgs = {
        skillName: normalizedName,
        sourcePaths: isSourceSelected("cloud") || isSourceSelected("upload") ? selectedSourcePaths : [],
        url: isSourceSelected("url") ? url : "",
        notes: isSourceSelected("notes") ? notes : "",
      };
      const client = await getClient();
      const learnToolsets = isSourceSelected("url") && url.trim() ? HERMES_LEARN_WEB_TOOLSETS : HERMES_LEARN_BASE_TOOLSETS;
      await runHermesLearnCli(client, buildHermesLearnPrompt(learnArgs), learnToolsets, t, setProgress);
      setProgress({
        phase: "working",
        percent: 96,
        label: t("正在检查生成的技能文件"),
      });
      const artifactPath = (await findLearnedSkillArtifact(client, normalizedName))
        ?? (await findRecentLearnedSkillArtifact(client, startedAtMs));
      if (!artifactPath) {
        throw new Error(
          t("Hermes /learn 已完成，但没有找到 {{skillName}} 技能文件。已检查 {{paths}}。", {
            skillName: normalizedName,
            paths: LEARNED_SKILL_ROOTS.join(", "),
          }),
        );
      }
      setStatus("success");
      setProgress((current) => ({
        ...current,
        phase: "complete",
        percent: 100,
        label: t("已完成"),
      }));
      setMessage(t("已完成。已创建 {{path}}。正在刷新智能体技能。", { path: artifactPath }));
      onLearned();
      window.setTimeout(onLearned, 5_000);
    } catch (error) {
      setStatus("error");
      setProgress((current) => ({
        phase: "error",
        percent: current.percent,
        label: t("学习失败"),
      }));
      setMessage(error instanceof Error ? error.message : String(error));
    }
  };

  const busy = status === "loading" || status === "learning";
  const showProgress = progress.phase !== "idle" || status === "learning" || status === "success";

  const learnBody = (
    <div className={inline ? "space-y-5" : "lv-learn-skill-dialog-scroll max-h-[min(92dvh,760px)] overflow-y-auto p-5"}>
      {inline ? (
        <div className="mb-3 flex min-h-10 flex-wrap items-center justify-between gap-3">
          <h4 className="text-sm font-semibold text-black/85">{t("速学")}</h4>
          <p className="text-xs text-black/35 text-pretty">
            {t("写下你的目标和流程，让 Agent 学会你的个人工作方式")}
          </p>
        </div>
      ) : (
        <DialogHeader className="mb-5 pr-8">
          <DialogTitle>{t("学习一个技能")}</DialogTitle>
          <DialogDescription className="max-w-[27rem] text-pretty leading-6">
            {t("给你的智能体一个来源，或告诉它任何你想补充的内容，它会把这些内容变成聊天中可复用的技能！")}
          </DialogDescription>
        </DialogHeader>
      )}

      {inline ? (
        <div className="space-y-4">
          <div className="relative overflow-hidden rounded-md border border-black/[0.12] bg-white">
            <Textarea
              id={extraInputId}
              value={notes}
              onFocus={() => selectSourceKind("notes")}
              onChange={(event) => {
                selectSourceKind("notes");
                setNotes(event.target.value);
              }}
              className="min-h-[280px] resize-none border-0 bg-transparent px-5 pb-16 pt-5 text-sm leading-6 shadow-none focus-visible:ring-0"
              placeholder={t("例如：分析某行业最新趋势，并沉淀成可复用的技能...")}
            />
            <div className="absolute inset-x-4 bottom-3 flex items-center gap-3">
              <div className="min-w-0 flex-1 border-b border-black/20">
                <Label htmlFor={nameInputId} className="sr-only">
                  {t("命名你的技能")}
                </Label>
                <Input
                  id={nameInputId}
                  value={skillName}
                  onChange={(event) => setSkillName(event.target.value)}
                  className="h-8 rounded-none border-0 bg-transparent px-0 text-sm shadow-none focus-visible:ring-0"
                  placeholder={t("命名你的技能")}
                />
              </div>
              <Button
                type="button"
                aria-label={t("学习")}
                onClick={() => void learnSkill()}
                disabled={busy}
                className="size-9 shrink-0 rounded-full bg-black p-0 text-white hover:bg-black/80"
              >
                {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <ArrowUp className="size-4" aria-hidden="true" />}
              </Button>
            </div>
          </div>

          <p className="text-sm font-medium text-black/65">{t("添加来源")}</p>

          <div className="space-y-3">
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={isSourceSelected("cloud")}
                  onClick={() => selectInlineSourceKind("cloud")}
                  disabled={busy}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                    isSourceSelected("cloud")
                      ? "border-[#2F6BFF]/40 bg-[#F5F9FF] text-[#2F6BFF]"
                      : "border-black/10 text-black/65 hover:bg-black/[0.025]",
                  )}
                >
                  <FolderOpen className="size-4" aria-hidden="true" />
                  {t("云端存储")}
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  className="hidden"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (file) void uploadInlineFile(file);
                  }}
                />
                <button
                  type="button"
                  aria-pressed={isSourceSelected("upload")}
                  onClick={() => fileInputRef.current?.click()}
                  disabled={busy}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                    isSourceSelected("upload")
                      ? "border-[#2F6BFF]/40 bg-[#F5F9FF] text-[#2F6BFF]"
                      : "border-black/10 text-black/65 hover:bg-black/[0.025]",
                  )}
                >
                  <Upload className="size-4" aria-hidden="true" />
                  {t("上传文件")}
                </button>
                <button
                  type="button"
                  aria-pressed={isSourceSelected("url")}
                  onClick={() => selectInlineSourceKind("url")}
                  disabled={busy}
                  className={cn(
                    "flex items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
                    isSourceSelected("url")
                      ? "border-[#2F6BFF]/40 bg-[#F5F9FF] text-[#2F6BFF]"
                      : "border-black/10 text-black/65 hover:bg-black/[0.025]",
                  )}
                >
                  <Link2 className="size-4" aria-hidden="true" />
                  {t("网址")}
                </button>
              </div>

              {uploadedFileName ? <p className="text-xs text-black/50">{uploadedFileName}</p> : null}

              {isSourceSelected("cloud") ? (
                <div className="space-y-2 rounded-md bg-[#F8FAFC] p-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="text-sm font-medium text-black/70">{t("云端存储目录")}</p>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="rounded-md bg-white"
                      onClick={() => void openBrowser()}
                      disabled={busy}
                    >
                      <FolderOpen className="size-4 text-black/55" aria-hidden="true" />
                      {t("浏览云端存储")}
                    </Button>
                  </div>
                  {browseOpen ? (
                    <div className="rounded-md border border-black/10 bg-white p-3">
                      <div className="mb-2 flex items-center gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="rounded-md"
                          onClick={() => void loadPath(parentTsshPath(path))}
                          disabled={busy || path === "/home/agentuser"}
                        >
                          {t("上一级")}
                        </Button>
                        <span className="min-w-0 flex-1 truncate text-xs text-black/55">{path}</span>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="rounded-md"
                          onClick={() => void loadPath(path)}
                          disabled={busy}
                        >
                          {t("刷新")}
                        </Button>
                      </div>
                      <div className="max-h-48 overflow-y-auto rounded-md border border-black/5 bg-white">
                        {status === "loading" ? (
                          <div className="flex items-center gap-2 px-3 py-4 text-sm text-black/55">
                            <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                            {t("正在加载云端存储...")}
                          </div>
                        ) : files.length === 0 ? (
                          <div className="px-3 py-4 text-sm text-black/55">{t("这个目录里没有文件。")}</div>
                        ) : (
                          files.map((file) => {
                            const remotePath = joinTsshPath(path, file.name);
                            const directory = isDirectory(file);
                            const selected = draftSelectedPaths.includes(remotePath);
                            return (
                              <div key={remotePath} className="flex items-center gap-2 border-b border-black/5 px-3 py-2 last:border-b-0">
                                <button
                                  type="button"
                                  className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm hover:text-black"
                                  onClick={() => {
                                    if (directory) void loadPath(remotePath);
                                  }}
                                >
                                  {directory ? <Folder className="size-4 shrink-0 text-[#b7791f]" aria-hidden="true" /> : <File className="size-4 shrink-0 text-black/45" aria-hidden="true" />}
                                  <span className="truncate">{file.name}</span>
                                </button>
                                {!directory ? (
                                  <button
                                    type="button"
                                    className="inline-flex size-7 items-center justify-center rounded-md border border-black/10 bg-white text-black/60 hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                                    aria-label={selected ? t("取消选择 {{name}}", { name: file.name }) : t("选择 {{name}}", { name: file.name })}
                                    onClick={() => toggleDraftPath(remotePath)}
                                  >
                                    {selected ? <Check className="size-4" aria-hidden="true" /> : null}
                                  </button>
                                ) : null}
                              </div>
                            );
                          })
                        )}
                      </div>
                      <div className="mt-3 flex justify-end">
                        <Button type="button" size="sm" className="rounded-md" onClick={confirmDraftSelection} disabled={draftSelectedPaths.length === 0}>
                          {t("选择")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                  {selectedSourcePaths.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {selectedSourcePaths.map((selectedPath) => (
                        <span key={selectedPath} className="inline-flex max-w-full items-center rounded-md border border-black/10 bg-white px-2.5 py-1 text-xs text-black/70">
                          <span className="truncate">{selectedPath}</span>
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              ) : null}

              {!isSourceSelected("cloud") && isSourceSelected("url") ? (
                <div className="space-y-2 rounded-md bg-[#F8FAFC] p-3">
                  <Label htmlFor={urlInputId} className="text-sm font-medium text-black/70">{t("网址")}</Label>
                  <Input
                    id={urlInputId}
                    value={url}
                    onFocus={() => selectSourceKind("url")}
                    onChange={(event) => {
                      selectSourceKind("url");
                      setUrl(event.target.value);
                    }}
                    className="rounded-md border-black/10 bg-white"
                    placeholder={t("https://lightvela.ai/（可从任意网站学习）")}
                  />
                </div>
              ) : null}
          </div>

          {message ? (
            <p className={status === "error" ? "text-sm text-red-600" : "text-sm text-black/60"} role={status === "error" ? "alert" : "status"}>
              {message}
            </p>
          ) : null}

          {showProgress ? (
            <div className="rounded-md border border-black/10 bg-[#F8FAFC] p-3">
              <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-[var(--text-primary)]">{progress.label}</span>
                <span className="shrink-0 text-xs text-black/55">
                  {progress.phase === "complete" ? t("已完成") : `${progress.percent}%`}
                  {learnStartedAt !== null ? ` · ${elapsedSeconds}s` : null}
                </span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-black/10" role="progressbar" aria-label={t("学习技能进度")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percent}>
                <div className="h-full rounded-full bg-[#2F6BFF] transition-[width] duration-300 ease-out" style={{ width: `${progress.percent}%` }} />
              </div>
              {progress.detail ? <p className="mt-2 line-clamp-2 text-xs text-black/55">{progress.detail}</p> : null}
            </div>
          ) : null}
        </div>
      ) : (
          <div className="space-y-5">
          {!hideName ? <div className="space-y-2">
            <Label htmlFor={nameInputId}>{t("命名你的技能")}</Label>
            <Input
              id={nameInputId}
              value={skillName}
              onChange={(event) => setSkillName(event.target.value)}
              className="rounded-md"
              placeholder="MySkill"
            />
            {normalizeSkillFileName(skillName) ? (
              <p className="text-xs text-black/50">
                {t("输出：{{name}}.md，会保存到智能体技能", { name: normalizeSkillFileName(skillName) })}
              </p>
            ) : null}
          </div> : null}

          <div className="space-y-3">
            <p className="text-sm font-medium leading-none text-[var(--text-secondary)]">
              {t("选择学习来源")}
            </p>
            <div className="space-y-3">
              <div
                className={`${getLearnSourcePanelClass(isSourceSelected("cloud"))} ${busy ? "" : "cursor-pointer"}`}
                onClick={() => {
                  if (!busy) {
                    toggleSourceKind("cloud");
                  }
                }}
              >
                <div className="flex items-start gap-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-start gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                    aria-label={`${t("云端存储")}. ${t("上传文档、配置或项目资料，让 Agent 从已有文件中学习。")}`}
                    aria-pressed={isSourceSelected("cloud")}
                    onClick={(event) => {
                      event.stopPropagation();
                      toggleSourceKind("cloud");
                    }}
                    disabled={busy}
                  >
                    <span className={isSourceSelected("cloud") ? "mt-0.5 text-[#2F6BFF]" : "mt-0.5 text-black/50"}>
                      <FolderOpen className="size-4" aria-hidden="true" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[var(--text-primary)]">{t("云端存储")}</span>
                      <span className="mt-1 block text-xs leading-5 text-black/55">{t("上传文档、配置或项目资料，让 Agent 从已有文件中学习。")}</span>
                    </span>
                    <span className={getLearnSourceIndicatorClass(isSourceSelected("cloud"))}>
                      {isSourceSelected("cloud") ? <Check className="size-3.5" aria-hidden="true" /> : null}
                    </span>
                  </button>
                </div>

                {isSourceSelected("cloud") ? (
                  <div className="space-y-2" onClick={(event) => event.stopPropagation()}>
                    <div className="flex items-center justify-between gap-3">
                      <p className="text-sm font-medium leading-none text-[var(--text-secondary)]">
                        {t("云端存储目录")}
                      </p>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="rounded-md bg-white"
                        onClick={() => void openBrowser()}
                        disabled={busy}
                      >
                        <FolderOpen className="size-4 text-black/55" aria-hidden="true" />
                        {t("浏览云端存储")}
                      </Button>
                    </div>

                    {browseOpen ? (
                      <div className="rounded-md border border-black/10 bg-white p-3">
                        <div className="mb-2 flex items-center gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="rounded-md"
                            onClick={() => void loadPath(parentTsshPath(path))}
                            disabled={busy || path === "/home/agentuser"}
                          >
                            {t("上一级")}
                          </Button>
                          <span className="min-w-0 flex-1 truncate text-xs text-black/55">{path}</span>
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="rounded-md"
                            onClick={() => void loadPath(path)}
                            disabled={busy}
                          >
                            {t("刷新")}
                          </Button>
                        </div>
                        <div className="max-h-48 overflow-y-auto rounded-md border border-black/5 bg-white">
                          {status === "loading" ? (
                            <div className="flex items-center gap-2 px-3 py-4 text-sm text-black/55">
                              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                              {t("正在加载云端存储...")}
                            </div>
                          ) : files.length === 0 ? (
                            <div className="px-3 py-4 text-sm text-black/55">{t("这个目录里没有文件。")}</div>
                          ) : (
                            files.map((file) => {
                              const remotePath = joinTsshPath(path, file.name);
                              const directory = isDirectory(file);
                              const selected = draftSelectedPaths.includes(remotePath);
                              return (
                                <div
                                  key={remotePath}
                                  className="flex items-center gap-2 border-b border-black/5 px-3 py-2 last:border-b-0"
                                >
                                  <button
                                    type="button"
                                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-sm hover:text-black"
                                    onClick={() => {
                                      if (directory) {
                                        void loadPath(remotePath);
                                      }
                                    }}
                                  >
                                    {directory ? (
                                      <Folder className="size-4 shrink-0 text-[#b7791f]" aria-hidden="true" />
                                    ) : (
                                      <File className="size-4 shrink-0 text-black/45" aria-hidden="true" />
                                    )}
                                    <span className="truncate">{file.name}</span>
                                  </button>
                                  {!directory ? (
                                    <button
                                      type="button"
                                      className="inline-flex size-7 items-center justify-center rounded-md border border-black/10 bg-white text-black/60 hover:bg-[var(--surface-muted)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                                      aria-label={selected ? t("取消选择 {{name}}", { name: file.name }) : t("选择 {{name}}", { name: file.name })}
                                      onClick={() => toggleDraftPath(remotePath)}
                                    >
                                      {selected ? <Check className="size-4" aria-hidden="true" /> : null}
                                    </button>
                                  ) : null}
                                </div>
                              );
                            })
                          )}
                        </div>
                        <div className="mt-3 flex justify-end">
                          <Button
                            type="button"
                            size="sm"
                            className="rounded-md"
                            onClick={confirmDraftSelection}
                            disabled={draftSelectedPaths.length === 0}
                          >
                            {t("选择")}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {selectedSourcePaths.length > 0 ? (
                      <div className="flex flex-wrap gap-2">
                        {selectedSourcePaths.map((selectedPath) => (
                          <span
                            key={selectedPath}
                            className="inline-flex max-w-full items-center rounded-md border border-black/10 bg-white px-2.5 py-1 text-xs text-black/70"
                          >
                            <span className="truncate">{selectedPath}</span>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-xs text-black/45">{t("还没有选择云端存储文件。")}</p>
                    )}
                  </div>
                ) : null}
              </div>

              <div
                className={`${getLearnSourcePanelClass(isSourceSelected("url"))} ${busy ? "" : "cursor-pointer"}`}
                onClick={() => {
                  if (!busy) {
                    toggleSourceKind("url");
                  }
                }}
              >
                <div className="flex items-start gap-3">
                  <span className={isSourceSelected("url") ? "mt-0.5 text-[#2F6BFF]" : "mt-0.5 text-black/50"}>
                    <Link2 className={isSourceSelected("url") ? "size-4 text-[#2F6BFF]" : "size-4"} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <Label htmlFor={urlInputId} className="block text-sm font-semibold text-[var(--text-primary)]">
                          {t("网址")}
                        </Label>
                        <p className="mt-1 text-xs leading-5 text-black/55">{t("粘贴公开教程、文档或网页，让 Agent 提炼成可复用技能。")}</p>
                      </div>
                      <button
                        type="button"
                        className={getLearnSourceIndicatorClass(isSourceSelected("url"))}
                        aria-label={`${t("网址")}. ${t("粘贴公开教程、文档或网页，让 Agent 提炼成可复用技能。")}`}
                        aria-pressed={isSourceSelected("url")}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleSourceKind("url");
                        }}
                        disabled={busy}
                      >
                        {isSourceSelected("url") ? <Check className="size-3.5" aria-hidden="true" /> : null}
                      </button>
                    </div>
                    <Input
                      id={urlInputId}
                      value={url}
                      onFocus={() => selectSourceKind("url")}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => {
                        selectSourceKind("url");
                        setUrl(event.target.value);
                      }}
                      className="rounded-md border-[#BBD7FF] bg-white"
                      placeholder={t("https://lightvela.ai/（可从任意网站学习）")}
                    />
                  </div>
                </div>
              </div>

              {!hideNotes ? <div
                className={`${getLearnSourcePanelClass(isSourceSelected("notes"))} ${busy ? "" : "cursor-pointer"}`}
                onClick={() => {
                  if (!busy) {
                    toggleSourceKind("notes");
                  }
                }}
              >
                <div className="flex items-start gap-3">
                  <span className={isSourceSelected("notes") ? "mt-0.5 text-[#2F6BFF]" : "mt-0.5 text-black/50"}>
                    <MessageSquareText className={isSourceSelected("notes") ? "size-4 text-[#2F6BFF]" : "size-4"} aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <Label htmlFor={extraInputId} className="block text-sm font-semibold text-[var(--text-primary)]">
                          {t("补充说明")}
                        </Label>
                        <p className="mt-1 text-xs leading-5 text-black/55">{t("直接写下你的目标和流程，让 Agent 学会你的专属工作方式。")}</p>
                      </div>
                      <button
                        type="button"
                        className={getLearnSourceIndicatorClass(isSourceSelected("notes"))}
                        aria-label={`${t("补充说明")}. ${t("直接写下你的目标和流程，让 Agent 学会你的专属工作方式。")}`}
                        aria-pressed={isSourceSelected("notes")}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggleSourceKind("notes");
                        }}
                        disabled={busy}
                      >
                        {isSourceSelected("notes") ? <Check className="size-3.5" aria-hidden="true" /> : null}
                      </button>
                    </div>
                    <div className="relative" onClick={(event) => event.stopPropagation()}>
                      <Textarea
                        id={extraInputId}
                        value={notes}
                        onFocus={() => selectSourceKind("notes")}
                        onChange={(event) => {
                          selectSourceKind("notes");
                          setNotes(event.target.value);
                        }}
                        className={`${notesExpanded ? "h-80 min-h-80" : "h-20 min-h-20"} resize-none rounded-md bg-white pr-10`}
                        placeholder={t("例如：分析某行业最新趋势，并沉淀成可复用技能…")}
                      />
                      <button
                        type="button"
                        className="absolute bottom-2 right-2 inline-flex size-7 items-center justify-center rounded-md border border-black/10 bg-white/95 text-black/55 shadow-sm hover:bg-[var(--surface-muted)] hover:text-black focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
                        aria-label={notesExpanded ? t("收起补充说明") : t("展开补充说明")}
                        onClick={() => setNotesExpanded((current) => !current)}
                        disabled={busy}
                      >
                        {notesExpanded ? (
                          <Minimize2 className="size-3.5" aria-hidden="true" />
                        ) : (
                          <Maximize2 className="size-3.5" aria-hidden="true" />
                        )}
                      </button>
                    </div>
                  </div>
                </div>
              </div> : null}
            </div>
          </div>

          {message ? (
            <p
              className={status === "error" ? "text-sm text-red-600" : "text-sm text-black/60"}
              role={status === "error" ? "alert" : "status"}
            >
              {message}
            </p>
          ) : null}

          {showProgress ? (
            <div className="rounded-md border border-black/10 bg-[#F8FAFC] p-3">
              <div className="mb-2 flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-[var(--text-primary)]">{progress.label}</span>
                <span className="shrink-0 text-xs text-black/55">
                  {progress.phase === "complete" ? t("已完成") : `${progress.percent}%`}
                  {learnStartedAt !== null ? ` · ${elapsedSeconds}s` : null}
                </span>
              </div>
              <div
                className="h-2 overflow-hidden rounded-full bg-black/10"
                role="progressbar"
                aria-label={t("学习技能进度")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={progress.percent}
              >
                <div
                  className="h-full rounded-full bg-[#2F6BFF] transition-[width] duration-300 ease-out"
                  style={{ width: `${progress.percent}%` }}
                />
              </div>
              {progress.detail ? (
                <p className="mt-2 line-clamp-2 text-xs text-black/55">{progress.detail}</p>
              ) : null}
            </div>
          ) : null}

          <div className="flex justify-end">
            <Button
              type="button"
              className="rounded-md"
              onClick={() => void learnSkill()}
              disabled={busy}
            >
              {status === "learning" ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
              {t("学习")}
            </Button>
          </div>
        </div>
      )}
      </div>
  );

  if (inline) {
    return learnBody;
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          className="h-9 rounded-md px-3.5 text-sm"
        >
          <Sparkles className="size-4" aria-hidden="true" />
          {triggerLabel ?? t("学习技能")}
        </Button>
      </DialogTrigger>
      <DialogContent className="overflow-hidden rounded-md border border-black/[0.08] bg-white p-0 shadow-xl md:w-[42rem]">
        {learnBody}
      </DialogContent>
    </Dialog>
  );
}

export interface HermesAgentSkillsPanelProps {
  botId: string;
  profileId?: string;
  execDebugCommand: ExpertsExecDebugCommand;
  initialSectionSlug?: string;
  headerEnd?: ReactNode;
  headerRegion?: ComponentType<{ readonly children: ReactNode }>;
  renderHeaderNavigation?: (props: SkillsHeaderNavigationProps) => ReactNode;
  showHeader?: boolean;
  skillsDataLayer: SkillsDataLayer;
}

export function HermesAgentSkillsPanel({
  botId,
  profileId,
  execDebugCommand,
  initialSectionSlug,
  headerEnd,
  headerRegion,
  renderHeaderNavigation,
  showHeader = true,
  skillsDataLayer,
}: HermesAgentSkillsPanelProps) {
  const repositories = useRepositories();
  const t = useT();
  const { i18n } = useTranslation();
  const globalExpertLanguage = i18n.resolvedLanguage?.startsWith("ja")
    ? "ja"
    : i18n.resolvedLanguage === "es"
      ? "es"
    : i18n.resolvedLanguage?.startsWith("zh")
      ? "zh"
      : "en";
  const initialGlobalSkillsTab: SkillsDemoTab = initialSectionSlug === "experts" || initialSectionSlug === "packages"
    ? "experts"
    : "discover";
  const [skillsPanelRevision, refreshSkillsPanel] = useState(0);

  return (
    <ZhHantScope className="min-w-0">
      <Tabs value="skills" className="min-w-0">
      {showHeader ? (
        <>
          <div className="mb-1 flex min-w-0 flex-wrap items-center gap-3">
            <TabsList
              aria-label={t("技能页面切换")}
              className="h-auto justify-start gap-8 rounded-none border-0 bg-transparent p-0 text-black/38 shadow-none"
            >
              <TabsTrigger
                value="skills"
                className="min-w-0 rounded-none bg-transparent px-0 py-0 shadow-none transition-colors hover:text-black/70 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                style={getAgentSkillsTabStyle(true)}
              >
                {t("技能")}
              </TabsTrigger>
            </TabsList>
          </div>
          <p className="mb-3 min-w-0 text-pretty text-sm font-medium leading-6 text-black/50">
            {isGlobal
              ? t("为智能体安装技能。支持 ClawHub 与 skills.sh 两个技能市场，安装后可在对话中自动调用。")
              : "为你的智能体安装技能（Skill），安装后 Agent 执行任务时可自动调用"}
          </p>
        </>
      ) : null}

      <TabsContent value="skills" className="mt-0">
        <SkillsDemoPanel
          key={`${botId}-${skillsPanelRevision}`}
          botId={botId}
          profileId={profileId}
          execDebugCommand={execDebugCommand}
          execDebugCommandStream={repositories.bots.execDebugCommandStream}
          mode={(isGlobal ? "global" : "domestic") satisfies SkillsDemoMode}
          initialTab={initialGlobalSkillsTab}
          dataLayer={skillsDataLayer}
          headerEnd={headerEnd}
          headerRegion={headerRegion}
          renderHeaderNavigation={renderHeaderNavigation}
          expertsPanel={(
            <ExpertsPanel
              botId={botId}
              profileId={profileId}
              mode={isGlobal ? "global" : "domestic"}
              execDebugCommand={execDebugCommand}
              execDebugCommandStream={repositories.bots.execDebugCommandStream}
              lang={isGlobal ? globalExpertLanguage : undefined}
            />
          )}
          learnSkillPanel={(
            <LearnSkillDialog
              botId={botId}
              onLearned={() => refreshSkillsPanel((current) => current + 1)}
              inline
            />
          )}
          learnSkillTriggerFactory={(options: LearnSkillTriggerOptions) => (
            <LearnSkillDialog
              botId={botId}
              onLearned={() => refreshSkillsPanel((current) => current + 1)}
              initialSkillName={options.initialSkillName}
              initialUrl={options.initialUrl}
              initialNotes={options.initialNotes}
              triggerLabel={options.triggerLabel}
              hideNotes={options.hideNotes}
              hideName={options.hideName}
            />
          )}
        />
      </TabsContent>
      </Tabs>
    </ZhHantScope>
  );
}
