import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSource, scanProject, compareCopy } from "../../scripts/i18n-source.mjs";

const inspect = source => inspectSource("plugins/example/src/view.tsx", source);

test("detects UI text, accessibility, branches, fallbacks and interpolated templates", () => {
  const { copy } = inspect('<><button title="Retry now">Try again</button><input placeholder={busy ? "Loading…" : "Ask anything"}/><Text accessibilityLabel="Voice controls">{ready && "Ready now"}</Text><span>{name ?? "Unknown person"}</span><b>{`Edit ${name}`}</b></>');
  assert.deepEqual(copy.map(row => row.text).sort(), ["Retry now", "Try again", "Loading…", "Ask anything", "Voice controls", "Ready now", "Unknown person", "Edit ${…}"].sort());
  assert.ok(copy.every(row => row.file === "plugins/example/src/view.tsx" && row.line === 1));
});

test("keeps descriptors, data, callbacks, logs and user values separate from literal UI copy", () => {
  const { copy, messages } = inspect(`
    console.log("Server disconnected");
    const status = "protocol-ready";
    const label = { id: "example.retry", defaultMessage: "Retry", description: "Network action" };
    const view = <><button onClick={() => send("turn/start")} title={intl.formatMessage(label)}>{user.name}</button>
    <FormattedMessage id={"example.ready"} defaultMessage={"Ready"}/></>;
  `);
  assert.deepEqual(copy, []);
  assert.deepEqual(messages.map(row => row.id), ["example.retry", "example.ready"]);
});

test("literal allowance cannot hide an edit, duplicate or move and must shrink after migration", () => {
  const source = '<button>Retry now</button>';
  const [row] = inspect(source).copy;
  const baseline = { entries: [{ ...row, count: 1, reason: "Legacy copy awaiting migration" }] };
  assert.deepEqual(compareCopy([row], baseline), []);
  assert.equal(compareCopy([row, row], baseline).length, 1);
  assert.equal(compareCopy([{ ...row, text: "Retry later" }], baseline).length, 2);
  assert.equal(compareCopy([{ ...row, file: "packages/new/src/view.tsx" }], baseline).length, 2);
  assert.match(compareCopy([], baseline)[0], /obsolete/);
  assert.throws(() => compareCopy([], { entries: [{ ...row, count: 0, reason: "Legacy" }] }), /Invalid/);
  assert.throws(() => compareCopy([], { entries: [{ ...row, count: 1 }] }), /Invalid/);
});

test("discovers new app, shared package and plugin source without a hardcoded UI root list", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencraft-i18n-source-"));
  try {
    for (const area of ["apps", "packages", "plugins"]) {
      await mkdir(join(root, area, "new-owner", "src"), { recursive: true });
      await writeFile(join(root, area, "new-owner", "src", "view.tsx"), '<button>New action</button>');
      await writeFile(join(root, area, "new-owner", "src", "view.test.tsx"), '<button>Fixture copy</button>');
      await mkdir(join(root, area, "source-less"));
    }
    const inventory = await scanProject(root);
    assert.equal(inventory.files.length, 3);
    assert.equal(inventory.copy.length, 3);
    assert.ok(inventory.copy.every(row => row.text === "New action"));
    assert.equal(compareCopy(inventory.copy, { entries: [] }).length, 3);
  } finally { await rm(root, { recursive: true, force: true }); }
});
