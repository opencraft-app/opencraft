import type { HumanImSession } from "@lightvela/vela-chat-client-core";

export interface HumanImSessionClient {
  createHumanImSession(): Promise<HumanImSession>;
}

export interface MessagingLifecyclePort {
  connect(session: HumanImSession): Promise<void>;
  close(): Promise<void>;
}

export class CollaborationMessagingService {
  private connectOperation: Promise<void> | null = null;
  private closeOperation: Promise<void> | null = null;
  private disposed = false;

  constructor(
    private readonly sessions: HumanImSessionClient,
    private readonly messaging: MessagingLifecyclePort,
  ) {}

  connect(): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error("Collaboration messaging service is disposed"));
    }
    if (this.connectOperation !== null) return this.connectOperation;
    const operation = (async () => {
      const session = await this.sessions.createHumanImSession();
      if (this.disposed) return;
      await this.messaging.connect(session);
      if (this.disposed) await this.close();
    })();
    this.connectOperation = operation;
    return operation;
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.closeOperation;
      return;
    }
    this.disposed = true;
    await this.connectOperation?.catch(() => undefined);
    await this.close();
  }

  private close(): Promise<void> {
    if (this.closeOperation === null) {
      this.closeOperation = this.messaging.close();
    }
    return this.closeOperation;
  }
}
