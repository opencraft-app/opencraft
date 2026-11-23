// Browser-side access to the administration route. The server authorizes every
// call; this controller only carries the unsent draft across View remounts.
import {
  LOGIN_ADMISSION_ERRORS,
  LOGIN_ADMISSION_PATH,
  type LoginAdmissionDocument,
  type LoginAdmissionError,
  type LoginAdmissionPreviewIdentity,
  type LoginAdmissionPreviewResult,
  type LoginAdmissionRules,
} from "./contract";

/** Editable text form of the rules; parsed on the server, never trusted here. */
export interface LoginAdmissionDraft {
  readonly enabled: boolean;
  readonly allowlist: string;
  readonly patterns: string;
  readonly conditions: string;
  readonly admitFunction: string;
}

export class LoginAdmissionRequestError extends Error {
  constructor(readonly code: LoginAdmissionError | "request_failed") {
    super(code);
    this.name = "LoginAdmissionRequestError";
  }
}

const lines = (text: string): string[] =>
  text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);

export function draftFromRules(rules: LoginAdmissionRules): LoginAdmissionDraft {
  return {
    enabled: rules.enabled,
    allowlist: rules.allowlist.join("\n"),
    patterns: rules.patterns.join("\n"),
    conditions: rules.conditions.map((condition) => `${condition.attribute}=${condition.equals}`).join("\n"),
    admitFunction: rules.admitFunction ?? "",
  };
}

/** `attribute=value` per line; a line without `=` is sent as-is and refused by the server. */
export function rulesFromDraft(draft: LoginAdmissionDraft): unknown {
  return {
    enabled: draft.enabled,
    allowlist: lines(draft.allowlist),
    patterns: lines(draft.patterns),
    conditions: lines(draft.conditions).map((line) => {
      const separator = line.indexOf("=");
      return separator < 0
        ? { attribute: line, equals: "" }
        : { attribute: line.slice(0, separator).trim(), equals: line.slice(separator + 1).trim() };
    }),
    admitFunction: draft.admitFunction.trim() ? draft.admitFunction : null,
  };
}

export class LoginAdmissionController {
  /** Unpublished edits of this session; cleared when the extension is disposed. */
  draft: LoginAdmissionDraft | null = null;
  /** Revision the draft was started from, so a publish is a CAS against what the editor showed. */
  draftRevision: number | null = null;

  constructor(
    readonly fetcher: typeof fetch,
    readonly url: string = LOGIN_ADMISSION_PATH,
  ) {}

  async #request<T>(body?: unknown, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(this.url, {
        credentials: "same-origin",
        cache: "no-store",
        ...(signal ? { signal } : {}),
        ...(body === undefined
          ? {}
          : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new LoginAdmissionRequestError("request_failed");
    }
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = value && typeof value === "object" ? (value as { error?: unknown }).error : undefined;
      throw new LoginAdmissionRequestError(
        (LOGIN_ADMISSION_ERRORS as readonly unknown[]).includes(code)
          ? (code as LoginAdmissionError)
          : "request_failed",
      );
    }
    if (!value || typeof value !== "object") throw new LoginAdmissionRequestError("request_failed");
    return value as T;
  }

  load(signal?: AbortSignal): Promise<LoginAdmissionDocument> {
    return this.#request<LoginAdmissionDocument>(undefined, signal).then((document) => {
      if (!document.scope || typeof document.revision !== "number" || !document.rules)
        throw new LoginAdmissionRequestError("request_failed");
      return document;
    });
  }

  publish(revision: number, draft: LoginAdmissionDraft): Promise<LoginAdmissionDocument> {
    return this.#request({ action: "publish", revision, rules: rulesFromDraft(draft) });
  }

  preview(draft: LoginAdmissionDraft, identity: LoginAdmissionPreviewIdentity): Promise<LoginAdmissionPreviewResult> {
    return this.#request({ action: "preview", rules: rulesFromDraft(draft), identity });
  }

  /** True when this server enables the policy and the viewer administers it. */
  async available(): Promise<boolean> {
    try {
      await this.load();
      return true;
    } catch {
      return false;
    }
  }

  dispose(): void {
    this.draft = null;
    this.draftRevision = null;
  }
}
