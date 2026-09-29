import type { UserInput } from "@opencraft/appserver-protocol/generated/v2";
import type {
  ComposerAttachment,
  ComposerContextReference,
  ComposerDocument,
  ComposerInline,
} from "@opencraft/composer-core";

export interface RestoredQueuedComposerContent {
  readonly document: ComposerDocument;
  readonly attachments: readonly ComposerAttachment[];
  readonly context: readonly ComposerContextReference[];
}

function attachmentName(uri: string, fallback: string): string {
  if (/^(?:data|blob|asset):/u.test(uri)) return fallback;
  const withoutQuery = uri.split(/[?#]/u, 1)[0] ?? uri;
  const basename = withoutQuery.split(/[\\/]/u).filter(Boolean).at(-1);
  if (basename === undefined) return fallback;
  try {
    return decodeURIComponent(basename);
  } catch {
    return basename;
  }
}

function attachment(
  id: string,
  uri: string,
  mediaKind: "image" | "audio",
  metadata?: Readonly<Record<string, unknown>>,
): ComposerAttachment {
  return {
    id,
    name: attachmentName(uri, `${mediaKind} attachment`),
    mimeType: `${mediaKind}/*`,
    size: 0,
    uri,
    lifecycle: "ready",
    error: null,
    ...(metadata === undefined ? {} : { metadata }),
  };
}

/**
 * Restores the native AppServer queue payload into the portable Composer
 * model. Queue identity and ordering remain Thread-owned; only editable
 * content crosses this adapter boundary.
 */
export function restoreQueuedInput(
  input: readonly UserInput[],
): RestoredQueuedComposerContent {
  const inlines: ComposerInline[] = [];
  const attachments: ComposerAttachment[] = [];
  for (const [index, entry] of input.entries()) {
    switch (entry.type) {
      case "text":
        if (entry.text.length > 0)
          inlines.push({ type: "text", text: entry.text });
        break;
      case "mention":
        inlines.push({
          type: "mention",
          id: `queued-mention-${index}`,
          label: entry.name,
          mentionKind: "file",
          uri: entry.path,
          metadata: { path: entry.path },
        });
        break;
      case "skill":
        inlines.push({
          type: "resource",
          id: `queued-skill-${index}`,
          title: entry.name,
          uri: entry.path,
          resourceKind: "skill",
          metadata: { canonicalName: entry.name, path: entry.path },
        });
        break;
      case "image":
        attachments.push("url" in entry
          ? attachment(`queued-image-${index}`, entry.url, "image")
          : attachment(
              `queued-image-${index}`,
              `codex-file:${encodeURIComponent(entry.fileId)}`,
              "image",
              { codexFileId: entry.fileId },
            ));
        break;
      case "localImage":
        attachments.push(
          attachment(`queued-image-${index}`, entry.path, "image"),
        );
        break;
      case "audio":
        attachments.push(
          attachment(`queued-audio-${index}`, entry.url, "audio"),
        );
        break;
      case "localAudio":
        attachments.push(
          attachment(`queued-audio-${index}`, entry.path, "audio"),
        );
        break;
    }
  }
  return {
    document: {
      version: 1,
      blocks: [{ type: "paragraph", children: inlines }],
    },
    attachments,
    context: [],
  };
}
