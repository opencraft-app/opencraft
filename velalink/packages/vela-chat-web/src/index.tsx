import { ChatSurface, type ChatSurfaceProps } from "./surfaces/ChatSurface";

export type VelaChatWebProps = ChatSurfaceProps;

export function VelaChatWeb(props: VelaChatWebProps) {
  return <ChatSurface {...props} />;
}

export * from "./surfaces";
