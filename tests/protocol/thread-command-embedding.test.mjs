import test from 'node:test';
import assert from 'node:assert/strict';
import {parseThreadCommand,replaceThreadCommandIdempotencyKey} from '../../packages/appserver-protocol/src/thread-command.mjs';
test('materialized CLI parser has no module closure dependencies',()=>{
 const embedded=Function('return ('+parseThreadCommand.toString()+')')();
 for(const argv of [['context'],['thread','tell','reference','--message','body','--idempotency-key','old']])assert.deepEqual(embedded(argv),parseThreadCommand(argv));
 const argv=['thread','tell','same','--message','same','--idempotency-key','same'];
 assert.deepEqual(replaceThreadCommandIdempotencyKey(argv,'new'),['thread','tell','same','--message','same','--idempotency-key','new']);
 assert.equal(argv.at(-1),'same');
});
