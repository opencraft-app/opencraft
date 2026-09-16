import { createRef } from "react";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesQrCodeModal, type IHermesQrCodeModalHandle, type IHermesQrCodeModalProps } from "../HermesQrCodeModal";
vi.mock("@/i18n/t", () => ({ t: (text: string) => text }));
vi.mock("../../hooks/useWecomAIBotSDK", () => ({ useWecomAIBotSDK: () => ({ openAuth: vi.fn() }) }));
vi.mock("../../utils/message", () => ({ message: { success: vi.fn(), error: vi.fn() } }));
vi.mock("qrcode.react", () => ({ QRCodeCanvas: () => <canvas /> }));
afterEach(cleanup);
describe("Hermes QR dialog", () => {
  it("closes with Escape, restores the caller, and does not cancel the existing remote stream", async () => {
    const ref = createRef<IHermesQrCodeModalHandle>();
    const returnFocusRef = createRef<HTMLButtonElement>();
    let progress: (decoded: string) => void = () => undefined;
    const runWithProgress = vi.fn((options: { onProgress: (decoded: string) => void }) => {
      progress = options.onProgress;
      return new Promise(() => undefined);
    });
    const onSuccess = vi.fn();
    const getQrUrlCommand = vi.fn(() => "qr-command");
    render(<>
      <button ref={returnFocusRef} onClick={() => void ref.current?.startQrCodeFlow()}>Connect</button>
      <HermesQrCodeModal ref={ref} channel="dingtalk" isI18n
        scriptCommands={{ hermes: { channel: { getQrUrlCommand } } } as unknown as IHermesQrCodeModalProps["scriptCommands"]}
        executor={{ runWithProgress } as unknown as IHermesQrCodeModalProps["executor"]}
        instance={{ InstanceId: "instance-1" } as IHermesQrCodeModalProps["instance"]} onSuccess={onSuccess} />
    </>);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Connect" }));
    expect(screen.getByRole("dialog", { name: "正在生成二维码..." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭" })).toHaveFocus();
    expect(getQrUrlCommand).toHaveBeenCalledWith({ platform: "dingtalk", isI18n: true, bindId: undefined, ip: undefined });
    expect(runWithProgress).toHaveBeenCalledWith(expect.objectContaining({ command: "qr-command", timeout: 180, maxRetries: 180 }));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Connect" })).toHaveFocus();
    // Existing semantics: closing the client dialog does not invalidate the remote flow.
    act(() => progress(JSON.stringify({ platform: "dingtalk", status: "success" })));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(runWithProgress).toHaveBeenCalledTimes(1);
  });
});
