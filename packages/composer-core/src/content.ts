export interface TextBlock {
  type: "text";
  text: string;
}

export interface MentionBlock {
  type: "mention";
  id: string;
  label: string;
}

export interface CommandBlock {
  type: "command";
  name: string;
  argument?: string;
}

/**
 * Serializable attachment metadata. Platform file handles live in the host's
 * asset repository and are addressed by this id; they never enter app state.
 */
export interface AttachmentBlock {
  type: "attachment";
  id: string;
  name: string;
  mimeType: string;
  size: number;
  uri?: string;
}

export interface ResourceBlock {
  type: "resource";
  id: string;
  title: string;
  uri: string;
}

export type ContentBlock =
  | TextBlock
  | MentionBlock
  | CommandBlock
  | AttachmentBlock
  | ResourceBlock;

export function contentBlocksToPrompt(blocks: readonly ContentBlock[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "mention":
          return `@${block.label}`;
        case "command":
          return `/${block.name}${block.argument ? ` ${block.argument}` : ""}`;
        case "attachment":
          return `[Attachment: ${block.name}]`;
        case "resource":
          return `[${block.title}](${block.uri})`;
      }
    })
    .join("")
    .trim();
}
