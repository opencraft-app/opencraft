import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { checkActivityRepository, inspectActivityStyle, inspectActivityJsx, visualOwner } from "../../scripts/check-conversation-activity.mjs";

test("activity visual metrics have one owner, including valid-but-wrong font roles", () => {
  for (const source of [
    '.thread-compaction { font:var(--typography-chat-font) }',
    '.thread-activity-item__header {font-size:var(--typography-body-size)}',
    '.thread-activity-item__summary {font:var(--typography-chat-font)}',
    '.thread-compaction { @include typography.role(chat); }',
    '.thread-thinking-placeholder { @include typography.role(metadata); }',
    '.thread-subagent-activity__toggle {font:inherit}',
    '.thread-subagent-activity__status { @include typography.role(chat); }',
    '.thread-tool-row { @include typography.role(body); }',
    '.thread-activity-item__icon {width:12px}',
    '.thread-compaction {svg {stroke-width:2}}',
    '.thread-activity-item__icon > .lucide-brain {transform:scale(0.8)}',
  ]) assert.equal(inspectActivityStyle(source).length, 1, source);
  assert.equal(inspectActivityStyle('.thread-activity-item__icon {width:20px}', visualOwner).length, 0);
  assert.equal(inspectActivityStyle('.thread-activity-item__header {min-height:22px; gap:6px; color:inherit}').length, 0);
  assert.equal(inspectActivityStyle('.message-prose {font:var(--typography-chat-font)}').length, 0);
});

test("feature renderers cannot choose local glyph metrics or recreate the rail", () => {
  for (const source of [
    '<ActivityDisclosure icon={<Brain size={14} />} />',
    '<ActivitySummaryRow icon={<ListChecks style={{width:12}} />} summary="Done" />',
    '<ActivityIcon><Brain strokeWidth={2}/></ActivityIcon>',
    '<span className="thread-activity-item__icon"><Brain/></span>',
    'function activityIcon(){return <Bot size={14}/>}',
    'function CompactionBlock(){return <div><ListChecks size={12}/>Done</div>}',
    'function AggregatedSubagentActivity(){return <button><Bot size={14}/>Created</button>}',
    'function SubagentBlock(){return <button><Bot/>Created</button>}',
    'function ThreadTool(){return <div><Bot/>Created</div>}',
  ]) assert.ok(inspectActivityJsx(source).length > 0, source);
  assert.deepEqual(inspectActivityJsx('<ActivitySummaryRow icon={<ListChecks/>} summary="Done"/>'), []);
  assert.deepEqual(inspectActivityJsx('function CompactionBlock(){return <ActivitySummaryRow icon={<ListChecks/>} summary="Done"/>}'), []);
});

test("owned consumers and normal gates enforce the activity contract", () => {
  assert.deepEqual(checkActivityRepository(), []);
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.match(pkg.scripts['check:typography'], /check-conversation-activity/);
  assert.match(pkg.scripts['test:typography'], /conversation-activity-visual/);
  assert.match(pkg.scripts['test:control-standards'], /conversation-activity-visual/);
});


test("process adapters cannot bypass their shared feedback owner", () => {
  for (const name of ["ActivityDisclosure", "ActivitySummaryRow", "AgentActivityGroupDisclosure", "ThreadTool"]) {
    const bypass = `function ${name}(){return <div className="thread-activity-item__header"><ActivityIcon><Brain/></ActivityIcon><CadencedShimmer active>Working</CadencedShimmer></div>}`;
    assert.ok(inspectActivityJsx(bypass).length > 0, name);
    const shared = `function ${name}(){return <div className="thread-activity-item__header"><ActivityRowContent icon={<Brain/>} summary="Working" running={true}/></div>}`;
    assert.deepEqual(inspectActivityJsx(shared), [], name);
  }
});
