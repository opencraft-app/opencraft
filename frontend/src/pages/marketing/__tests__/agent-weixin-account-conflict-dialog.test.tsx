import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AgentWeixinAccountConflictDialog } from "@/pages/marketing/agent-weixin-account-conflict-dialog";

vi.mock("@/i18n/t", () => ({ t: (text: string, args?: { name: string }) => text.replace("{{name}}", args?.name ?? "") }));
afterEach(cleanup);
it("shows the real owning Bot and offers navigation and dismissal", () => {
  const onClose = vi.fn();
  const onVisit = vi.fn();
  render(<AgentWeixinAccountConflictDialog owner={{ botId: "profile-work", botName: "工作助手" }} onClose={onClose} onVisit={onVisit} />);
  expect(screen.getByRole("dialog", { name: "该微信已连接其他 Bot" })).toBeInTheDocument();
  expect(screen.getByText("该微信已连接「工作助手」。", { exact: false })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "前往该 Bot" }));
  expect(onVisit).toHaveBeenCalledWith("profile-work");
  fireEvent.click(screen.getByText("关闭"));
  expect(onClose).toHaveBeenCalled();
});
