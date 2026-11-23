// Sandboxed evaluation of the admin-authored `admit(input)` function.
//
// The source runs only inside `@opencraft/javascript-runtime`: QuickJS compiled
// to WebAssembly in a disposable Worker. The guest realm has no `require`,
// `import`, `process`, timers, network, file system or host callbacks; its input
// is a frozen JSON copy and its only output is bounded JSON. Each run is limited
// to a 16 MiB QuickJS heap, a 256 KiB stack, 100 ms of interpreter time and 3 s
// of wall time (64 MiB Worker heap). This policy runs at most two at once and
// queues up to 512 further evaluations (the shared runtime admits four).
// Anything else (an exception, a timeout, a malformed result) is a failure,
// which the policy turns into a refusal.
import { javascript, jsonFunctionSource } from "@opencraft/javascript-runtime";
import type { LoginAdmissionMatch, LoginAdmissionRules } from "./contract";
import { compileRules, type CompiledRules, type LoginAdmissionIdentity } from "./rules";

export type FunctionInput = (identity: LoginAdmissionIdentity) => unknown;

export interface Evaluation {
  readonly allow: boolean;
  readonly match: LoginAdmissionMatch | null;
  /** The function could not produce a decision; `allow` is false. */
  readonly failed: boolean;
}

/** Identities per sandbox run when a whole population is (re)evaluated. */
const BATCH = 50;
/** Sandbox runs this policy starts at once; the shared runtime admits four in total, so other users keep capacity. */
const CONCURRENT = 2;
/** Sign-ins waiting for a sandbox run before further ones are refused (and retried on a later sign-in). */
const WAITING = 512;
let active = 0;
const waiting: (() => void)[] = [];

/** Queues instead of failing when the sandbox is busy; a full queue fails, which refuses. */
async function sandboxed<T>(run: () => Promise<T>): Promise<T> {
  if (active >= CONCURRENT) {
    if (waiting.length >= WAITING) throw new Error("admission_sandbox_busy");
    // The finishing run hands its slot over directly, so `active` never exceeds the limit.
    await new Promise<void>((resolve) => waiting.push(resolve));
  } else active++;
  try {
    return await run();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else active--;
  }
}

const decision = (value: unknown): boolean | null =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  typeof (value as { allow?: unknown }).allow === "boolean"
    ? (value as { allow: boolean }).allow
    : null;

/** Syntax check only: the source compiles and nothing runs. */
export async function compileAdmitFunction(source: string): Promise<void> {
  await sandboxed(() => javascript({ compile: true, sources: [jsonFunctionSource(source, "admit")] }));
}

export async function runAdmitFunction(source: string, input: unknown): Promise<boolean> {
  const allow = decision(
    await sandboxed(() => javascript({ source: jsonFunctionSource(source, "admit"), args: input, context: null })),
  );
  if (allow === null) throw new Error("invalid_function_result");
  return allow;
}

/** One sandbox run decides a batch; a throwing call decides only its own entry (as a failure). */
async function runAdmitBatch(source: string, inputs: readonly unknown[]): Promise<(boolean | null)[]> {
  const wrapper = `${source}
function __admitEach(list) {
  return list.map(function (item) {
    try { var result = admit(item); return result && typeof result === "object" && !Array.isArray(result) && Object.keys(result).length === 1 && typeof result.allow === "boolean" ? result.allow : null; }
    catch (error) { return null; }
  });
}`;
  const result = await sandboxed(() =>
    javascript({ source: jsonFunctionSource(wrapper, "__admitEach"), args: inputs, context: null }),
  );
  if (
    !Array.isArray(result) ||
    result.length !== inputs.length ||
    result.some((item) => item !== null && typeof item !== "boolean")
  ) {
    throw new Error("invalid_function_result");
  }
  return result as (boolean | null)[];
}

export class RulesEvaluator {
  readonly compiled: CompiledRules;
  constructor(
    readonly rules: LoginAdmissionRules,
    readonly attribute: string,
    readonly input: FunctionInput,
  ) {
    this.compiled = compileRules(rules);
  }

  /** Declarative rules first; the function only for identities they do not admit. A login without the scope's attribute is refused. */
  async evaluate(identity: LoginAdmissionIdentity): Promise<Evaluation> {
    if (!this.#hasLogin(identity)) return { allow: false, match: null, failed: false };
    const match = this.compiled.match(identity, this.attribute);
    if (match) return { allow: true, match, failed: false };
    if (this.rules.admitFunction === null) return { allow: false, match: null, failed: false };
    try {
      const allow = await runAdmitFunction(this.rules.admitFunction, this.input(identity));
      return { allow, match: allow ? "function" : null, failed: false };
    } catch {
      return { allow: false, match: null, failed: true };
    }
  }

  #hasLogin(identity: LoginAdmissionIdentity): boolean {
    return Object.hasOwn(identity.attributes, this.attribute) && identity.attributes[this.attribute] !== "";
  }

  /** Evaluates a population in sandbox batches; a failed batch fails (refuses) only its own entries. */
  async evaluateAll(identities: readonly LoginAdmissionIdentity[]): Promise<Evaluation[]> {
    const results: Evaluation[] = identities.map((identity) => {
      const match = this.#hasLogin(identity) ? this.compiled.match(identity, this.attribute) : null;
      return { allow: match !== null, match, failed: false };
    });
    const source = this.rules.admitFunction;
    if (source === null) return results;
    const pending = identities
      .map((identity, index) => ({ identity, index }))
      .filter(({ identity, index }) => !results[index]!.allow && this.#hasLogin(identity));
    for (let start = 0; start < pending.length; start += BATCH) {
      const batch = pending.slice(start, start + BATCH);
      let outcomes: (boolean | null)[];
      try {
        outcomes = await runAdmitBatch(
          source,
          batch.map(({ identity }) => this.input(identity)),
        );
      } catch {
        outcomes = batch.map(() => null);
      }
      batch.forEach(({ index }, position) => {
        const allow = outcomes[position];
        results[index] =
          allow === null || allow === undefined
            ? { allow: false, match: null, failed: true }
            : { allow, match: allow ? "function" : null, failed: false };
      });
    }
    return results;
  }
}
