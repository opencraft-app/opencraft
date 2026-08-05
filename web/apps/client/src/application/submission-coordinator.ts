import {
  MessagingSendError,
  type ComposerSubmission,
  type ComposerSubmissionPart,
  type Message,
  type MessagingPort,
} from "@vela/client-core";

interface SubmissionCoordinatorOptions {
  messaging: Pick<
    MessagingPort,
    "reconcileMessage" | "retryMessage" | "sendAttachment" | "sendText"
  >;
  onChange?(submission: ComposerSubmission): void;
}

export class SubmissionCoordinator {
  private readonly messaging: SubmissionCoordinatorOptions["messaging"];
  private readonly onChange: (submission: ComposerSubmission) => void;
  private readonly queues = new Map<string, string[]>();
  private readonly records = new Map<string, ComposerSubmission>();
  private readonly workers = new Map<string, Promise<void>>();

  public constructor(options: SubmissionCoordinatorOptions) {
    this.messaging = options.messaging;
    this.onChange = options.onChange ?? (() => undefined);
  }

  public enqueue(submission: ComposerSubmission): void {
    if (this.records.has(submission.id)) {
      throw new Error(`Submission ${submission.id} already exists`);
    }
    const snapshot = cloneSubmission(submission);
    this.records.set(snapshot.id, snapshot);
    const queue = this.queues.get(snapshot.conversationKey) ?? [];
    queue.push(snapshot.id);
    this.queues.set(snapshot.conversationKey, queue);
    this.publish(snapshot);
    this.start(snapshot.conversationKey);
  }

  public get(submissionId: string): ComposerSubmission | undefined {
    const submission = this.records.get(submissionId);
    return submission ? cloneSubmission(submission) : undefined;
  }

  public canRetry(submissionId: string): boolean {
    const submission = this.records.get(submissionId);
    return Boolean(
      submission?.parts.some(
        (part) => part.status === "failed" && part.retryable === true,
      ),
    );
  }

  public cancel(submissionId: string): void {
    const submission = this.records.get(submissionId);
    if (!submission || submission.phase === "committed" || submission.phase === "cancelled") {
      return;
    }
    submission.phase = "cancelled";
    submission.parts = submission.parts.map((part) =>
      part.status === "sent"
        ? part
        : {...part, status: "cancelled" as const},
    );
    this.publish(submission);
    this.start(submission.conversationKey);
  }

  public async retry(submissionId: string): Promise<void> {
    let submission = this.records.get(submissionId);
    if (!submission || submission.phase !== "blocked") return;
    await this.whenIdle(submission.conversationKey);
    submission = this.records.get(submissionId);
    if (!submission || submission.phase !== "blocked") return;
    const index = submission.parts.findIndex(
      (part) => part.status === "failed" && part.retryable === true,
    );
    if (index < 0) return;
    const part = submission.parts[index] as ComposerSubmissionPart;
    const {error: _error, retryable: _retryable, ...retryingPart} = part;
    submission.parts[index] = {...retryingPart, status: "sending"};
    submission.phase = "sending";
    this.publish(submission);
    try {
      const sent = await this.messaging.retryMessage(part.clientRequestId);
      submission.parts[index] = sentPart(part, sent);
      submission.phase = "queued";
      this.publish(submission);
      this.start(submission.conversationKey);
      await this.whenIdle(submission.conversationKey);
    } catch (error) {
      await this.handleFailure(submission, index, error);
    }
  }

  public async whenIdle(conversationKey: string): Promise<void> {
    while (this.workers.has(conversationKey)) {
      await this.workers.get(conversationKey);
    }
  }

  private start(conversationKey: string): void {
    if (this.workers.has(conversationKey)) return;
    const worker = this.drain(conversationKey).finally(() => {
      this.workers.delete(conversationKey);
      const next = this.current(conversationKey);
      if (next && next.phase !== "blocked") this.start(conversationKey);
    });
    this.workers.set(conversationKey, worker);
  }

  private async drain(conversationKey: string): Promise<void> {
    while (true) {
      const submission = this.current(conversationKey);
      if (!submission) return;
      if (submission.phase === "cancelled" || submission.phase === "committed") {
        this.shift(conversationKey);
        continue;
      }
      if (submission.phase === "blocked") return;
      await this.deliver(submission);
    }
  }

  private async deliver(submission: ComposerSubmission): Promise<void> {
    submission.phase = "sending";
    this.publish(submission);
    for (let index = 0; index < submission.parts.length; index += 1) {
      const part = submission.parts[index] as ComposerSubmissionPart;
      if (part.status === "sent" || part.status === "cancelled") continue;
      submission.parts[index] = {...part, status: "sending"};
      this.publish(submission);
      try {
        const sent = await this.sendPart(submission, part);
        submission.parts[index] = sentPart(part, sent);
        this.publish(submission);
      } catch (error) {
        await this.handleFailure(submission, index, error);
        return;
      }
    }
    submission.phase = "committed";
    this.publish(submission);
  }

  private sendPart(
    submission: ComposerSubmission,
    part: ComposerSubmissionPart,
  ): Promise<Message> {
    if (part.role === "attachment") {
      return this.messaging.sendAttachment({
        channel: submission.channel,
        clientRequestId: part.clientRequestId,
        kind: part.attachment.kind,
        ...(part.quote ? {quote: part.quote} : {}),
        source: part.attachment.source,
        submission: part.submission,
      });
    }
    return this.messaging.sendText({
      channel: submission.channel,
      clientRequestId: part.clientRequestId,
      mentions: part.mentions,
      ...(part.quote ? {quote: part.quote} : {}),
      submission: part.submission,
      text: part.text,
    });
  }

  private async handleFailure(
    submission: ComposerSubmission,
    index: number,
    error: unknown,
  ): Promise<void> {
    const part = submission.parts[index] as ComposerSubmissionPart;
    if (error instanceof MessagingSendError && error.outcome === "definitive") {
      submission.parts[index] = {
        ...part,
        error: error.message,
        retryable: error.retryable,
        status: "failed",
      };
      submission.phase = "blocked";
      this.publish(submission);
      return;
    }

    submission.parts[index] = {...part, status: "reconciling"};
    submission.phase = "blocked";
    this.publish(submission);
    try {
      const result = await this.messaging.reconcileMessage({
        channel: submission.channel,
        clientRequestId: part.clientRequestId,
      });
      if (result.state === "sent") {
        submission.parts[index] = sentPart(part, result.message);
        submission.phase = "queued";
        this.publish(submission);
        return;
      }
      if (result.state === "failed") {
        submission.parts[index] = {
          ...part,
          error: result.error,
          retryable: result.retryable,
          status: "failed",
        };
      }
    } catch {
      // A failed reconciliation is still uncertain. Keep the part fenced.
    }
    submission.phase = "blocked";
    this.publish(submission);
  }

  private current(conversationKey: string): ComposerSubmission | undefined {
    const id = this.queues.get(conversationKey)?.[0];
    return id ? this.records.get(id) : undefined;
  }

  private shift(conversationKey: string): void {
    const queue = this.queues.get(conversationKey);
    if (!queue) return;
    queue.shift();
    if (queue.length === 0) this.queues.delete(conversationKey);
  }

  private publish(submission: ComposerSubmission): void {
    this.onChange(cloneSubmission(submission));
  }
}

function sentPart(
  part: ComposerSubmissionPart,
  message: Message,
): ComposerSubmissionPart {
  const {error: _error, retryable: _retryable, ...sent} = part;
  return {
    ...sent,
    messageId: message.id,
    status: "sent",
  };
}

function cloneSubmission(submission: ComposerSubmission): ComposerSubmission {
  return {
    ...submission,
    attachments: submission.attachments.map((attachment) => ({...attachment})),
    document: {
      ...submission.document,
      nodes: submission.document.nodes.map((node) => ({...node})),
    },
    parts: submission.parts.map((part) => ({...part})),
  };
}
