import { ChatSurface, type ChatSurfaceProps } from "./surfaces/ChatSurface";

export type VelaChatWebProps = ChatSurfaceProps;

export function VelaChatWeb(props: VelaChatWebProps) {
  return <ChatSurface {...props} />;
}

export * from "./surfaces";
export * from "./composer-skills/model";
export * from "./session-list";
export * from "./session-location/sessionLocation";
export * from "./new-session";
export * from "./thumbnail";
