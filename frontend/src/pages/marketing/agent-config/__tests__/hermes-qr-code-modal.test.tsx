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
