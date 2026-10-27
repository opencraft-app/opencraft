import type { SkillsListParams, SkillsListResponse } from "./generated/v2";

/** Negotiated Host routing; native skills/list retains its upstream wire shape. */
export const SCOPED_SKILL_CATALOG_EXTENSION = "opencraft/scoped-skill-catalog";
export const SCOPED_SKILL_CATALOG_METHOD = "opencraft/skills/list";
export interface ScopedSkillsListParams extends SkillsListParams {
  /** Existing conversations use their immutable engine owner. */
  readonly threadId?: string;
  /** New drafts use the selected model, or the Host default when absent. */
  readonly model?: string;
}
export interface SkillCatalogMethodMap {
  "opencraft/skills/list": { params: ScopedSkillsListParams; result: SkillsListResponse };
}
