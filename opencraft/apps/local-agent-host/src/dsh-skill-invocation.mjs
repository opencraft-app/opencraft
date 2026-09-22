import { isAbsolute, resolve } from "node:path";

/** Resolve only registry-owned files; an input path never authorizes a file read. */
export async function validateSkillInvocations(ctx, catalog, { sessionId, skills }) {
  if (typeof sessionId !== "string" || !Array.isArray(skills) || skills.length === 0) throw new Error("Explicit Skill invocation requires a session and references");
  const agent = ctx.agents.get(sessionId);
  if (!agent) throw new Error("Skill invocation requires an active session");
  if (!ctx.tools.get("skill", agent)) throw new Error("This Agent preset does not expose the native Skill loader");
  catalog.prepare(agent);
  catalog.invalidate();
  const lookup = { scope: agent, cwd: agent.session.header.cwd };
  for (const ref of skills) {
    if (!ref || typeof ref.name !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(ref.name)
      || typeof ref.path !== "string" || !isAbsolute(ref.path)) throw new Error("Invalid explicit Skill reference");
    const skill = await ctx.skills.get(ref.name, lookup);
    if (!skill?.invocation.userInvocable) throw new Error(`Skill is unavailable for user invocation: ${ref.name}`);
    if (!skill.path || !isAbsolute(skill.path) || resolve(skill.path) !== resolve(ref.path)) throw new Error(`Skill path changed or does not match this session: ${ref.name}`);
  }
}
