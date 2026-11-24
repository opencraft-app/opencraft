export interface Rule {
  engine: string;
  model?: string;
  effort?: string;
}
export const POLICY_PATH: string;
export const engines: string[];
export function parseRules(value: unknown): Rule[];
