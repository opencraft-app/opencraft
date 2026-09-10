import type {
  ComposerBlockNode,
  ComposerDocument,
  ComposerInline,
  ComposerParagraphNode,
  ComposerTextInline,
} from "@opencraft/composer-core";
import type { Mark, Node as ProseMirrorNode, Schema } from "prosemirror-model";

function textMarks(marks: readonly Mark[]): ComposerTextInline["marks"] {
  const result: ("strong" | "emphasis" | "code")[] = [];
  for (const mark of marks) {
    if (mark.type.name === "strong") result.push("strong");
    else if (mark.type.name === "em") result.push("emphasis");
    else if (mark.type.name === "code") result.push("code");
  }
  return result.length === 0 ? undefined : result;
}

function inlineFromNode(node: ProseMirrorNode): ComposerInline | null {
  if (node.isText) {
    const text: ComposerTextInline = {
      type: "text",
      text: node.text ?? "",
      ...(textMarks(node.marks) === undefined ? {} : { marks: textMarks(node.marks) }),
    };
    const link = node.marks.find((mark) => mark.type.name === "link");
    return link === undefined
      ? text
      : { type: "link", href: String(link.attrs.href ?? ""), children: [text] };
  }
  if (node.type.name === "hard_break") return { type: "hard-break" };
  if (node.type.name !== "token") return null;
  const id = String(node.attrs.id ?? "");
  const label = String(node.attrs.label ?? "");
  const payload = node.attrs.payload !== null && typeof node.attrs.payload === "object"
    ? node.attrs.payload as Readonly<Record<string, unknown>>
    : {};
  switch (node.attrs.kind) {
    case "command": return {
      type: "command",
      name: label,
      ...(typeof payload.argument === "string" ? { argument: payload.argument } : {}),
      ...(typeof payload.uri === "string" ? { uri: payload.uri } : {}),
      ...(payload.metadata !== null && typeof payload.metadata === "object"
        ? { metadata: payload.metadata as Readonly<Record<string, unknown>> }
        : {}),
    };
    case "skill": return {
      type: "resource",
      id,
      title: label,
      uri: typeof payload.uri === "string" ? payload.uri : `skill://${id}`,
      resourceKind: typeof payload.resourceKind === "string" ? payload.resourceKind : "skill",
      ...(payload.metadata !== null && typeof payload.metadata === "object"
        ? { metadata: payload.metadata as Readonly<Record<string, unknown>> }
        : {}),
    };
    case "resource": return {
      type: "resource",
      id,
      title: label,
      uri: typeof payload.uri === "string" ? payload.uri : `resource://${id}`,
      ...(typeof payload.resourceKind === "string" ? { resourceKind: payload.resourceKind } : {}),
      ...(payload.metadata !== null && typeof payload.metadata === "object"
        ? { metadata: payload.metadata as Readonly<Record<string, unknown>> }
        : {}),
    };
    default: return {
      type: "mention",
      id,
      label,
      mentionKind: payload.mentionKind === "file"
        || payload.mentionKind === "agent"
        || payload.mentionKind === "thread"
        || payload.mentionKind === "person"
        || payload.mentionKind === "generic"
        ? payload.mentionKind
        : "generic",
      ...(typeof payload.uri === "string" ? { uri: payload.uri } : {}),
      ...(payload.metadata !== null && typeof payload.metadata === "object"
        ? { metadata: payload.metadata as Readonly<Record<string, unknown>> }
        : {}),
    };
  }
}

function paragraphFromNode(node: ProseMirrorNode): ComposerParagraphNode {
  const children: ComposerInline[] = [];
  node.forEach((child) => {
    const inline = inlineFromNode(child);
    if (inline === null) return;
    const previous = children.at(-1);
    if (inline.type === "link" && previous?.type === "link" && previous.href === inline.href) {
      children[children.length - 1] = {
        ...previous,
        children: [...previous.children, ...inline.children],
      };
    } else {
      children.push(inline);
    }
  });
  return { type: "paragraph", children };
}

function blockFromNode(node: ProseMirrorNode, path: string): ComposerBlockNode | null {
  switch (node.type.name) {
    case "paragraph": return paragraphFromNode(node);
    case "code_block": return {
      type: "code-block",
      ...(typeof node.attrs.language === "string" && node.attrs.language.length > 0
        ? { language: node.attrs.language }
        : {}),
      text: node.textContent,
    };
    case "horizontal_rule": return { type: "divider" };
    case "blockquote": {
      const children: ComposerBlockNode[] = [];
      node.forEach((child, _offset, index) => {
        const block = blockFromNode(child, `${path}.quote.${index}`);
        if (block !== null) children.push(block);
      });
      return { type: "quote", children };
    }
    case "ordered_list":
    case "bullet_list": {
      const items: { id: string; children: ComposerBlockNode[] }[] = [];
      node.forEach((item, _offset, itemIndex) => {
        const children: ComposerBlockNode[] = [];
        item.forEach((child, _childOffset, childIndex) => {
          const block = blockFromNode(child, `${path}.item.${itemIndex}.${childIndex}`);
          if (block !== null) children.push(block);
        });
        items.push({
          id: typeof item.attrs.id === "string" && item.attrs.id.length > 0
            ? item.attrs.id
            : `${path}.item.${itemIndex}`,
          children,
        });
      });
      return {
        type: "list",
        ordered: node.type.name === "ordered_list",
        ...(node.type.name === "ordered_list" && Number(node.attrs.order) !== 1
          ? { start: Number(node.attrs.order) }
          : {}),
        items,
      };
    }
    default: return null;
  }
}

export function proseMirrorToComposerDocument(documentNode: ProseMirrorNode): ComposerDocument {
  const blocks: ComposerBlockNode[] = [];
  documentNode.forEach((node, _offset, index) => {
    const block = blockFromNode(node, `block.${index}`);
    if (block !== null) blocks.push(block);
  });
  return {
    version: 1,
    blocks: blocks.length === 0 ? [{ type: "paragraph", children: [] }] : blocks,
  };
}

function markTypes(schema: Schema, marks: ComposerTextInline["marks"]): Mark[] {
  if (marks === undefined) return [];
  return marks.flatMap((mark): Mark[] => {
    const type = mark === "emphasis" ? schema.marks.em : schema.marks[mark];
    return type === undefined ? [] : [type.create()];
  });
}

function inlineToNodes(schema: Schema, inline: ComposerInline): readonly ProseMirrorNode[] {
  switch (inline.type) {
    case "text": return inline.text.length === 0 ? [] : [schema.text(inline.text, markTypes(schema, inline.marks))];
    case "hard-break": return [schema.nodes.hard_break.create()];
    case "mention": return [schema.nodes.token.create({
      id: inline.id,
      kind: "mention",
      label: inline.label,
      payload: {
        mentionKind: inline.mentionKind,
        uri: inline.uri,
        metadata: inline.metadata,
      },
    })];
    case "command": return [schema.nodes.token.create({
      id: inline.name,
      kind: "command",
      label: inline.name,
      payload: {
        argument: inline.argument,
        uri: inline.uri,
        metadata: inline.metadata,
      },
    })];
    case "resource": return [schema.nodes.token.create({
      id: inline.id,
      kind: inline.resourceKind === "skill" ? "skill" : "resource",
      label: inline.title,
      payload: {
        uri: inline.uri,
        resourceKind: inline.resourceKind,
        metadata: inline.metadata,
      },
    })];
    case "link": {
      const link = schema.marks.link.create({ href: inline.href });
      return inline.children.flatMap((child) => child.text.length === 0
        ? []
        : [schema.text(child.text, [...markTypes(schema, child.marks), link])]);
    }
  }
}

function paragraphToNode(schema: Schema, paragraph: ComposerParagraphNode): ProseMirrorNode {
  return schema.nodes.paragraph.create(
    null,
    paragraph.children.flatMap((inline) => inlineToNodes(schema, inline)),
  );
}

function blockToNode(schema: Schema, block: ComposerBlockNode): ProseMirrorNode {
  switch (block.type) {
    case "paragraph": return paragraphToNode(schema, block);
    case "code-block": return schema.nodes.code_block.create(
      { language: block.language ?? null },
      block.text.length === 0 ? undefined : schema.text(block.text),
    );
    case "divider": return schema.nodes.horizontal_rule.create();
    case "quote": return schema.nodes.blockquote.create(
      null,
      block.children.map((child) => blockToNode(schema, child)),
    );
    case "list": {
      const listType = block.ordered ? schema.nodes.ordered_list : schema.nodes.bullet_list;
      const items = block.items.map((item) => schema.nodes.list_item.create(
        { id: item.id },
        item.children.map((child) => blockToNode(schema, child)),
      ));
      return listType.create(block.ordered ? { order: block.start ?? 1 } : null, items);
    }
  }
}

export function composerDocumentToProseMirror(
  document: ComposerDocument,
  schema: Schema,
): ProseMirrorNode {
  return schema.nodes.doc.create(
    null,
    document.blocks.map((block) => blockToNode(schema, block)),
  );
}
