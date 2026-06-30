import {
  $applyNodeReplacement,
  TextNode,
  type EditorConfig,
  type NodeKey,
  type SerializedTextNode,
  type Spread,
} from "lexical";

export type SerializedComposerSkillNode = Spread<
  {
    skillName: string;
    type: "composer-skill";
    version: 1;
  },
  SerializedTextNode
>;

export class ComposerSkillNode extends TextNode {
  __skillName: string;

  static override getType(): string {
    return "composer-skill";
  }

  static override clone(node: ComposerSkillNode): ComposerSkillNode {
    return new ComposerSkillNode(node.__text, node.__skillName, node.__key);
  }

  static override importJSON(serializedNode: SerializedComposerSkillNode): ComposerSkillNode {
    return $createComposerSkillNode(
      `$${serializedNode.skillName}`,
    ).updateFromJSON(serializedNode);
  }

  constructor(text: string, skillName?: string, key?: NodeKey) {
    const prefix = text.startsWith("/") ? "/" : "$";
    const normalizedName = (skillName ?? text.replace(/^[$/]/, "")).trim();
    super(`${prefix}${normalizedName}`, key);
    this.__skillName = normalizedName;
  }

  override exportJSON(): SerializedComposerSkillNode {
    return {
      ...super.exportJSON(),
      skillName: this.__skillName,
      type: "composer-skill",
      version: 1,
    };
  }

  override createDOM(_config: EditorConfig): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "velaComposerSkillChip";
    dom.contentEditable = "false";
    dom.setAttribute("spellcheck", "false");
    renderSkillChip(dom, this.__text, this.__skillName);
    return dom;
  }

  override updateDOM(prevNode: ComposerSkillNode, dom: HTMLElement): boolean {
    dom.contentEditable = "false";
    if (prevNode.__text !== this.__text || prevNode.__skillName !== this.__skillName) {
      renderSkillChip(dom, this.__text, this.__skillName);
    }
    return false;
  }

  override canInsertTextBefore(): false {
    return false;
  }

  override canInsertTextAfter(): true {
    return true;
  }

  override isTextEntity(): true {
    return true;
  }

  override isToken(): true {
    return true;
  }
}

export function $createComposerSkillNode(text: string): ComposerSkillNode {
  return $applyNodeReplacement(new ComposerSkillNode(text));
}

function renderSkillChip(dom: HTMLElement, text: string, skillName: string) {
  dom.textContent = "";
  dom.style.setProperty("user-select", "none");
  dom.style.setProperty("-webkit-user-select", "none");

  const prefix = document.createElement("span");
  prefix.className = "velaComposerSkillChipPrefix";
  prefix.textContent = text.startsWith("/") ? "/" : "$";

  const label = document.createElement("span");
  label.className = "velaComposerSkillChipLabel";
  label.textContent = skillName;

  dom.append(prefix, label);
}

export function $isComposerSkillNode(node: unknown): node is ComposerSkillNode {
  return node instanceof ComposerSkillNode;
}
