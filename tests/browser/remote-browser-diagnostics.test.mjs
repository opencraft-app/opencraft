import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createNativeDiagnostics}=createRequire(import.meta.url)('../../scripts/remote-browser/diagnostics.cjs');

test('native stderr is bounded private metadata, never arbitrary text or arguments',()=>{
 const d=createNativeDiagnostics();
 const message='private-cookie secret-url password';
 const input=Buffer.from(message+'\n[123:1:FATAL:ui/events/bitset_32.h:27] DCHECK failed: '+message+'\n#0 0x123 ui::VelocityTracker::AddMovement('+message+')\n#1 0x456 (/opt/runtime/libbase.so+0x123)\n');
 for(const byte of input)d.consume(Buffer.from([byte]));
 for(let i=0;i<100;i++)d.consume(Buffer.alloc(65536,65));
 d.consume(Buffer.from('\n'));d.finish();
 const result=d.snapshot();
 assert.deepEqual(result.fatal,{kind:'dcheck',file:'bitset_32.h',line:27});
 assert.deepEqual(result.frames,[{index:0,symbol:'ui::VelocityTracker::AddMovement'},{index:1,symbol:'libbase.so+0x123'}]);
 assert.equal(result.discardedLines,1);assert(!JSON.stringify(result).includes(message));
 result.frames.length=0;assert.equal(d.snapshot().frames.length,2);
});

test('native diagnostic frames are capped and unrelated stderr is discarded',()=>{
 const d=createNativeDiagnostics();d.consume(Buffer.from('not a stack\n'));
 assert.equal(d.snapshot().fatal,null);
 d.consume(Buffer.from('[1:1:FATAL:base/check.cc:8] Check failed: private\n'));
 for(let i=0;i<1000;i++)d.consume(Buffer.from('#'+i+' 0x123 base::Function()\n'));
 d.finish();assert.equal(d.snapshot().frames.length,24);
});
