/** Exact input-associated native Turn evidence, not semantic task success.
 * An unbound input has turnId=null; every terminal Turn identity is nonempty. */
export interface InputCompletion {
  readonly version: 1;
  readonly turnId: string | null;
  readonly status: "completed" | "failed" | "interrupted" | "unknown";
  readonly text: string;
  readonly truncated?: boolean;
  /** Old Host projection missing, or exact native history outside the read bound. */
  readonly unavailable?: true;
}

export function parseInputCompletion(value: unknown, turnId: string | null): InputCompletion | undefined;
