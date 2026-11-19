import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import sharp from 'sharp';
import {materializeInboundFiles,storeInboundFile} from '../../plugins/wecom/inbound-files.mjs';
import {describeMessage} from '../../plugins/wecom/rich-inbound.mjs';
import {parseRichAction,sendRichAction,richActionSummary} from '../../plugins/wecom/rich-outbound.mjs';
import {tickInteractions} from '../../plugins/wecom/mirror/interaction-lifecycle.mjs';
const source=JSON.stringify(['wecom-customer-service','wxfixture','fwfixture','room']);
const node=(name,text='',children=[])=>({name,text,children});
const text=(sender,corp,body)=>node('MsgItem','',[node('Sender',sender),node('SenderCorpId',corp),node('MsgType','text'),node('Content',body)]);
const forward=messages=>node('MsgItem','',[node('MsgType','forward'),node('ForwardMessage','',[node('MsgItemList','',messages)])]);

test('nested forwards keep local corporation context while foreign same-name senders stay distinct',()=>{
 const nested=forward([text('alice','wxlocal','本企业'),text('alice','wxforeign','其他企业')]);nested.children.push(node('Sender','alice'),node('SenderCorpId','wxlocal'));
 const output=describeMessage(forward([nested]),new Map([['alice','Alice']]),0,'wxlocal');
 assert.match(output,/Alice: 本企业/u);assert.doesNotMatch(output,/外部企业 wxlocal/u);assert.match(output,/alice（外部企业 wxforeign）: 其他企业/u);
});
test('large forwarded pictures and GIF materials become usable images, originals remain byte-identical',async t=>{
 const dir=fs.mkdtempSync(join(os.tmpdir(),'wecom-material-preview-')),root=join(dir,'store'),originals=join(dir,'originals'),folder=join(dir,'materials');t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const png=await sharp(randomBytes(1100*1100*3),{raw:{width:1100,height:1100,channels:3}}).png().toBuffer();assert.ok(png.length>2*1024*1024);
 const gif=await sharp({create:{width:30,height:20,channels:3,background:'red'}}).gif().toBuffer();
 const ids=['f'+'a'.repeat(32),'f'+'b'.repeat(32)];
 const metas=await Promise.all([[png,'图片.png'],[gif,'表情.gif']].map(([b,name],i)=>storeInboundFile(ids[i],name,async()=>b,{source,root,originals})));
 for(const [i,b]of [png,gif].entries())assert.deepEqual(fs.readFileSync(metas[i].original),b);
 // Simulate an older material cache that finished without an image preview.
 fs.mkdirSync(join(folder,ids[1]),{recursive:true});fs.writeFileSync(join(folder,ids[1],'README.md'),'这种格式没有转成文字。');
 const records=ids.map(id=>'资料编号 '+id).join('\n');await materializeInboundFiles(records,folder,{source,root});
 for(const id of ids){const bytes=fs.readFileSync(join(folder,id,'image.bin'));assert.ok(bytes.length<=2*1024*1024);assert.equal(fs.readFileSync(join(folder,id,'image-type'),'utf8'),'image/jpeg');assert.equal((await sharp(bytes).metadata()).format,'jpeg');assert.match(fs.readFileSync(join(folder,id,'README.md'),'utf8'),/图片已附到本轮/u);}
 // The new completion marker prevents re-decoding on later turns.
 fs.unlinkSync(metas[1].original);await materializeInboundFiles(records,folder,{source,root});assert.ok(fs.existsSync(join(folder,ids[1],'image.bin')));
});
test('unreadable pictures preserve readable failure and avoid repeated conversion attempts',async t=>{
 const dir=fs.mkdtempSync(join(os.tmpdir(),'wecom-bad-preview-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const root=join(dir,'store'),folder=join(dir,'materials'),id='f'+'c'.repeat(32);
 await storeInboundFile(id,'broken.png',async()=>Buffer.from('not a picture'),{source,root,originals:join(dir,'originals')});await materializeInboundFiles('资料编号 '+id,folder,{source,root});
 assert.equal(fs.existsSync(join(folder,id,'image.bin')),false);assert.ok(fs.existsSync(join(folder,id,'image-preparation-v1')));assert.match(fs.readFileSync(join(folder,id,'README.md'),'utf8'),/原文件/u);
});
test('text-only card sections use documented quote area and survive Relay reconstruction alongside menu instructions',async()=>{
 const input=parseRichAction('/消息卡片 '+JSON.stringify({title:'构建',summary:'已完成',url:'https://example.com/build',sections:[{title:'测试',text:'全部通过'},{title:'部署',text:'等待确认'}],buttons:[{title:'重查',prompt:'查询我的构建状态'}]}));
 assert.equal(input.card.card_type,'text_notice');assert.equal(input.card.vertical_content_list,undefined);assert.match(input.card.quote_area.quote_text,/测试：全部通过/u);assert.match(input.card.quote_area.quote_text,/重查：查询我的构建状态/u);assert.match(richActionSummary(input),/部署：等待确认/u);
 let sent;await sendRichAction({store:{rememberShortcut:async()=>{}},transport:{sendCard:async(s,c)=>{sent=c;return 'delivered';}}},{...input,source:'s',owner:'o',requestId:'r'},{generation:'g'},AbortSignal.timeout(1000));
 assert.equal(sent.vertical_content_list,undefined);assert.match(sent.quote_area.quote_text,/测试：全部通过/u);assert.match(sent.quote_area.quote_text,/菜单指令/u);assert.match(sent.action_menu.action_list[0].key,/^oc-x-/u);
});
test('a scheduler that already read due work cannot notify a manually closed collection',async()=>{
 const finished=[],binding={generation:'g',serverId:'s',humanKey:'h'},svc={abort:new AbortController(),store:{dueInteractions:async()=>[{source:'s',taskId:'p',kind:'close',member:'job'}],claimOnce:async()=>true,card:async()=>({multi:true,deliveryStatus:'delivered',binding}),snapshot:async()=>({binding}),submitCard:async()=>({closed:true,closedReason:'manual',answers:[]}),finishInteractionSchedule:async m=>finished.push(m)},transport:{chatMembers:async()=>{throw Error('must not send notifications for manually closed cards');}}};
 await tickInteractions(svc,Date.now());assert.deepEqual(finished,['job']);
});
