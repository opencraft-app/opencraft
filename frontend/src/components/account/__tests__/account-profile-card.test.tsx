import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { User } from "@/domain/types";
import i18n from "@/i18n";
import {
  AccountProfileCard,
  type AccountProfileCardProps,
} from "@/components/account/account-profile-card";

afterEach(cleanup);
beforeEach(async () => {
  await i18n.changeLanguage("zh-CN");
});

const user: User = {
  id: "usr_profile_card",
  name: "当前昵称",
  pendingName: "待审核昵称",
  nameAuditStatus: "pending",
  pendingAvatarUrl: "/pending-avatar.png",
  avatarAuditStatus: "pending",
  inviteRequired: false,
  createdAt: "2026-09-18T00:00:00Z",
};

const buildProps = (
  overrides: Partial<AccountProfileCardProps> = {},
): AccountProfileCardProps => ({
  user,
  displayAvatarSrc: "/display-avatar.png",
  hasPendingAvatarAudit: true,
  avatarAuditFailed: false,
  pendingName: "待审核昵称",
  hasPendingNameAudit: true,
  nameAuditFailed: false,
  copiedUserId: false,
  isEditingName: false,
  editName: "待审核昵称",
  saving: false,
  nameSaveError: null,
  avatarUploading: false,
  avatarUploadError: null,
  onAvatarUpload: vi.fn(),
  onEditNameChange: vi.fn(),
  onBeginNameEdit: vi.fn(),
  onCancelNameEdit: vi.fn(),
  onSaveName: vi.fn(),
  onCopyUserId: vi.fn(),
  onSignOut: vi.fn(),
  ...overrides,
});

describe("AccountProfileCard", () => {
  it("shows pending profile audit state and delegates profile actions", async () => {
    const onAvatarUpload = vi.fn();
    const onBeginNameEdit = vi.fn();
    const onCopyUserId = vi.fn();
    const onSignOut = vi.fn();
    const upload = new File(["avatar"], "avatar.png", { type: "image/png" });

    render(
      <AccountProfileCard
        {...buildProps({
          onAvatarUpload,
          onBeginNameEdit,
          onCopyUserId,
          onSignOut,
        })}
      />,
    );

    expect(screen.getAllByText("审核中")).toHaveLength(2);
    expect(screen.getByText("新头像已提交审核，审核通过后将对外生效。")).toBeVisible();
    expect(screen.getByText((_, element) => (
      element?.tagName === "P"
      && element.textContent === "当前对外显示：当前昵称，审核通过后将自动生效。"
    ))).toBeVisible();
    expect(screen.getByText("id: usr_profile_card")).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "修改待审核昵称" }));
    await userEvent.click(screen.getByRole("button", { name: "复制" }));
    await userEvent.click(screen.getByRole("button", { name: "退出登录" }));
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"]');
    expect(fileInput).not.toBeNull();
    await userEvent.upload(fileInput!, upload);

    expect(onBeginNameEdit).toHaveBeenCalledTimes(1);
    expect(onCopyUserId).toHaveBeenCalledTimes(1);
    expect(onSignOut).toHaveBeenCalledTimes(1);
    expect(onAvatarUpload).toHaveBeenCalledTimes(1);
  });

  it("delegates nickname editing and renders local errors", async () => {
    const onEditNameChange = vi.fn();
    const onSaveName = vi.fn();
    const onCancelNameEdit = vi.fn();

    render(
      <AccountProfileCard
        {...buildProps({
          isEditingName: true,
          hasPendingNameAudit: false,
          editName: "新昵称",
          nameSaveError: "昵称保存失败",
          avatarUploadError: "头像上传失败",
          onEditNameChange,
          onSaveName,
          onCancelNameEdit,
        })}
      />,
    );

    const nameInput = screen.getByRole("textbox", { name: "昵称" });
    await userEvent.clear(nameInput);
    await userEvent.type(nameInput, "更新昵称");
    await userEvent.click(screen.getByRole("button", { name: "保存" }));
    await userEvent.click(screen.getByRole("button", { name: "取消" }));

    expect(onEditNameChange).toHaveBeenCalled();
    expect(onSaveName).toHaveBeenCalledTimes(1);
    expect(onCancelNameEdit).toHaveBeenCalledTimes(1);
    expect(screen.getByText("昵称保存失败")).toHaveAttribute("role", "alert");
    expect(screen.getByText("头像上传失败")).toHaveAttribute("role", "alert");
  });

  it("announces copied ids and failed audits", () => {
    render(
      <AccountProfileCard
        {...buildProps({
          copiedUserId: true,
          hasPendingAvatarAudit: false,
          avatarAuditFailed: true,
          pendingName: "",
          hasPendingNameAudit: false,
          nameAuditFailed: true,
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "已复制" })).toHaveAttribute("title", "已复制");
    expect(screen.getByText("上次头像修改未通过审核，当前仍使用原头像。")).toBeVisible();
    expect(screen.getByText("上次昵称修改未通过审核，当前仍使用原昵称。")).toBeVisible();
  });
});
