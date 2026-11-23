// Network-thread side of the login admission policy. Every SQLite access runs
// in the storage Worker (`login-admission.worker.ts`); this module keeps only
// an in-memory projection of committed state and never blocks on IO.
import { principalKey, type Principal } from "@opencraft/identity-core";
import {
  HttpBodyTooLarge,
  decodeUtf8,
  jsonResponse,
  type HttpExchangeRequest,
  type HttpExchangeResponse,
} from "@opencraft/identity-core/http-exchange";
import type { AdmissionPolicyCaller, InstanceAdmissionPolicy } from "@opencraft/access-control";
import { WorkerOwner, ownerEntry } from "@opencraft/worker-owner";
import {
  DISABLED_RULES,
  InvalidLoginAdmissionRules,
  LOGIN_ADMISSION_LIMITS,
  LOGIN_ADMISSION_PATH,
  isAttributeName,
  parseLoginAdmissionRules,
  type LoginAdmissionDocument,
  type LoginAdmissionError,
  type LoginAdmissionPreviewResult,
  type LoginAdmissionRules,
  type LoginAdmissionScope,
} from "./contract";
import { RulesEvaluator, compileAdmitFunction, type FunctionInput } from "./evaluate";
import { attributesKey, defaultFunctionInput, type LoginAdmissionIdentity } from "./rules";
import type { DatabaseOutcome } from "@opencraft/sqlite-node";
import {
  LoginAdmissionConflict,
  type LoginAdmissionStoreData,
  type LoginAdmissionStoreMethods,
  type StoredPolicy,
} from "./store-protocol";

export { LOGIN_ADMISSION_PATH } from "./contract";
export type { LoginAdmissionIdentity } from "./rules";

const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SUBJECT = /^[^\u0000-\u001f\u007f]{1,256}$/u;
const SOURCE = /^[A-Za-z0-9._:-]{1,128}$/u;
/** A refused evaluation (function failure) is retried on a later login after this delay. */
const RETRY_MS = 1000;

export interface LoginAdmissionOptions extends LoginAdmissionScope {
  /** Private SQLite file owned by this policy's storage Worker. */
  readonly path: string;
  /**
   * Trusted mapping from verified facts to the JSON input of `admit(input)`.
   * Defaults to `{ identity: { provider, subject, value, attributes } }`.
   * It runs on this thread and must be pure and cheap.
   */
  readonly functionInput?: FunctionInput;
  /** Storage Worker entry; defaults to the module beside this one. */
  readonly workerEntry?: URL;
  readonly now?: () => number;
}

/** Existing policy state handed over once by a deployment that kept its own store. */
export interface LoginAdmissionAdoption {
  /** Stable name of the imported store; a second import with the same name does nothing. */
  readonly source: string;
  /** Becomes the published document only when this scope has none yet. */
  readonly rules: LoginAdmissionRules;
  /** Previously verified logins, so durable work keeps its decision before the next login. */
  readonly identities?: readonly LoginAdmissionIdentity[];
  /** Audit operator recorded for the import. */
  readonly operator?: string;
}

interface Decision {
  readonly key: string;
  readonly allow: boolean;
  readonly retryAt?: number;
}

interface Active {
  readonly revision: number;
  readonly updatedAt: number | null;
  readonly evaluator: RulesEvaluator;
}

const errorStatus: Record<LoginAdmissionError, number> = {
  administrator_required: 403,
  same_origin_json_required: 403,
  revision_conflict: 409,
  cannot_remove_own_administration: 409,
  invalid_policy: 400,
  too_large: 413,
  policy_unavailable: 503,
};

function identityOf(principal: Pick<Principal, "provider" | "subject" | "attributes">): LoginAdmissionIdentity {
  return { provider: principal.provider, subject: principal.subject, attributes: { ...(principal.attributes ?? {}) } };
}

function parseAttributes(text: string): Record<string, string> {
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 16 ||
    Object.entries(value).some(([key, item]) => !isAttributeName(key) || typeof item !== "string" || item.length > 256)
  )
    throw new Error("Invalid stored identity");
  return value as Record<string, string>;
}

const summary = (rules: LoginAdmissionRules) =>
  JSON.stringify({
    enabled: rules.enabled,
    allowlist: rules.allowlist.length,
    patterns: rules.patterns.length,
    conditions: rules.conditions.length,
    function: rules.admitFunction !== null,
  });

/**
 * Login admission keyed by `{ provider, attribute }`. A principal of another
 * provider is outside this policy. For its own provider it fails closed: an
 * unavailable store, a closed policy, a missing attribute or a failing
 * function refuses the login. Existing membership grants and revocations
 * still apply on top; this policy can only narrow who is admitted.
 */
export class LoginAdmissionPolicy implements InstanceAdmissionPolicy {
  readonly scope: LoginAdmissionScope;
  readonly #key: string;
  readonly #owner: WorkerOwner<LoginAdmissionStoreMethods>;
  readonly #input: FunctionInput;
  readonly #now: () => number;
  #active: Active;
  /** Advances on every publication or import; evaluations of an older generation are discarded. */
  #generation = 0;
  readonly #decisions = new Map<string, Decision>();
  /** Verified attributes as last committed by the store, per subject. */
  readonly #identities = new Map<string, LoginAdmissionIdentity>();
  readonly #pending = new Map<string, Promise<void>>();
  #failure: Error | null = null;
  #closing: Promise<void> | null = null;
  /** Serializes administration writes so a CAS failure never races a projection update. */
  #writes: Promise<unknown> = Promise.resolve();

  /** Outcome of opening `login-admission.sqlite` in the storage Worker. */
  readonly outcome: DatabaseOutcome;

  private constructor(
    options: LoginAdmissionOptions,
    owner: WorkerOwner<LoginAdmissionStoreMethods>,
    outcome: DatabaseOutcome,
    stored: StoredPolicy,
  ) {
    this.outcome = outcome;
    this.scope = Object.freeze({ provider: options.provider, attribute: options.attribute });
    this.#key = JSON.stringify([options.provider, options.attribute]);
    this.#owner = owner;
    this.#input = options.functionInput ?? defaultFunctionInput(options.attribute);
    this.#now = options.now ?? Date.now;
    this.#active = this.#activate(stored);
  }

  /** Opens the storage Worker, loads the published document and decides every known identity before serving. */
  static async open(options: LoginAdmissionOptions): Promise<LoginAdmissionPolicy> {
    if (!PROVIDER.test(options.provider) || !isAttributeName(options.attribute))
      throw new Error("Invalid login admission scope");
    if (typeof options.path !== "string" || !options.path)
      throw new Error("Login admission requires a private storage path");
    if (options.functionInput !== undefined && typeof options.functionInput !== "function")
      throw new Error("Invalid login admission function input");
    let policy: LoginAdmissionPolicy | undefined, failure: Error | undefined;
    const data: LoginAdmissionStoreData = { path: options.path };
    const { owner, ready } = await WorkerOwner.open<LoginAdmissionStoreMethods, DatabaseOutcome>(
      options.workerEntry ?? ownerEntry(import.meta.url, "login-admission"),
      {
        name: "Login admission storage",
        workerData: data,
        errors: [LoginAdmissionConflict],
        onFailure: (error) => {
          if (policy) policy.#fail(error);
          else failure ??= error;
        },
      },
    );
    try {
      policy = new LoginAdmissionPolicy(
        options,
        owner,
        ready,
        await owner.call.load(JSON.stringify([options.provider, options.attribute])),
      );
      if (failure) throw failure;
      await policy.#decideAll();
      return policy;
    } catch (error) {
      await owner.close().catch(() => undefined);
      throw error;
    }
  }

  get revision(): number {
    return this.#active.revision;
  }
  get rules(): LoginAdmissionRules {
    return this.#active.evaluator.rules;
  }
  /** The error that fenced this policy, if its storage Worker failed. */
  get unavailable(): Error | null {
    return this.#failure;
  }

  #activate(stored: StoredPolicy): Active {
    const rules = stored.rules === null ? DISABLED_RULES : parseLoginAdmissionRules(JSON.parse(stored.rules));
    this.#identities.clear();
    for (const row of stored.identities) {
      this.#identities.set(row.subject, {
        provider: this.scope.provider,
        subject: row.subject,
        attributes: parseAttributes(row.attributes),
      });
    }
    return {
      revision: stored.revision,
      updatedAt: stored.updatedAt,
      evaluator: new RulesEvaluator(rules, this.scope.attribute, this.#input),
    };
  }

  async #decideAll(): Promise<void> {
    const generation = this.#generation,
      identities = [...this.#identities.values()];
    const results = await this.#active.evaluator.evaluateAll(identities);
    if (generation !== this.#generation) return;
    this.#decisions.clear();
    identities.forEach((identity, index) =>
      this.#decisions.set(identity.subject, this.#decision(identity, results[index]!)),
    );
  }

  #decision(identity: LoginAdmissionIdentity, result: { allow: boolean; failed: boolean }): Decision {
    return {
      key: attributesKey(identity.attributes),
      allow: result.allow,
      ...(result.failed ? { retryAt: this.#now() + RETRY_MS } : {}),
    };
  }

  #fail(error: Error): void {
    this.#failure ??= error;
    this.#decisions.clear();
  }

  #fenced(): boolean {
    return this.#failure !== null || this.#closing !== null;
  }

  /** Evaluates a verified login of this provider before the Hub admits it. Never authenticates. */
  async prepare(principal: Principal): Promise<void> {
    if (principal.provider !== this.scope.provider || this.#fenced()) return;
    const identity = identityOf(principal),
      key = attributesKey(identity.attributes);
    const current = this.#decisions.get(principal.subject);
    if (current?.key === key && (current.retryAt === undefined || current.retryAt > this.#now())) return;
    const generation = this.#generation,
      work = JSON.stringify([generation, principal.subject, key]);
    let pending = this.#pending.get(work);
    if (!pending) {
      const evaluator = this.#active.evaluator;
      pending = (async () => {
        const result = await evaluator.evaluate(identity);
        if (this.#fenced() || generation !== this.#generation) return;
        this.#decisions.set(principal.subject, this.#decision(identity, result));
        const known = this.#identities.get(principal.subject);
        if (known && attributesKey(known.attributes) === key) return;
        this.#identities.set(principal.subject, identity);
        // Durable record for later decisions; a lost Worker fences the policy through onFailure.
        await this.#owner.call
          .recordIdentity(this.#key, principal.subject, JSON.stringify(identity.attributes), this.#now())
          .catch(() => undefined);
      })().finally(() => this.#pending.delete(work));
      this.#pending.set(work, pending);
    }
    await pending;
    // A publication during evaluation must decide with the newly published rules.
    if (!this.#fenced() && generation !== this.#generation) await this.prepare(principal);
  }

  allows(principal: Principal): boolean {
    if (principal.provider !== this.scope.provider) return true;
    if (this.#fenced()) return false;
    if (!this.#active.evaluator.rules.enabled) return true;
    const decision = this.#decisions.get(principal.subject);
    return decision !== undefined && decision.key === attributesKey(principal.attributes ?? {}) && decision.allow;
  }

  allowsBinding(binding: Pick<Principal, "provider" | "subject">): boolean {
    if (binding.provider !== this.scope.provider) return true;
    if (this.#fenced()) return false;
    return !this.#active.evaluator.rules.enabled || this.#decisions.get(binding.subject)?.allow === true;
  }

  /** Administration under `LOGIN_ADMISSION_PATH`; null for any other path. */
  async handle(request: HttpExchangeRequest, caller: AdmissionPolicyCaller): Promise<HttpExchangeResponse | null> {
    if (new URL(request.path, "http://access.invalid").pathname !== LOGIN_ADMISSION_PATH) return null;
    const send = (status: number, body: unknown) =>
      jsonResponse(status, body, [
        ["content-type", "application/json"],
        ["cache-control", "private, no-store"],
        ["x-content-type-options", "nosniff"],
      ]);
    const fail = (code: LoginAdmissionError) => send(errorStatus[code], { error: code });
    if (!caller.administrator()) return fail("administrator_required");
    if (this.#fenced()) return fail("policy_unavailable");
    if (request.method === "GET") {
      try {
        return send(200, await this.document());
      } catch {
        return fail("policy_unavailable");
      }
    }
    if (request.method !== "POST") return send(405, { error: "method_not_allowed" });
    if (!caller.sameOriginJson) return fail("same_origin_json_required");
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(decodeUtf8(await request.readBody(LOGIN_ADMISSION_LIMITS.body)));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fail("invalid_policy");
      body = parsed as Record<string, unknown>;
    } catch (error) {
      return fail(error instanceof HttpBodyTooLarge ? "too_large" : "invalid_policy");
    }
    try {
      if (body.action === "preview") {
        if (Object.keys(body).some((key) => !["action", "rules", "identity"].includes(key)))
          return fail("invalid_policy");
        const rules = parseLoginAdmissionRules(body.rules),
          identity = this.#previewIdentity(body.identity);
        const result: LoginAdmissionPreviewResult = await new RulesEvaluator(
          rules,
          this.scope.attribute,
          this.#input,
        ).evaluate(identity);
        return caller.administrator() ? send(200, result) : fail("administrator_required");
      }
      if (
        body.action !== "publish" ||
        Object.keys(body).some((key) => !["action", "revision", "rules"].includes(key)) ||
        !Number.isSafeInteger(body.revision) ||
        (body.revision as number) < 0
      )
        return fail("invalid_policy");
      const rules = parseLoginAdmissionRules(body.rules);
      if (rules.admitFunction !== null)
        await compileAdmitFunction(rules.admitFunction).catch(() => {
          throw new InvalidLoginAdmissionRules();
        });
      await this.#publish(body.revision as number, rules, caller);
      return send(200, await this.document());
    } catch (error) {
      if (error instanceof InvalidLoginAdmissionRules) return fail("invalid_policy");
      if (error instanceof LoginAdmissionConflict) return fail("revision_conflict");
      if (error instanceof PublishRefused) return fail(error.code);
      return fail("policy_unavailable");
    }
  }

  #previewIdentity(input: unknown): LoginAdmissionIdentity {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new InvalidLoginAdmissionRules();
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => !["value", "subject", "attributes"].includes(key)) ||
      typeof value.value !== "string" ||
      !SUBJECT.test(value.value) ||
      (value.subject !== undefined && (typeof value.subject !== "string" || !SUBJECT.test(value.subject)))
    )
      throw new InvalidLoginAdmissionRules();
    let attributes: Record<string, string> = {};
    if (value.attributes !== undefined) {
      try {
        attributes = parseAttributes(JSON.stringify(value.attributes));
      } catch {
        throw new InvalidLoginAdmissionRules();
      }
    }
    return {
      provider: this.scope.provider,
      subject: (value.subject as string | undefined) ?? "preview",
      attributes: { ...attributes, [this.scope.attribute]: value.value },
    };
  }

  async #publish(expected: number, rules: LoginAdmissionRules, caller: AdmissionPolicyCaller): Promise<void> {
    const run = this.#writes.then(async () => {
      if (expected !== this.#active.revision) throw new LoginAdmissionConflict();
      const evaluator = new RulesEvaluator(rules, this.scope.attribute, this.#input);
      // Publishing cannot lock its own administrator out of this instance.
      const administrator = caller.administrator();
      if (!administrator) throw new PublishRefused("administrator_required");
      if (
        rules.enabled &&
        administrator.provider === this.scope.provider &&
        !(await evaluator.evaluate(identityOf(administrator))).allow
      ) {
        throw new PublishRefused("cannot_remove_own_administration");
      }
      const identities = [...this.#identities.values()];
      const results = await evaluator.evaluateAll(identities);
      // Rechecked after the (possibly slow) evaluation, immediately before the commit.
      const current = caller.administrator();
      if (!current) throw new PublishRefused("administrator_required");
      const operator = principalKey(current);
      const revision = await this.#owner.call.publish(
        this.#key,
        expected,
        JSON.stringify(rules),
        operator,
        this.#now(),
        summary(rules),
      );
      this.#generation++;
      this.#active = { revision, updatedAt: this.#now(), evaluator };
      this.#decisions.clear();
      identities.forEach((identity, index) =>
        this.#decisions.set(identity.subject, this.#decision(identity, results[index]!)),
      );
    });
    this.#writes = run.catch(() => undefined);
    await run;
  }

  /** Current document with recent versions and audit entries (administrator view). */
  async document(): Promise<LoginAdmissionDocument> {
    const history = await this.#owner.call.history(this.#key, 20);
    return {
      scope: this.scope,
      revision: this.#active.revision,
      rules: this.#active.evaluator.rules,
      updatedAt: this.#active.updatedAt,
      knownIdentities: this.#identities.size,
      versions: history.versions.map((version) => ({
        revision: version.revision,
        rules: parseLoginAdmissionRules(JSON.parse(version.rules)),
        at: version.at,
      })),
      audit: history.audit.map((entry) => ({
        revision: entry.revision,
        action: entry.action === "import" ? "import" : "publish",
        at: entry.at,
        operator: entry.operator,
      })),
    };
  }

  /**
   * Adopts a policy kept by an earlier deployment-specific store, once per
   * `source`. The rules become the published document only when this scope has
   * none; known identities are merged without overwriting newer ones. Returns
   * whether the rules were applied.
   */
  async adopt(adoption: LoginAdmissionAdoption): Promise<{ imported: boolean; applied: boolean }> {
    if (this.#fenced()) throw new Error("Login admission is unavailable");
    if (typeof adoption.source !== "string" || !SOURCE.test(adoption.source))
      throw new Error("Invalid login admission source");
    const rules = parseLoginAdmissionRules(adoption.rules);
    if (rules.admitFunction !== null) await compileAdmitFunction(rules.admitFunction);
    const identities = (adoption.identities ?? []).map((identity) => {
      if (
        identity.provider !== this.scope.provider ||
        typeof identity.subject !== "string" ||
        !SUBJECT.test(identity.subject)
      )
        throw new Error("Invalid adopted identity");
      return {
        subject: identity.subject,
        attributes: JSON.stringify(parseAttributes(JSON.stringify(identity.attributes))),
      };
    });
    const operator = adoption.operator ?? "adoption:" + adoption.source;
    const run = this.#writes.then(async () => {
      const outcome = await this.#owner.call.importPolicy(
        this.#key,
        adoption.source,
        JSON.stringify(rules),
        identities,
        operator,
        this.#now(),
        summary(rules),
      );
      if (outcome.imported) {
        this.#generation++;
        this.#active = this.#activate(await this.#owner.call.load(this.#key));
        await this.#decideAll();
      }
      return outcome;
    });
    this.#writes = run.catch(() => undefined);
    return run;
  }

  /** Waits for queued administration and identity writes, then stops the storage Worker. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    return (this.#closing = (async () => {
      await this.#writes;
      await Promise.allSettled([...this.#pending.values()]);
      this.#decisions.clear();
      await this.#owner.close().catch(() => undefined);
    })());
  }
}

class PublishRefused extends Error {
  constructor(readonly code: "administrator_required" | "cannot_remove_own_administration") {
    super(code);
    this.name = "PublishRefused";
  }
}

export const openLoginAdmissionPolicy = (options: LoginAdmissionOptions) => LoginAdmissionPolicy.open(options);
