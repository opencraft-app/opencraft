import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { parse } from "yaml";

import {
  type ProfileSkillAction,
  type ProfileSkillInstalled,
  type ProfileSkillsErrorCode,
  type ProfileSkillsMethod,
  type ProfileSkillsMethodResult,
  type SkillInstallScope,
} from "@opencraft/appserver-protocol";

type RecordValue = Record<string, unknown>;

const MAX_FILES = 128;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

class DshProfileSkillsError extends Error {
  readonly rpcCode = -32061;

  constructor(
    readonly code: ProfileSkillsErrorCode,
    message: string,
    readonly scope?: SkillInstallScope,
  ) {
    super(message);
    this.name = "DshProfileSkillsError";
  }

  get domainData() {
    return {
      domain: "profile-skills" as const,
      code: this.code,
      retryable: false,
      ...(this.scope === undefined ? {} : { scope: this.scope }),
    };
  }
}

interface ManagedSkillRow {
  readonly name: string;
  readonly description: string;
  readonly path: string;
  readonly markdownPath: string;
  readonly content: string;
}

function record(value: unknown): RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as RecordValue
    : {};
}

function localScope(value: unknown): SkillInstallScope {
  const scope = record(value);
  if (scope.type !== "local-dsh" || scope.root !== "user") {
    throw new DshProfileSkillsError(
      "PROFILE_NOT_FOUND",
      "Local DSH Skills requires the user installation scope",
    );
  }
  return { type: "local-dsh", root: "user" };
}

function parseSkillMarkdown(content: string, fallbackName: string) {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/u.exec(content);
  let metadata: RecordValue = {};
  if (frontmatter !== null) {
    try { metadata = record(parse(frontmatter[1])); } catch { metadata = {}; }
  }
  const name = typeof metadata.name === "string" && metadata.name.trim() !== ""
    ? metadata.name.trim()
    : fallbackName;
  const description = typeof metadata.description === "string"
    ? metadata.description.trim()
    : "Local DSH skill";
  return { name, description };
}

function revision(rows: readonly ManagedSkillRow[]): string {
  const hash = createHash("sha256");
  for (const row of rows) hash.update(row.name).update("\0").update(row.content).update("\0");
  return `dsh-skills-v1-${hash.digest("hex").slice(0, 16)}`;
}

function page<T>(items: readonly T[], cursor: unknown, limit: unknown) {
  const offset = typeof cursor === "string" && /^dsh-skills:\d+$/u.test(cursor)
    ? Number(cursor.slice("dsh-skills:".length))
    : 0;
  const size = typeof limit === "number" && Number.isFinite(limit)
    ? Math.min(Math.max(Math.floor(limit), 1), 100)
    : 100;
  return {
    data: items.slice(offset, offset + size),
    nextCursor: offset + size < items.length ? `dsh-skills:${offset + size}` : null,
  };
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

/** Filesystem authority for the OpenCraft-owned local DSH user Skill root. */
export class DshProfileSkillsHandler {
  private readonly actions = new Map<string, ProfileSkillAction>();
  private readonly operations = new Map<string, ProfileSkillAction>();

  constructor(private readonly root: string, private readonly onChanged?: () => Promise<void | "unsupported">) {}

  async handle<TMethod extends ProfileSkillsMethod>(
    method: TMethod,
    rawParams: unknown,
  ): Promise<ProfileSkillsMethodResult<TMethod>> {
    const params = record(rawParams);
    const scope = localScope(params.scope);
    let result: unknown;
    switch (method) {
      case "skills/installed/list": result = await this.listInstalled(params); break;
      case "skills/installed/content/read": result = await this.readContent(params); break;
      case "skills/install": result = await this.install(scope, params); break;
      case "skills/uninstall": result = await this.uninstall(scope, params); break;
      case "skills/action/read": result = this.readAction(scope, params); break;
      default:
        throw new DshProfileSkillsError(
          "UNSUPPORTED_OPERATION",
          `Local DSH does not support ${method}`,
          scope,
        );
    }
    return result as ProfileSkillsMethodResult<TMethod>;
  }

  private async rows(): Promise<ManagedSkillRow[]> {
    if (!await exists(this.root)) return [];
    const entries = await readdir(this.root, { withFileTypes: true });
    const rows: ManagedSkillRow[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const path = join(this.root, entry.name);
      const markdownPath = entry.isDirectory()
        ? join(path, "SKILL.md")
        : entry.isFile() && extname(entry.name).toLowerCase() === ".md"
          ? path
          : null;
      if (markdownPath === null || !await exists(markdownPath)) continue;
      const content = await readFile(markdownPath, "utf8");
      const fallbackName = entry.isDirectory() ? entry.name : basename(entry.name, extname(entry.name));
      const metadata = parseSkillMarkdown(content, fallbackName);
      rows.push({ ...metadata, path, markdownPath, content });
    }
    return rows.sort((left, right) => left.name.localeCompare(right.name));
  }

  private async listInstalled(params: RecordValue) {
    const rows = await this.rows();
    const installed: ProfileSkillInstalled[] = rows.map((row) => ({
      name: row.name,
      description: row.description,
      category: "local",
      enabled: true,
      provenance: "local",
      catalogIdentifier: row.name,
    }));
    return { ...page(installed, params.cursor, params.limit), revision: revision(rows) };
  }

  private async readContent(params: RecordValue) {
    const name = this.requiredSkillName(params.name);
    const rows = await this.rows();
    const row = rows.find((candidate) => candidate.name === name);
    if (row === undefined) throw new DshProfileSkillsError("SKILL_NOT_FOUND", `Skill ${name} is not installed`);
    return { name, content: row.content, revision: revision(rows) };
  }

  private async install(scope: SkillInstallScope, params: RecordValue) {
    const operationId = this.requiredOperationId(params.operationId);
    const replay = this.operations.get(operationId);
    if (replay !== undefined) return { action: replay };
    const artifact = record(params.artifact);
    const name = this.requiredSkillName(artifact.name);
    const files = Array.isArray(artifact.files) ? artifact.files.map(record) : [];
    if (files.length === 0 || files.length > MAX_FILES) {
      throw new DshProfileSkillsError("INVALID_IDENTIFIER", "Skill artifact has an invalid file count", scope);
    }
    const normalized = files.map((file) => {
      const path = this.safeRelativePath(file.path);
      const content = typeof file.content === "string" ? file.content : "";
      const bytes = Buffer.byteLength(content);
      if (bytes > MAX_FILE_BYTES) throw new DshProfileSkillsError("INVALID_IDENTIFIER", `Skill file is too large: ${path}`, scope);
      if (typeof file.sha256 === "string") {
        const actual = createHash("sha256").update(content).digest("hex");
        if (actual !== file.sha256.toLowerCase()) {
          throw new DshProfileSkillsError("INVALID_IDENTIFIER", `Skill file checksum mismatch: ${path}`, scope);
        }
      }
      return { path, content, bytes };
    });
    if (!normalized.some((file) => file.path === "SKILL.md")) {
      throw new DshProfileSkillsError("INVALID_IDENTIFIER", "Skill artifact must contain SKILL.md", scope);
    }
    if (normalized.reduce((total, file) => total + file.bytes, 0) > MAX_ARTIFACT_BYTES) {
      throw new DshProfileSkillsError("INVALID_IDENTIFIER", "Skill artifact is too large", scope);
    }
    await mkdir(this.root, { recursive: true });
    const target = join(this.root, name);
    if (await exists(target)) throw new DshProfileSkillsError("ALREADY_INSTALLED", `Skill ${name} is already installed`, scope);
    const temporary = join(this.root, `.install-${name}-${randomUUID()}`);
    try {
      await mkdir(temporary, { recursive: false });
      for (const file of normalized) {
        const destination = resolve(temporary, file.path);
        if (!destination.startsWith(`${temporary}${sep}`)) {
          throw new DshProfileSkillsError("INVALID_IDENTIFIER", `Invalid Skill path: ${file.path}`, scope);
        }
        await mkdir(resolve(destination, ".."), { recursive: true });
        await writeFile(destination, file.content, { encoding: "utf8", flag: "wx" });
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
    return { action: await this.succeeded(scope, operationId, "install", name, `Installed to ${target}`) };
  }

  private async uninstall(scope: SkillInstallScope, params: RecordValue) {
    const operationId = this.requiredOperationId(params.operationId);
    const replay = this.operations.get(operationId);
    if (replay !== undefined) return { action: replay };
    const name = this.requiredSkillName(params.name);
    const rows = await this.rows();
    const matches = rows.filter((row) => row.name === name);
    if (matches.length !== 1) throw new DshProfileSkillsError("NOT_INSTALLED", `Skill ${name} is not installed`, scope);
    const row = matches[0];
    if (relative(this.root, row.path).startsWith("..")) {
      throw new DshProfileSkillsError("POLICY_BLOCKED", "Skill path escaped the managed root", scope);
    }
    const trash = join(this.root, ".trash");
    await mkdir(trash, { recursive: true });
    await rename(row.path, join(trash, `${basename(row.path)}-${randomUUID()}`));
    return { action: await this.succeeded(scope, operationId, "uninstall", name, "Moved to the recoverable Skill trash") };
  }

  private readAction(scope: SkillInstallScope, params: RecordValue) {
    const actionId = typeof params.actionId === "string" ? params.actionId : "";
    const action = this.actions.get(actionId);
    if (action === undefined || action.scope.type !== scope.type) {
      throw new DshProfileSkillsError("ACTION_NOT_FOUND", "Skill action was not found", scope);
    }
    return { action };
  }

  private async succeeded(
    scope: SkillInstallScope,
    operationId: string,
    kind: "install" | "uninstall",
    target: string,
    message: string,
  ): Promise<ProfileSkillAction> {
    const now = Date.now();
    const action: ProfileSkillAction = {
      actionId: `dsh-skill-${randomUUID()}`,
      operationId,
      scope,
      kind,
      target,
      state: "succeeded",
      startedAtMs: now,
      completedAtMs: now,
      exitCode: 0,
      logLines: [message],
    };
    this.actions.set(action.actionId, action);
    this.operations.set(operationId, action);
    try {
      if (await this.onChanged?.() === "unsupported") {
        const unsupported = { ...action, logLines: [...action.logLines, "Files committed; the connected engine does not support automatic Skill catalog refresh."] };
        this.actions.set(action.actionId, unsupported);
        this.operations.set(operationId, unsupported);
        return unsupported;
      }
    } catch {
      // The filesystem commit succeeded. Never misreport it as a failed install
      // or repeat it to repair a runtime refresh; the Host retries before use.
      const pending = { ...action, logLines: [...action.logLines, "Files committed; runtime Skill refresh is pending and will be retried before execution."] };
      this.actions.set(action.actionId, pending);
      this.operations.set(operationId, pending);
      return pending;
    }
    return action;
  }

  private requiredSkillName(value: unknown): string {
    if (typeof value !== "string" || !SKILL_NAME.test(value)) {
      throw new DshProfileSkillsError("INVALID_IDENTIFIER", "Skill name must be kebab-case");
    }
    return value;
  }

  private requiredOperationId(value: unknown): string {
    if (typeof value !== "string" || value.trim() === "" || value.length > 160) {
      throw new DshProfileSkillsError("INVALID_IDENTIFIER", "Skill operationId is invalid");
    }
    return value;
  }

  private safeRelativePath(value: unknown): string {
    if (typeof value !== "string" || value.length === 0 || value.length > 240 || value.includes("\0")) {
      throw new DshProfileSkillsError("INVALID_IDENTIFIER", "Skill file path is invalid");
    }
    const normalized = value.replaceAll("\\", "/");
    if (normalized.startsWith("/") || normalized.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
      throw new DshProfileSkillsError("INVALID_IDENTIFIER", `Skill file path is invalid: ${value}`);
    }
    return normalized;
  }
}
