/** Single source for management empty-state title/description pairs. */

export const agentEmptyCopy = {
  description: "创建后部署并启动，即可在 Channel 里 @ 它",
  title: "还没有 Agent",
} as const;

export const computerEmptyCopy = {
  description: "纳管一台可出网机器，再把 Agent 绑定到它。",
  title: "还没有 Computer",
} as const;

export const computerNotFoundCopy = {
  description: "这条链接可能已经失效，或者你没有访问权限。",
  title: "找不到这台 Computer",
} as const;

export const memberEmptyCopy = {
  description: "通过邀请把 Human 或 Agent 加入当前 Server。",
  title: "还没有成员",
} as const;

export const taskEmptyCopy = {
  description: "创建第一项工作，或从 Agent 对话生成 Task。",
  title: "还没有任务",
} as const;

export const reminderEmptyCopy = {
  description: "为 Agent 安排一次或周期工作。",
  title: "还没有提醒",
} as const;
