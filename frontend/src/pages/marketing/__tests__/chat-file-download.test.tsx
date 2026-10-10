import { createRef } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChatFileDownloadMenu } from "../chat-file-download-menu";
import { chatFilePathFromEvent } from "../chat-file-download";

const download = vi.fn(async () => undefined);
vi.mock("../chat-file-download", async (importOriginal) => {
  const original = await importOriginal<typeof import("../chat-file-download")>();
  return {
    ...original,
    ChatFileDownloader: class {
      download = download;
      dispose() {}
    },
  };
});

afterEach(() => {
  cleanup();
  download.mockClear();
});

describe("Chat file download", () => {
  it("only recognizes a managed file link from the composed Shadow DOM path", () => {
    const anchor = document.createElement("a");
    anchor.dataset.chatResourceKind = "file";
    anchor.href = "file:///home/agentuser/report.csv#L12";
    const event = { composedPath: () => [anchor] } as unknown as MouseEvent;
    expect(chatFilePathFromEvent(event)).toBe("/home/agentuser/report.csv");
    anchor.href = "file:///etc/passwd";
    expect(chatFilePathFromEvent(event)).toBeNull();
    anchor.href = "https://example.com/report.csv";
    expect(chatFilePathFromEvent(event)).toBeNull();
    anchor.dataset.chatResourceKind = "external";
    expect(chatFilePathFromEvent(event)).toBeNull();
  });

  it("opens Download on right-click inside the embedded Chat and sends the file path", () => {
    const mountRef = createRef<HTMLDivElement>();
    const { container } = render(<>
      <div ref={mountRef} />
      <ChatFileDownloadMenu botId="bot-1" active mountRef={mountRef} />
    </>);
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const anchor = document.createElement("a");
    anchor.dataset.chatResourceKind = "file";
    anchor.href = "file:///home/agentuser/output/report.csv";
    anchor.textContent = "report.csv";
    shadow.append(anchor);
    mountRef.current!.append(host);

    fireEvent.contextMenu(anchor);
    expect(screen.getByRole("menuitem", { name: "下载" })).toBeInTheDocument();
    fireEvent.pointerDown(screen.getByRole("menuitem", { name: "下载" }));
    expect(screen.getByRole("menuitem", { name: "下载" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "下载" }));
    expect(download).toHaveBeenCalledWith("/home/agentuser/output/report.csv");

    const webLink = document.createElement("a");
    webLink.dataset.chatResourceKind = "external";
    webLink.href = "https://example.com";
    shadow.append(webLink);
    fireEvent.contextMenu(webLink);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });

  it("opens file actions on a touch tap while keeping file preview available", () => {
    const mountRef = createRef<HTMLDivElement>();
    render(<>
      <div ref={mountRef} />
      <ChatFileDownloadMenu botId="bot-1" active mountRef={mountRef} />
    </>);
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const anchor = document.createElement("a");
    anchor.dataset.chatResourceKind = "file";
    anchor.href = "file:///home/agentuser/output/report.csv";
    anchor.textContent = "report.csv";
    const open = vi.fn((event: MouseEvent) => event.preventDefault());
    anchor.addEventListener("click", open);
    shadow.append(anchor);
    mountRef.current!.append(host);

    fireEvent.click(anchor);
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menuitem", { name: "下载" })).not.toBeInTheDocument();

    fireEvent.pointerDown(anchor, { pointerType: "touch", clientX: 30, clientY: 20 });
    fireEvent.click(anchor, { clientX: 30, clientY: 20 });
    expect(open).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("menuitem", { name: "查看" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "查看" }));
    expect(open).toHaveBeenCalledTimes(2);

    fireEvent.pointerDown(anchor, { pointerType: "touch", clientX: 30, clientY: 20 });
    fireEvent.click(anchor, { clientX: 30, clientY: 20 });
    fireEvent.click(screen.getByRole("menuitem", { name: "下载" }));
    expect(download).toHaveBeenCalledWith("/home/agentuser/output/report.csv");

    const webLink = document.createElement("a");
    webLink.dataset.chatResourceKind = "external";
    webLink.href = "https://example.com/report.csv";
    const openWebLink = vi.fn((event: MouseEvent) => event.preventDefault());
    webLink.addEventListener("click", openWebLink);
    shadow.append(webLink);
    fireEvent.pointerDown(webLink, { pointerType: "touch", clientX: 30, clientY: 20 });
    fireEvent.click(webLink, { clientX: 30, clientY: 20 });
    expect(openWebLink).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem", { name: "下载" })).not.toBeInTheDocument();
  });

  it("offers Download when tapping a plain path but ignores a cancelled touch", () => {
    const mountRef = createRef<HTMLDivElement>();
    render(<>
      <div ref={mountRef} />
      <ChatFileDownloadMenu botId="bot-1" active mountRef={mountRef} />
    </>);
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const message = document.createElement("div");
    message.className = "opencraft-chat-document";
    const path = document.createElement("strong");
    path.textContent = "/home/agentuser/output/report.csv";
    message.append(path);
    shadow.append(message);
    mountRef.current!.append(host);
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [{ left: 10, right: 260, top: 10, bottom: 35 }] as unknown as DOMRectList,
    });

    fireEvent.pointerDown(path, { pointerType: "touch", clientX: 30, clientY: 20 });
    fireEvent.pointerCancel(path);
    fireEvent.click(path, { clientX: 30, clientY: 20 });
    expect(screen.queryByRole("menuitem", { name: "下载" })).not.toBeInTheDocument();

    fireEvent.pointerDown(path, { pointerType: "touch", clientX: 30, clientY: 20 });
    fireEvent.click(path, { clientX: 30, clientY: 20 });
    expect(screen.queryByRole("menuitem", { name: "查看" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "下载" }));
    expect(download).toHaveBeenCalledWith("/home/agentuser/output/report.csv");
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  });

  it("recognizes a plain generated path in assistant text only under the pointer", () => {
    const mountRef = createRef<HTMLDivElement>();
    const { container } = render(<>
      <div ref={mountRef} />
      <ChatFileDownloadMenu botId="bot-1" active mountRef={mountRef} />
    </>);
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const message = document.createElement("div");
    message.className = "opencraft-chat-document";
    const paragraph = document.createElement("p");
    paragraph.append("路径在这里：");
    const strong = document.createElement("strong");
    const first = document.createElement("span");
    first.textContent = "/home/agentuser/国庆太白山";
    const second = document.createElement("span");
    second.textContent = "鳌太线徒步作文.md";
    strong.append(first, second);
    paragraph.append(strong, "，可以直接打开。");
    message.append(paragraph);
    shadow.append(message);
    mountRef.current!.append(host);
    const rect = { left: 10, right: 260, top: 10, bottom: 35 };
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [rect] as unknown as DOMRectList,
    });

    fireEvent.pointerMove(first, { clientX: 30, clientY: 20 });
    expect(screen.getByTestId("chat-file-hover-underline")).toHaveStyle({ borderBottomStyle: "dashed" });
    fireEvent.pointerMove(first, { clientX: 300, clientY: 20 });
    expect(screen.queryByTestId("chat-file-hover-underline")).not.toBeInTheDocument();

    fireEvent.contextMenu(first, { clientX: 30, clientY: 20 });
    expect(screen.getByRole("menuitem", { name: "下载" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: "下载" }));
    expect(download).toHaveBeenCalledWith("/home/agentuser/国庆太白山鳌太线徒步作文.md");

    fireEvent.contextMenu(first, { clientX: 300, clientY: 20 });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  });
});
