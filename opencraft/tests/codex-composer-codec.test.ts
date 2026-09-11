import assert from "node:assert/strict";
import test from "node:test";

import { resolveComposerFooterDensity } from "@opencraft/codex-composer";

import type { ComposerDocument } from "@opencraft/composer-core";
import {
  composerDocumentToProseMirror,
  composerSchema,
  proseMirrorToComposerDocument,
} from "@opencraft/codex-composer";

const document: ComposerDocument = {
  version: 1,
  blocks: [
    {
      type: "paragraph",
      children: [
        { type: "text", text: "Inspect ", marks: ["strong"] },
        {
          type: "mention",
          id: "file-1",
          label: "runtime.ts",
          mentionKind: "file",
          uri: "file:///vela/runtime.ts",
          metadata: { line: 42 },
        },
        { type: "hard-break" },
        {
          type: "link",
          href: "https://example.test/spec",
          children: [
            { type: "text", text: "protocol", marks: ["emphasis"] },
            { type: "text", text: " spec", marks: ["code"] },
          ],
        },
        {
          type: "command",
          name: "review",
          argument: "--deep",
          uri: "command://review",
          metadata: { source: "catalog" },
        },
        {
          type: "resource",
          id: "skill-1",
          title: "review skill",
          uri: "skill:///skills/review/SKILL.md",
          resourceKind: "skill",
          metadata: {
            canonicalName: "review",
            path: "/skills/review/SKILL.md",
            version: 3,
          },
        },
      ],
    },
    {
      type: "quote",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", text: "Keep Turn identity." }],
        },
        {
          type: "list",
          ordered: true,
          start: 3,
          items: [
            {
              id: "item-stable-1",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", text: "Restore anchor" }],
                },
                {
                  type: "code-block",
                  language: "ts",
                  text: "const turnKey = turn.id;",
                },
              ],
            },
          ],
        },
      ],
    },
    { type: "divider" },
  ],
};

test("portable Composer document round-trips through ProseMirror without flattening", () => {
  const proseMirror = composerDocumentToProseMirror(document, composerSchema);
  const restored = proseMirrorToComposerDocument(proseMirror);
  assert.deepEqual(restored, document);
});

test("list item identity is represented in the ProseMirror schema", () => {
  const proseMirror = composerDocumentToProseMirror(document, composerSchema);
  let listItemId: string | null = null;
  proseMirror.descendants((node) => {
    if (node.type.name === "list_item") listItemId = String(node.attrs.id);
  });
  assert.equal(listItemId, "item-stable-1");
});

test("Composer footer progressively discloses controls from measured widths", () => {
  const base = {
    fixedWidth: 110,
    hostWidth: 70,
    intelligenceWidth: 150,
    permissionWidth: 130,
  };
  assert.equal(
    resolveComposerFooterDensity({ ...base, availableWidth: 500 }),
    "full",
  );
  assert.equal(
    resolveComposerFooterDensity({ ...base, availableWidth: 330 }),
    "compact",
  );
  assert.equal(
    resolveComposerFooterDensity({ ...base, availableWidth: 290 }),
    "tight",
  );
  assert.equal(
    resolveComposerFooterDensity({ ...base, availableWidth: 170 }),
    "minimal",
  );
});
