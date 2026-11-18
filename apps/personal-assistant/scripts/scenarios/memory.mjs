export async function memoryScenario({ say, call, check, wait, evidence }) {
  await say("记住我在上海", "remember");
  check(
    "explicitMemorySaved",
    (await call("memory.list")).some((m) => m.value.includes("上海")),
  );
  await say("记住我在深圳", "correct-memory");
  check(
    "explicitMemoryCorrected",
    (await call("memory.list")).some((m) => m.value.includes("深圳")),
  );
  await say("忘记城市", "forget-memory");
  check(
    "memoryForgotten",
    !(await call("memory.list")).some((m) => m.value.includes("深圳")),
  );

  const automatic = await say(
    "顺便说一下，我喜欢简短回答",
    "automatic-preference",
  );
  const learned = await wait(async () =>
    (await call("events")).find(
      (e) =>
        ["memory.learned", "memory.synthesized"].includes(e.kind) &&
        e.data.jobId === `learning:${automatic.id}` &&
        e.data.keys.length,
    ),
  );
  const entry = (await call("memory.list")).find((m) =>
    learned.data.keys.includes(m.key),
  );
  check("automaticPreferenceSaved", !!entry);
  const user = (await call("conversation")).messages.find(
    (m) => m.data.inputId === automatic.id && m.role === "user",
  );
  check("automaticPreferenceHasOriginalUserAnchor", !!user);
  evidence.automaticMemory = { entry, learned, user };
}
