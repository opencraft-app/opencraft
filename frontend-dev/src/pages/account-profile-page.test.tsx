import { MemoryRouter } from "react-router-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AccountProfilePage } from "@/pages/account-profile-page";

const mockUpdateProfile = vi.fn();
const mockUploadAvatar = vi.fn();
const mockDeleteAccount = vi.fn();
const mockGetCurrentSubscription = vi.fn();
const mockCompressAvatarFile = vi.fn();
const mockCreateObjectURL = vi.fn();
const mockRevokeObjectURL = vi.fn();

vi.mock("@/contexts/session-context", () => ({
  useSession: () => ({
    session: {
      user: {
        id: "usr_123",
        name: "旧昵称",
        email: "user@example.com",
        inviteRequired: false,
        createdAt: "2026-03-22T00:00:00Z",
        avatarUrl: "https://assets.example.com/avatar.jpg?sign=demo",
      },
    },
    updateProfile: mockUpdateProfile,
    uploadAvatar: mockUploadAvatar,
    deleteAccount: mockDeleteAccount,
  }),
}));

vi.mock("@/lib/avatar-image", () => ({
  compressAvatarFile: (...args: unknown[]) => mockCompressAvatarFile(...args),
}));

vi.mock("@/contexts/repository-context", () => ({
  useRepositories: () => ({
    plans: {
      getCurrentSubscription: mockGetCurrentSubscription,
    },
  }),
}));

describe("AccountProfilePage", () => {
  beforeEach(() => {
    mockUpdateProfile.mockReset();
    mockUploadAvatar.mockReset();
    mockDeleteAccount.mockReset();
    mockGetCurrentSubscription.mockReset();
    mockCompressAvatarFile.mockReset();
    mockCreateObjectURL.mockReset();
    mockRevokeObjectURL.mockReset();
    mockUpdateProfile.mockResolvedValue(undefined);
    mockUploadAvatar.mockResolvedValue(undefined);
    mockDeleteAccount.mockResolvedValue(undefined);
    mockGetCurrentSubscription.mockResolvedValue({
      tier: "plus",
      code: "lite",
      status: "active",
      currentPeriodStart: "2026-03-24T00:00:00Z",
      currentPeriodEnd: "2026-04-24T00:00:00Z",
    });
    mockCompressAvatarFile.mockImplementation(async (file: File) => file);
    mockCreateObjectURL.mockReturnValue("blob:avatar-preview");
    Object.defineProperty(globalThis.URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: mockCreateObjectURL,
    });
    Object.defineProperty(globalThis.URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: mockRevokeObjectURL,
    });
  });

  it("updates the profile nickname", async () => {
    const user = userEvent.setup();

    render(
      <MemoryRouter>
        <AccountProfilePage />
      </MemoryRouter>,
    );

    const input = screen.getByLabelText("昵称");
    await user.clear(input);
    await user.type(input, "新昵称");
    await user.click(screen.getByRole("button", { name: "保存资料" }));

    await waitFor(() => {
      expect(mockUpdateProfile).toHaveBeenCalledWith({ name: "新昵称" });
    });
  });

  it("compresses and uploads a selected avatar file", async () => {
    render(
      <MemoryRouter>
        <AccountProfilePage />
      </MemoryRouter>,
    );

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const input = screen.getByLabelText("上传头像");
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockCompressAvatarFile).toHaveBeenCalledWith(file, { maxBytes: 200 * 1024 });
    });
    await waitFor(() => {
      expect(mockUploadAvatar).toHaveBeenCalledWith(file);
    });
  });

  it("appends a cache-busting version to absolute avatar urls after upload", async () => {
    render(
      <MemoryRouter>
        <AccountProfilePage />
      </MemoryRouter>,
    );

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const input = screen.getByLabelText("上传头像");
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockUploadAvatar).toHaveBeenCalledWith(file);
    });

    await waitFor(() => {
      const images = screen.getAllByRole("img", { name: "旧昵称 的头像" });
      expect(
        images.some((image) => image.getAttribute("src") === "https://assets.example.com/avatar.jpg?sign=demo&v=1"),
      ).toBe(true);
    });
  });

  it("renders an absolute avatar url without rewriting it", () => {
    render(
      <MemoryRouter>
        <AccountProfilePage />
      </MemoryRouter>,
    );

    const images = screen.getAllByRole("img", { name: "旧昵称 的头像" });
    expect(images.some((image) => image.getAttribute("src") === "https://assets.example.com/avatar.jpg?sign=demo")).toBe(true);
  });

  it("renders the current subscription summary", async () => {
    render(
      <MemoryRouter>
        <AccountProfilePage />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Plus")).toBeInTheDocument();
    expect(screen.getAllByText("生效中").length).toBeGreaterThan(0);
  });

  it("rolls back the optimistic avatar preview when upload fails", async () => {
    mockUploadAvatar.mockRejectedValueOnce(new Error("头像上传失败。"));

    render(
      <MemoryRouter>
        <AccountProfilePage />
      </MemoryRouter>,
    );

    const file = new File(["avatar"], "avatar.png", { type: "image/png" });
    const input = screen.getByLabelText("上传头像");
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => {
      expect(mockUploadAvatar).toHaveBeenCalledWith(file);
    });
    await waitFor(() => {
      const images = screen.getAllByRole("img", { name: "旧昵称 的头像" });
      expect(images.some((image) => image.getAttribute("src") === "https://assets.example.com/avatar.jpg?sign=demo")).toBe(true);
    });
    expect(mockRevokeObjectURL).toHaveBeenCalledWith("blob:avatar-preview");
  });

  it("does not expose self-delete action", () => {
    render(
      <MemoryRouter>
        <AccountProfilePage />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "注销账号" })).not.toBeInTheDocument();
  });
});
