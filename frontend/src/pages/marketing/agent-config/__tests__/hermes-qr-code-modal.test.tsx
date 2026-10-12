import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesQrCodeModal, type IHermesQrCodeModalHandle } from "@/pages/marketing/agent-config/components/HermesQrCodeModal";
import { createAgentScriptCommands } from "@/pages/marketing/agent-config/hermes-command-builder";
import type { ICommandExecutor } from "@/pages/marketing/agent-config/local-command-executor";

vi.mock("@/i18n/t", () => ({ t: (message: string) => message }));
vi.mock("qrcode.react", () => ({ QRCodeCanvas: () => <div data-testid="qr-code" /> }));

afterEach(cleanup);

async function openQrCode(channel: string) {
  const ref = React.createRef<IHermesQrCodeModalHandle>();
  const executor: ICommandExecutor = {
    run: vi.fn(async () => ({ success: true, output: "" })),
    runWithProgress: vi.fn(async ({ onProgress }) => {
      onProgress?.(JSON.stringify({ platform: channel, status: "pending", url: "https://example.test/qr" }));
      return { success: true, output: "" };
    }),
  };
  render(<HermesQrCodeModal
    ref={ref}
    channel={channel}
    executor={executor}
    scriptCommands={createAgentScriptCommands("secondary")}
    instance={{ InstanceId: "instance-test", RegionId: 1 }}
  />);
  await act(async () => { await ref.current?.startQrCodeFlow(); });
}

describe("Weixin QR guidance", () => {
  it("shows the distinct-account reminder while the QR code is ready to scan", async () => {
    await openQrCode("weixin");
    expect(screen.getByTestId("qr-code")).toBeInTheDocument();
    expect(screen.getByText("请使用未连接其他 Bot 的微信账号扫码，并在微信上确认授权。")).toBeInTheDocument();
  });

  it("does not show Weixin account guidance for Feishu", async () => {
    await openQrCode("feishu");
    expect(screen.getByTestId("qr-code")).toBeInTheDocument();
    expect(screen.queryByText("请使用未连接其他 Bot 的微信账号扫码，并在微信上确认授权。")).not.toBeInTheDocument();
  });
});


describe("Weixin binding confirmation", () => {
  for (const conflict of [false, true]) {
    it(conflict ? "does not report success when CTL rejects the account" : "waits for CTL confirmation before reporting success", async () => {
      const ref = React.createRef<IHermesQrCodeModalHandle>();
      const onSuccess = vi.fn();
      let resolve!: (result: { success: boolean; output: string }) => void;
      let reject!: (error: Error) => void;
      const confirmation = new Promise<{ success: boolean; output: string }>((yes, no) => { resolve = yes; reject = no; });
      const executor: ICommandExecutor = {
        run: vi.fn(async () => ({ success: true, output: "" })),
        runWithProgress: vi.fn(({ onProgress }) => {
          onProgress?.(JSON.stringify({ platform: "weixin", status: "pending", url: "https://example.test/qr" }));
          onProgress?.(JSON.stringify({ platform: "weixin", status: "success" }));
          return confirmation;
        }),
      };
      render(<HermesQrCodeModal ref={ref} channel="weixin" executor={executor} onSuccess={onSuccess}
        scriptCommands={createAgentScriptCommands("secondary")} instance={{ InstanceId: "instance-test", RegionId: 1 }} />);
      let flow: Promise<void> | undefined;
      await act(async () => { flow = ref.current?.startQrCodeFlow(); });
      expect(onSuccess).not.toHaveBeenCalled();
      expect(screen.getByTestId("qr-code")).toBeInTheDocument();
      await act(async () => {
        if (conflict) reject(Object.assign(new Error("conflict"), { code: "WEIXIN_ACCOUNT_OCCUPIED", occupiedByBot: { botId: "bot-a", botName: "工作助手" } }));
        else resolve({ success: true, output: "" });
        await flow;
      });
      expect(onSuccess).toHaveBeenCalledTimes(conflict ? 0 : 1);
      expect(screen.queryByTestId("qr-code")).not.toBeInTheDocument();
    });
  }
});
