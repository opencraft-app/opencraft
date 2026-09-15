import type {
  AppServerConnection,
  JsonRpcRequest,
} from "./appserver.ts";

export interface TransparentThreadSettingsProvider {
  id?: string | null;
  providerId?: string | null;
}

export interface TransparentThreadSettingsRequest {
  connection: AppServerConnection;
  threadId: string;
  message: JsonRpcRequest;
  provider: TransparentThreadSettingsProvider | null;
}

export interface TransparentThreadSettingsPort {
  update(request: TransparentThreadSettingsRequest): void;
}
