/**
 * @novnc/novnc 类型 shim（最小 API 面）。
 *
 * noVNC 1.5.0 npm 包不带 TS 声明；本文件只声明云桌面面板
 * （agent-cloud-desktop-panel.tsx）实际用到的 RFB API：
 * 构造、凭证、viewport 缩放、connect/disconnect 事件、断开。
 * 事件负载参照 noVNC 官方文档（disconnect 为 CustomEvent<{clean}>）。
 */

declare module "@novnc/novnc/lib/rfb" {
  export interface RFBCredentials {
    password?: string;
    username?: string;
    target?: string;
  }

  export interface RFBOptions {
    shared?: boolean;
    credentials?: RFBCredentials;
   reconnect?: boolean;
    resizeSession?: boolean;
    scaleViewport?: boolean;
  }

  export class RFB {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions);

    sendCredentials(credentials: RFBCredentials): void;
    disconnect(): void;
    sendCtrlAltDel(): void;
    focus(): void;
    blur(): void;
    clipboardPasteFrom(text: string): void;

    scaleViewport: boolean;
    resizeSession: boolean;
    viewOnly: boolean;
    touchKeyboard: unknown;

    addEventListener(type: "connect", listener: () => void): void;
    addEventListener(type: "disconnect", listener: (event: CustomEvent<{ clean: boolean }>) => void): void;
    addEventListener(type: "credentialsrequired", listener: (event: CustomEvent<void>) => void): void;
    addEventListener(type: "securityfailure", listener: (event: CustomEvent<{ status: number; reason: string }>) => void): void;
    addEventListener(type: "clipboard", listener: (event: CustomEvent<{ text: string }>) => void): void;
    addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
  }

  export default RFB;
}
