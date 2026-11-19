import { setTimeout as delay } from "node:timers/promises";

/** Deterministic protocol branches only; no claim of language understanding. */
export async function fixtureReception(catalog, input, signal) {
  await delay(Math.min(catalog.profile.config.fixtureDelayMs, 250), undefined, {
    signal,
  });
  if (input.source?.kind === "execution-report") {
    if (input.report.status === "returned" && input.report.assessment.passed) return { kind: "deliver" };
    return input.source.waitingForResult
      ? {
          kind: "blocked",
          text: "执行结果尚未满足完成条件，请查看工作详情并补充或修改目标。",
        }
      : { kind: "silent" };
  }
  const routine = input.text.match(/^每隔(\d+)秒提醒我[：:\s]*(.+)$/);
  if (routine)
    return {
      kind: "routine.create",
      params: {
        text: routine[2],
        startAt: input.clock.now + Number(routine[1]) * 1000,
        intervalMs: Number(routine[1]) * 1000,
        notify: "always",
      },
    };
  const text = input.text.trim(),
    active = input.works.filter((w) => !["completed", "cancelled"].includes(w.status));
  const mentioned = input.works.filter((w) => text.includes(w.id));
  let target =
    input.targetWork ??
    (mentioned.length === 1
      ? mentioned[0]
      : active.length === 1 && !input.workOverview?.attentionTruncated
        ? active[0]
        : null);
  if (input.targetWork?.changedSinceIntake) return { kind: "clarify", text: "工作已更新，请按当前版本重新提交跟进。" };
  const observation = (name, predicate = () => true) =>
    input.observations?.findLast((o) => o.query.name === name && predicate(o.query.params))?.response;
  const query = (name, params) => ({ kind: "query", name, params });
  const queryReply = (response, text) =>
    response.ok
      ? { kind: "reply", text }
      : {
          kind: "reply",
          text: "【确定性测试接待】查询未成功：" + response.error,
        };
  if (/^(资料有哪些|有哪些资料|列出资料)$/.test(text)) {
    const source = input.capabilities.resources[0];
    if (!source) return { kind: "reply", text: "当前消息没有已绑定的可读资料源。" };
    const response = observation("materials.list");
    if (!response) return query("materials.list", { source, directory: "", limit: 6 });
    return queryReply(
      response,
      response.ok
        ? "【确定性测试接待】资料：" +
            response.data.items.map((f) => f.path).join("、") +
            (response.data.next ? "；还有下一页。" : "")
        : "",
    );
  }
  const requestedFile = text.match(/^查看资料[：:\s]+(.+)$/);
  if (requestedFile) {
    const source = input.capabilities.resources[0];
    if (!source) return { kind: "reply", text: "当前消息没有已绑定的可读资料源。" };
    const response = observation("material.read");
    if (!response) return query("material.read", { source, path: requestedFile[1] });
    return queryReply(
      response,
      response.ok
        ? `【确定性测试接待】${response.data.path}\nSHA256：${response.data.sha256}\n${response.data.text}${response.data.nextOffset !== null ? "\n（后文未读取）" : ""}`
        : "",
    );
  }
  const requestedWork = text.match(/^查看工作[：:\s]+(\S+)$/);
  if (requestedWork) {
    const response = observation("work.get");
    if (!response) return query("work.get", { workId: requestedWork[1] });
    return queryReply(
      response,
      response.ok
        ? `【确定性测试接待】${response.data.work.id}：${response.data.work.status}（版本 ${response.data.work.revision}）；条件检查：${response.data.completion.passed}；内容质量：${response.data.completion.semanticReview}`
        : "",
    );
  }
  if (text === "待回答的问题") {
    const response = observation("questions.list");
    if (!response) return query("questions.list", { limit: 6 });
    return queryReply(
      response,
      response.ok
        ? "【确定性测试接待】" +
            (response.data.items.map((q) => `${q.id}：${q.question}`).join("\n") || "当前没有关联的待答问题。") +
            (response.data.next ? "\n（还有下一页待答问题。）" : "")
        : "",
    );
  }
  if (/^(你好|hello|hi\b)/i.test(text))
    return {
      kind: "reply",
      text: "【确定性测试接待】你好。可以交代一项本地资料整理工作，也可以查询进度。",
    };
  if (/^(进度|查进度|怎么样|status)/i.test(text)) {
    const response = observation("works.list");
    if (!response) return query("works.list", { limit: 6 });
    return queryReply(
      response,
      response.ok
        ? "【确定性测试接待，查询时状态】" +
            (response.data.items.map((w) => `${w.id}：${w.status}（版本 ${w.revision}）`).join("\n") ||
              "当前没有工作。") +
            (response.data.next ? "\n（还有未列出的工作，请指定 ID 查询。）" : "")
        : "",
    );
  }
  if (/^(取消|停止|cancel|改成|改为|修改|amend)/i.test(text)) {
    const named = text.match(/\bw_[a-f0-9]{24}\b/)?.[0];
    if (named) {
      const response = observation("work.get", (p) => p.workId === named);
      if (!response) return query("work.get", { workId: named });
      if (!response.ok) return queryReply(response, "");
      target = response.data.work;
    } else if (!input.targetWork && input.workOverview?.attentionTruncated)
      return {
        kind: "clarify",
        text: "工作列表尚未全部读取，请提供要修改或停止的工作 ID。",
      };
  }
  if (/^(取消|停止|cancel)/i.test(text))
    return target
      ? {
          kind: "cancel",
          workId: target.id,
          expectedRevision: target.revision,
        }
      : { kind: "clarify", text: "要停止哪一项工作？请给出工作 ID。" };
  if (/^(改成|改为|修改|amend)/i.test(text))
    return target
      ? {
          kind: "amend",
          completion: { output: "note", requirements: [], checks: [] },
          workId: target.id,
          expectedRevision: target.revision,
          goal: text.replace(/^(改成|改为|修改|amend)[:：\s]*/i, ""),
        }
      : { kind: "clarify", text: "要修改哪一项工作？请给出工作 ID。" };
  const city = text.match(/^记住[：:\s]*我在(.+)$/),
    forgetCity = /^忘记[：:\s]*(城市|city)$/.test(text);
  if (city || forgetCity) {
    const response = observation("memory.get", (p) => p.key === "city");
    if (!response) return query("memory.get", { key: "city" });
    if (!response.ok) return queryReply(response, "");
    if (city)
      return {
        kind: "remember",
        key: response.data.key,
        value: city[1],
        expectedRevision: response.data.revision,
      };
    return response.data.exists && !response.data.deleted
      ? {
          kind: "forget",
          key: response.data.key,
          expectedRevision: response.data.revision,
        }
      : { kind: "reply", text: "没有保存城市偏好。" };
  }
  const questions = input.pendingInteractions ?? [];
  const question = questions.find((q) => text.includes(q.id)) ?? (questions.length === 1 ? questions[0] : null);
  if (question && question.kind !== "question" && !/^(不回答|拒绝)/.test(text) && /^(回答|只|本周)/.test(text))
    return {
      kind: "reply",
      text: `这项等待类型为 ${question.kind}，请使用专用命令完成：${question.id}；不要在聊天中提供秘密。`,
    };
  if (question && /^(回答|只|本周|不回答|拒绝)/.test(text))
    return {
      kind: /^(不回答|拒绝)/.test(text) ? "reject" : "answer",
      interactionId: question.id,
      expectedRevision: question.revision,
      text: text.replace(/^回答[：:\s]*/, ""),
    };
  if (questions.length > 1 && /^回答/.test(text)) return { kind: "clarify", text: "有多项待补充信息，请指出问题 ID。" };
  if (/^(整理|总结|帮我|请|summari[sz]e|read)/i.test(text)) return { kind: "delegate", goal: text };
  return {
    kind: "clarify",
    text: "【确定性测试接待】请用“整理……”交代工作；这个 fixture 只演示固定分支。",
  };
}
