import test from 'node:test';
import assert from 'node:assert/strict';
import { reportCard, parseReport, reportSummary } from '../../plugins/wecom/report-card.mjs';
import { MirrorService } from '../../plugins/wecom/mirror/service.mjs';
import { Readable } from 'node:stream';
test('report card preserves title, numbers, image and real details URL',()=>{
  const report={title:'构建日报',summary:'全部通过',url:'https://example.com/build/123',imageUrl:'https://example.com/build.png',metrics:[{label:'成功',value:'12'}]};
  const card=reportCard(parseReport('/图文 '+JSON.stringify(report)));
  assert.equal(card.card_type,'news_notice');assert.equal(card.card_image.url,report.imageUrl);
  assert.deepEqual(card.horizontal_content_list,[{keyname:'成功',value:'12'}]);
  assert.equal(card.jump_list[0].title,'查看详情');assert.equal(card.card_action.url,report.url);
  assert.match(reportSummary(report),/成功：12/u);
  assert.equal(reportCard({...report,imageUrl:undefined}).card_type,'text_notice');
});
test('relay delivers cards and a 20 MiB file only to the bound source',async()=>{
  const sent=[];
  const service=new MirrorService({store:{snapshot:async source=>({binding:{serverId:source==='room'?'one':'other'}})},
    transport:{subscribe:()=>()=>{},sendCard:async(source,card)=>{sent.push(card);return 'delivered';},
      sendFile:async(source,name,bytes)=>{sent.push(bytes.length);return 'delivered';}},
    servers:[{id:'one',name:'One',credential:'c'.repeat(43)}],corpId:'wxfixture'});
  service.authenticate=()=>service.servers.get('one');
  const send=async(action,body)=>{
    const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),{method:'POST',url:'/__opencraft_wecom_mirror/'+action});
    const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};
    await service.handle(req,res);return res;
  };
  const report={title:'日报',url:'https://example.com/report',imageUrl:'https://example.com/pic.png'};
  assert.equal((await send('report',{source:'room',report})).status,200);
  assert.equal(sent[0].card_type,'news_notice');
  assert.equal((await send('report',{source:'private',report})).status,403);
  const bytes=Buffer.alloc(20*1024*1024,1).toString('base64');
  assert.equal((await send('file-send',{source:'room',name:'report.pdf',bytes})).status,200);
  assert.equal(sent[1],20*1024*1024);
  assert.equal((await send('file-send',{source:'private',name:'report.pdf',bytes})).status,403);
  assert.equal(sent.length,2);
});
test('normal replies are unchanged and invalid card actions/URLs are rejected',()=>{
  assert.equal(parseReport('普通消息'),null);
  for(const extra of [{url:'javascript:alert(1)'},{url:'https://user:secret@example.com'},{action_menu:{}},{metrics:Array(7).fill({label:'x',value:'1'})}])
    assert.throws(()=>reportCard({title:'日报',url:'https://example.com',...extra}));
});
