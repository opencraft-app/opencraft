import { createHash } from "node:crypto";
import { EnvironmentError, validateEnvironmentName } from "./account-environment.js";
import type { EnvironmentExecutionScope } from "./execution-environment.js";
import type { PersonalGitGrant } from "./personal-git.js";
const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");
export const executionEnvironmentOwner = (scope: EnvironmentExecutionScope) =>
  digest([scope.account, scope.hostId, scope.projectId]);
/** Values are deliberately absent from inspect/JSON, errors and diagnostics. */
export class ExecutionEnvironmentSnapshot {
  readonly owner: string;
  readonly account: string | null;
  readonly key: string;
  private readonly values: Readonly<Record<string, string>>;
  constructor(
    scope: EnvironmentExecutionScope,
    values: Record<string, string>,
    private readonly git?: PersonalGitGrant,
    readonly needsGitAdmission = false,
  ) {
    this.owner = executionEnvironmentOwner(scope);
    this.account = scope.account;
    this.key = digest([this.owner, values, git?.environment]);
    this.values = Object.freeze({ ...values });
    for (const property of ["values", "key", "account", "git"])
      Object.defineProperty(this, property, { enumerable: false });
  }
  apply(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const result = { ...base };
    for (const [name, value] of Object.entries(this.values)) {
      validateEnvironmentName(name);
      if (base[name] !== undefined) throw new EnvironmentError("reserved");
      Object.defineProperty(result, name, { value, enumerable: true, configurable: true, writable: true });
    }
    return { ...result, ...this.git?.environment };
  }
  ready(): Promise<void> {
    return this.git?.ready ?? Promise.resolve();
  }
  bindGitThread(threadId: string) {
    this.git?.bindThread(threadId);
  }
  bindGitExecution(inputId: string, executionId: string) {
    this.git?.bindExecution(inputId, executionId);
  }
  overlay(): Record<string, string> {
    return { ...this.values, ...this.git?.environment };
  }
  redact(value: string): string {
    for (const secret of [
      ...new Set(
        Object.values({
          ...this.values,
          ...(this.git?.environment.OPENCRAFT_GIT_CAPABILITY
            ? { capability: this.git.environment.OPENCRAFT_GIT_CAPABILITY }
            : {}),
        }),
      ),
    ]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length))
      value = value.replaceAll(secret, "[REDACTED]");
    return value;
  }
  toJSON() {
    return { configured: Object.keys(this.values).length > 0 || !!this.git };
  }
  [Symbol.for("nodejs.util.inspect.custom")]() {
    return this.toJSON();
  }
}

export interface ExecutionGitPort {
  prepare(input: import("./git-execution.js").GitExecutionLocator): Promise<ExecutionEnvironmentSnapshot>;
}
