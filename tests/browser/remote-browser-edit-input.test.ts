import test from 'node:test';
import assert from 'node:assert/strict';
import { RemoteBrowserEditInput } from '../../apps/workbench-web/src/browser/remote-browser-edit-input';
function fixture() {
  const receiver={value:''} as HTMLInputElement, calls:string[]=[];
  let active=true,composing=false;
  const edit=new RemoteBrowserEditInput(receiver,()=>active,()=>composing,text=>calls.push('text:'+text),key=>calls.push('key:'+key));
  const event=(inputType:string,cancelable:boolean,data:string|null=null)=>({inputType,cancelable,data,isComposing:false,preventDefault(){this.prevented=true},prevented:false}) as unknown as InputEvent & {prevented:boolean};
  return {receiver,calls,edit,event,active:(v:boolean)=>active=v,composing:(v:boolean)=>composing=v};
}
test('noncancelable deletion and line breaks work with an empty staging receiver',()=>{
  for(const [type,key] of [['deleteContentBackward','Backspace'],['deleteContentForward','Delete'],['insertLineBreak','Return'],['insertParagraph','Return']]) {
    const f=fixture(),e=f.event(type,false);f.edit.beforeInput(e);assert.deepEqual(f.calls,[]);f.edit.input(e);
    assert.deepEqual(f.calls,['key:'+key]);assert.equal(f.receiver.value,'');
  }
});
test('cancelable edits apply once even if input follows; next beforeinput is independent',()=>{
  const f=fixture(),e=f.event('deleteContentBackward',true);f.edit.beforeInput(e);assert(e.prevented);f.edit.input(e);
  assert.deepEqual(f.calls,['key:Backspace']);
  f.edit.beforeInput(f.event('deleteContentBackward',false));f.edit.input(f.event('deleteContentBackward',false));
  assert.deepEqual(f.calls,['key:Backspace','key:Backspace']);
});
test('text stages once and trailing composition data cannot repeat an already committed character',()=>{
  const f=fixture(),e=f.event('insertText',true,'你');f.edit.beforeInput(e);f.receiver.value='你';f.edit.input(e);
  assert.deepEqual(f.calls,['text:你']);assert.equal(f.receiver.value,'');
  f.edit.retire();f.edit.input(f.event('insertText',false,'你'));assert.deepEqual(f.calls,['text:你']);
  const next=f.event('insertText',false,'好');f.edit.beforeInput(next);f.receiver.value='好';f.edit.input(next);
  assert.deepEqual(f.calls,['text:你','text:好']);
});
test('composing, inactive and retired contexts do not submit edits',()=>{
  const f=fixture();f.composing(true);f.edit.input(f.event('deleteContentBackward',false));f.composing(false);f.active(false);
  f.edit.beforeInput(f.event('insertText',true,'x'));assert.deepEqual(f.calls,[]);
});
