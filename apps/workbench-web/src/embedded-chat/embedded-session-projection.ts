export type EmbeddedSessionMetadataProjector = (metadata: unknown) => Readonly<Record<string, unknown>> | undefined;

export interface EmbeddedWorkbenchAppSession {
  readonly chatId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly readOnly: boolean;
  readonly running: boolean;
  readonly pinned: boolean;
  /** Selected for display by this embedded product. */
  readonly extra?: Readonly<Record<string, unknown>>;
}

export function projectEmbeddedSession(
  thread: { readonly id: string; readonly title: string; readonly status: string; readonly pinned?: boolean },
  protocolThread?: { readonly updatedAt: number; readonly extra?: unknown },
  projectMetadata?: EmbeddedSessionMetadataProjector,
): EmbeddedWorkbenchAppSession {
  const updatedAt = protocolThread?.updatedAt ?? 0;
  const metadata = protocolThread?.extra;
  const extra = metadata == null ? undefined : projectMetadata?.(metadata);
  return {
    chatId: thread.id,
    title: thread.title,
    createdAt: updatedAt,
    updatedAt,
    readOnly: false,
    running: thread.status === "running",
    pinned: thread.pinned === true,
    ...(extra === undefined ? {} : { extra }),
  };
}
