export async function skillsScenario({ call, say, done, check, evidence }) {
  const installed = await call(
    "skill.install",
    {
      pluginId: "acceptance",
      skills: [
        {
          id: "weekly-review",
          summary: "整理项目周进展，区分已确认事实和待跟进项，保留来源。",
          body: "读取 project.md，将已确认进展和待跟进项分开，引用实际资料路径。不得将下周计划说成已完成。发布笔记并报告产物。此方法不增加任何权限。",
        },
      ],
    },
    "install",
  );
  const skillId = "acceptance/weekly-review";
  await call("skill.enable", { skillId, enabled: true }, "enable");
  const work = await say(
    "整理 project.md 的本周进展，请先加载并使用周进展技能 [skill:acceptance/weekly-review]，引用资料来源并发布笔记。",
    "review",
  );
  check("skillWorkCreated", !!work.work_id);
  const result = await done(work.work_id);
  check(
    "pinnedSkillActuallyLoaded",
    result.skills.some((s) => s.skill_id === skillId && s.version === installed.installed[0].version),
  );
  check(
    "skillWorkHasSourceEvidence",
    result.completion.executions.some((e) => e.evidence.some((r) => r.kind === "material.read")),
  );
  evidence.skillReview = {
    workId: work.work_id,
    installed,
    loads: result.skills,
    limitation: "Explicit skill request; autonomous relevant-skill selection and usefulness require separate review.",
  };
}
