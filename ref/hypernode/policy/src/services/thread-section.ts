import { Service, type Inject } from "@deepseek-ai/cordis";
import type { CanonicalParams } from "../types/canonical-timeline.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type { ThreadLifecyclePrincipal } from "../types/thread-lifecycle.ts";
import type {
  ThreadSection,
  ThreadSectionAppearance,
} from "../types/thread-metadata.ts";
import { uuidV7 } from "./thread-identity.ts";

type Dependencies = "appServer" | "principal" | "threadManager";

interface ThreadSectionSnapshot {
  version: 1;
  sections: ThreadSection[];
}

export const PINNED_THREAD_SECTION_ID = "01984de2-8f74-7c91-a3b2-5c5e937cf318";
export const PINNED_THREAD_SECTION: Readonly<ThreadSection> = Object.freeze({
  id: PINNED_THREAD_SECTION_ID,
  name: "Pinned",
  appearance: null,
});

function objectRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeAppearance(appearance: unknown): ThreadSectionAppearance | null {
  if (appearance === null || appearance === undefined) return null;
  const record = objectRecord(appearance);
  if (record === null) throw new Error("section appearance must be an object or null");
  const normalized: ThreadSectionAppearance = {
    icon: record["icon"] === null || record["icon"] === undefined
      ? null
      : String(record["icon"]),
    color: record["color"] === null || record["color"] === undefined
      ? null
      : String(record["color"]),
  };
  for (const [field, value] of Object.entries(normalized)) {
    if (value !== null && value.length > 64) {
      throw new Error(`section appearance ${field} must not exceed 64 bytes`);
    }
  }
  return normalized;
}

function sectionName(value: unknown): string {
  const name = String(value ?? "").trim();
  if (!name) throw new Error("section name must not be empty");
  return name;
}

function sectionRecord(value: unknown): ThreadSection | null {
  const record = objectRecord(value);
  if (record === null || typeof record["id"] !== "string" || !record["id"] ||
      record["id"] === PINNED_THREAD_SECTION_ID) return null;
  return {
    id: record["id"],
    name: sectionName(record["name"]),
    appearance: normalizeAppearance(record["appearance"]),
  };
}

function sectionSnapshot(value: unknown): ThreadSectionSnapshot | null {
  const snapshot = objectRecord(value);
  if (snapshot?.["version"] !== 1 || !Array.isArray(snapshot["sections"])) return null;
  return {
    version: 1,
    sections: snapshot["sections"].map(sectionRecord).filter(
      (section): section is ThreadSection => section !== null,
    ),
  };
}

function requiredString(params: CanonicalParams, key: string): string {
  const value = params[key];
  if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string`);
  return value;
}

export class ThreadSectionService extends Service {
  static inject = ["appServer", "principal", "threadManager"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;
  readonly principal: ThreadLifecyclePrincipal;
  readonly sections = new Map<string, ThreadSection>([
    [PINNED_THREAD_SECTION_ID, { ...PINNED_THREAD_SECTION }],
  ]);

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "threadSection");
    this.principal = ctx.principal.current();
    this.load();

    const register = (
      method: string,
      handler: (params: CanonicalParams) => unknown,
    ): void => {
      ctx.effect(() => ctx.appServer.register(method, handler));
    };
    register("threadSection/list", (params) => this.list(params));
    register("threadSection/create", (params) => ({ section: this.create(params) }));
    register("threadSection/update", (params) => ({ section: this.update(params) }));
    register("threadSection/delete", (params) => this.delete(params));
    register("thread/section/move", (params) => this.move(params));
  }

  load(): void {
    const encoded = policyStore.get("threadSections", this.principal.id);
    if (encoded === null) return;
    const snapshot = sectionSnapshot(JSON.parse(encoded) as unknown);
    if (snapshot === null) throw new Error("unsupported thread sections snapshot");
    for (const section of snapshot.sections) this.sections.set(section.id, section);
  }

  persist(): void {
    policyStore.set("threadSections", this.principal.id, JSON.stringify({
      version: 1,
      sections: [...this.sections.values()].filter(({ id }) => id !== PINNED_THREAD_SECTION_ID),
    }));
  }

  get(sectionId: string): ThreadSection {
    const section = this.sections.get(sectionId);
    if (section === undefined) throw new Error(`section ${sectionId} does not exist`);
    return section;
  }

  list(params: CanonicalParams = {}): { data: ThreadSection[]; nextCursor: string | null } {
    const ordered = [...this.sections.values()].sort((left, right) => {
      if (left.id === PINNED_THREAD_SECTION_ID) return -1;
      if (right.id === PINNED_THREAD_SECTION_ID) return 1;
      return left.id.localeCompare(right.id);
    });
    let start = 0;
    if (params.cursor !== null && params.cursor !== undefined) {
      if (typeof params.cursor !== "string") throw new Error("invalid threadSection/list cursor");
      const cursorIndex = ordered.findIndex(({ id }) => id === params.cursor);
      if (cursorIndex < 0) throw new Error("invalid threadSection/list cursor");
      start = cursorIndex + 1;
    }
    const requestedLimit = Number(params.limit);
    const limit = Number.isInteger(requestedLimit) && requestedLimit > 0
      ? Math.min(requestedLimit, 100)
      : 20;
    const data = ordered.slice(start, start + limit).map((section) => ({ ...section }));
    return {
      data,
      nextCursor: start + data.length < ordered.length && data.length > 0
        ? data[data.length - 1]?.id ?? null
        : null,
    };
  }

  create(params: CanonicalParams): ThreadSection {
    const section: ThreadSection = {
      id: uuidV7(),
      name: sectionName(params["name"]),
      appearance: normalizeAppearance(params["appearance"]),
    };
    this.sections.set(section.id, section);
    this.persist();
    return { ...section };
  }

  update(params: CanonicalParams): ThreadSection {
    const sectionId = requiredString(params, "sectionId");
    if (sectionId === PINNED_THREAD_SECTION_ID) {
      throw new Error("the built-in pinned section cannot be renamed");
    }
    const section = this.get(sectionId);
    section.name = sectionName(params["name"]);
    if (Object.prototype.hasOwnProperty.call(params, "appearance")) {
      section.appearance = normalizeAppearance(params["appearance"]);
    }
    this.persist();
    for (const thread of this.ctx.threadManager.threads.values()) {
      if (thread.section?.id === section.id) thread.section = { ...section };
    }
    this.ctx.threadManager.persist();
    return { ...section };
  }

  delete(params: CanonicalParams): Record<string, never> {
    const sectionId = requiredString(params, "sectionId");
    if (sectionId === PINNED_THREAD_SECTION_ID) {
      throw new Error("the built-in pinned section cannot be deleted");
    }
    this.get(sectionId);
    this.sections.delete(sectionId);
    this.ctx.threadManager.clearSection(sectionId);
    this.persist();
    return {};
  }

  move(params: CanonicalParams): Record<string, never> {
    const threadId = requiredString(params, "threadId");
    const rawSectionId = params["sectionId"];
    const sectionId = rawSectionId === null || rawSectionId === undefined
      ? null
      : String(rawSectionId);
    if (sectionId !== null && !sectionId.trim()) throw new Error("sectionId must not be empty");
    const section = sectionId === null ? null : this.get(sectionId);
    const rawBeforeThreadId = params["beforeThreadId"];
    const beforeThreadId = rawBeforeThreadId === null || rawBeforeThreadId === undefined
      ? null
      : String(rawBeforeThreadId);
    this.ctx.threadManager.moveToSection(threadId, section, beforeThreadId);
    return {};
  }
}
