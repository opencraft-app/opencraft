import type {ComposerMentionNode as ComposerDocumentMentionNode} from "@vela/client-core";
import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

export type SerializedComposerMentionNode = Spread<
  {
    displayName: string;
    handle: string;
    imUserId: string;
    memberId: string;
    memberKind: "human" | "agent";
    type: "vela-composer-mention";
    version: 1;
  },
  SerializedTextNode
>;

export class ComposerMentionNode extends TextNode {
  __displayName: string;
  __handle: string;
  __imUserId: string;
  __memberId: string;
  __memberKind: "human" | "agent";

  public static override getType(): string {
    return "vela-composer-mention";
  }

  public static override clone(node: ComposerMentionNode): ComposerMentionNode {
    return new ComposerMentionNode(node.toComposerNode(), node.__key);
  }

  public static override importJSON(
    value: SerializedComposerMentionNode,
  ): ComposerMentionNode {
    return $createComposerMentionNode({
      displayName: value.displayName,
      handle: value.handle,
      imUserId: value.imUserId,
      memberId: value.memberId,
      memberKind: value.memberKind,
      type: "mention",
    }).updateFromJSON(value);
  }

  public constructor(node: ComposerDocumentMentionNode, key?: NodeKey) {
    super(`@${node.displayName}`, key);
    this.__displayName = node.displayName;
    this.__handle = node.handle;
    this.__imUserId = node.imUserId;
    this.__memberId = node.memberId;
    this.__memberKind = node.memberKind;
  }

  public override exportJSON(): SerializedComposerMentionNode {
    return {
      ...super.exportJSON(),
      displayName: this.__displayName,
      handle: this.__handle,
      imUserId: this.__imUserId,
      memberId: this.__memberId,
      memberKind: this.__memberKind,
      type: "vela-composer-mention",
      version: 1,
    };
  }

  public override createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement("span");
    element.className = "vela-composer-mention";
    element.contentEditable = "false";
    element.spellcheck = false;
    element.textContent = `@${this.__displayName}`;
    element.dataset.memberId = this.__memberId;
    element.dataset.memberKind = this.__memberKind;
    return element;
  }

  public override updateDOM(
    previous: ComposerMentionNode,
    element: HTMLElement,
  ): boolean {
    element.contentEditable = "false";
    if (
      previous.__displayName !== this.__displayName ||
      previous.__memberId !== this.__memberId ||
      previous.__memberKind !== this.__memberKind
    ) {
      element.textContent = `@${this.__displayName}`;
      element.dataset.memberId = this.__memberId;
      element.dataset.memberKind = this.__memberKind;
    }
    return false;
  }

  public override canInsertTextBefore(): false {
    return false;
  }

  public override canInsertTextAfter(): true {
    return true;
  }

  public override isTextEntity(): true {
    return true;
  }

  public override isToken(): true {
    return true;
  }

  public toComposerNode(): ComposerDocumentMentionNode {
    const latest = this.getLatest();
    return {
      displayName: latest.__displayName,
      handle: latest.__handle,
      imUserId: latest.__imUserId,
      memberId: latest.__memberId,
      memberKind: latest.__memberKind,
      type: "mention",
    };
  }
}

export function $createComposerMentionNode(
  node: ComposerDocumentMentionNode,
): ComposerMentionNode {
  return $applyNodeReplacement(new ComposerMentionNode(node));
}

export function $isComposerMentionNode(
  node: unknown,
): node is ComposerMentionNode {
  return node instanceof ComposerMentionNode;
}
