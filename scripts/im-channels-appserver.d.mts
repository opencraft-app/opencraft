import type {
  DuplexTransport,
  TransportSubmissionContext,
  TransportStatus,
} from "@opencraft/appserver-client/transport";
import type { Collaboration } from "../packages/access-control/src/collaboration.js";
export class ImChannelsAppServer implements DuplexTransport {
  constructor(getNative: () => Collaboration | null | undefined);
  readonly status: TransportStatus;
  connect(signal?: AbortSignal): Promise<void>;
  send(frame: string, signal?: AbortSignal): Promise<void>;
  sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal): Promise<void>;
  subscribeMessage(listener: (frame: string) => void): () => void;
  subscribeStatus(listener: (status: TransportStatus) => void): () => void;
  close(): Promise<void>;
}
