import type {Agent, Computer, Member, Reminder, Task} from "@vela/client-core";

import {
  agentListItemViewModel,
  agentRuntimeStateLabel,
  agentRuntimeStateTone,
} from "./agent";
import {
  computerConnectionTone,
  computerListItemViewModel,
} from "./computer";
import {terminalStatusLabel} from "./terminal";
import {reminderListItemViewModel, taskListItemViewModel} from "./task";
import {memberListItemViewModel} from "./member";

const agent = {
  displayName: "研究助手",
  handle: "research",
  id: "agent-1",
  observedState: "running",
  runtime: {kind: "codex"},
} as Agent;

const computer = {
  connectionState: "online",
  id: "computer-1",
  lifecycleState: "active",
  name: "Mac Studio",
  osType: "macos",
} as Computer;

describe("resource presentation view models", () => {
  it("derives one Agent identity for collection and detail renderers", () => {
    expect(agentRuntimeStateLabel(agent)).toBe("运行中");
    expect(agentRuntimeStateTone(agent)).toBe("positive");
    expect(agentListItemViewModel(agent, true)).toMatchObject({
      accessibilityLabel: "打开 Agent research",
      meta: "@research · 运行中",
      selected: true,
      status: "运行中",
      title: "研究助手",
      tone: "positive",
    });
  });

  it("derives one Computer identity for every collection shape", () => {
    expect(computerConnectionTone("online")).toBe("positive");
    expect(computerListItemViewModel(computer, false)).toMatchObject({
      meta: "macos · 在线",
      selected: false,
      status: "在线",
      title: "Mac Studio",
      tone: "positive",
    });
  });

  it("shares terminal state wording across native and web renderers", () => {
    expect(terminalStatusLabel).toEqual({
      closed: "终端已关闭",
      connecting: "正在连接终端…",
      error: "终端连接异常",
      ready: "终端已连接",
    });
  });

  it("derives task and reminder collection copy once", () => {
    const task = {
      description: "补齐发布说明",
      id: "task-1",
      number: 42,
      status: "in_review",
      title: "发布桌面端",
    } as Task;
    const reminder = {
      agentId: agent.id,
      id: "reminder-1",
      status: "active",
      text: "检查发布状态",
    } as Reminder;

    expect(taskListItemViewModel(task, true)).toMatchObject({
      accessibilityLabel: "打开任务 42",
      meta: "#42",
      selected: true,
      status: "待验收",
      title: "发布桌面端",
    });
    expect(reminderListItemViewModel(reminder, agent, false)).toMatchObject({
      accessibilityLabel: "打开提醒 检查发布状态",
      meta: "研究助手",
      selected: false,
      status: "生效中",
      subtitle: "生效中 · 研究助手",
    });
  });

  it("derives member identity copy for all collection renderers", () => {
    const member = {
      displayName: "阿岚",
      handle: "alan",
      id: "member-1",
      imState: "ready",
      kind: "human",
      revision: 1,
      role: "admin",
      serverId: "server-1",
      status: "active",
    } as Member;

    expect(memberListItemViewModel(member, true)).toMatchObject({
      accessibilityLabel: "打开成员 阿岚 @alan",
      identityLabel: "@alan",
      meta: "@alan · 自然人 · 管理员",
      selected: true,
      status: "正常",
      subtitle: "自然人 · 管理员",
      title: "阿岚",
    });
  });
});
