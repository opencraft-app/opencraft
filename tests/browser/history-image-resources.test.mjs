import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium, webkit } from 'playwright';
import { historyPng } from '../fixtures/history-png.ts';

// Isolated real Conversation + projector + Host blob loader. No style/source transforms,
// native history, production credentials or private image fixture is needed.
test('resource image geometry survives loading, failure, retry and responsive layout', { timeout: 180_000 }, async t => {
  const root = fileURLToPath(new URL('../../',import.meta.url));
  const images = [[960,640],[240,960],[48,32],[960,640]].map(([width,height],i)=>({
    id:`image-${i}`,type:'imageGeneration',status:'completed',result:historyPng(width,height).toString('base64'),savedPath:`/native/image-${i}.png`,imageDimensions:{width,height},
  }));
  const turns = [{id:'turn',status:'completed',items:images.flatMap((image,i)=>[
    {id:`text-${i}`,type:'agentMessage',text:`## Image ${i+1}\n\nThis is unchanged conversation content before the image.\n\nThe image uses an authorized resource reference and reserves its intrinsic aspect ratio.`},image,
  ])}];
  let mode='reference',released=false,detailReads=0;
  const pending=new Set();
  const release=()=>{released=true;for(const callback of pending)callback();pending.clear();};
  const defer=callback=>released?callback():pending.add(callback);
  const vite = await createServer({root,configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},
    server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'synthetic-image-fixture',configureServer(server){server.middlewares.use((req,res,next)=>{
      const url=new URL(req.url,'http://fixture');const json=value=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(value));};
      if(url.pathname==='/'){res.setHeader('content-type','text/html');res.end('<script id="opencraft-deployment-config" type="application/json">{"hosts":[],"builtinAgents":false,"hypernode":false,"fileDownloads":true}</script><div id="root"></div><script type="module" src="/tests/fixtures/history-image-resources.tsx"></script>');return;}
      if(url.pathname==='/fixture-history'){mode=url.searchParams.get('mode')??'reference';released=false;detailReads=0;json(turns.map(t=>({...t,items:t.items.map(i=>{
        if(i.type!=='imageGeneration')return i;
        if(mode==='inline'){const{imageDimensions,...item}=i;return item;}
        return {...i,result:null,src:`/delivered/${i.id}`,historyDetail:{cursor:'transcript:fixture:1'}};
      })})));return;}
      if(url.pathname==='/__opencraft_files'){
        assert.equal(url.searchParams.get('hostId'),'fixture');
        const entry=images.find(i=>'/delivered/'+i.id===url.searchParams.get('path'));
        if(!entry||mode==='failure'||mode==='retry'){res.statusCode=404;res.end();return;}
        defer(()=>{if(!res.destroyed){res.setHeader('content-type','image/png');res.end(Buffer.from(entry.result,'base64'));}});return;
      }
      if(url.pathname==='/fixture-detail'){
        detailReads++;const entry=images.find(i=>i.id===url.searchParams.get('item'));
        if(!entry){res.statusCode=404;res.end();return;}
        if(mode==='retry'&&detailReads<=images.length){res.statusCode=503;res.end();return;}
        const{imageDimensions,...item}=entry;defer(()=>json(item));return;
      }
      if(url.pathname==='/release'){release();res.end();return;}
      next();
    });}}]});
  let browser;
  try{
    await vite.listen();const url='http://127.0.0.1:'+vite.httpServer.address().port;
    browser=await (process.env.IMAGE_TEST_BROWSER === 'webkit' ? webkit.launch({headless:true}) : chromium.launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage']}));
    const results=[];
    for(const width of [390,1200])for(const variant of ['reference','inline','failure','retry']){
      const context=await browser.newContext({viewport:{width,height:844},hasTouch:width===390});
      const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.goto(url+'/?mode='+variant);
      await page.waitForFunction(()=>window.fixture?.ready,null,{timeout:90000});
      const geometry=()=>page.evaluate(()=>{
        const s=document.querySelector('.thread-scroll');
        return {top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight,direction:getComputedStyle(s).flexDirection,images:[...document.querySelectorAll('img[alt="Generated image 1"]')].map(e=>{const r=e.getBoundingClientRect();return{width:r.width,height:r.height};}),frames:[...document.querySelectorAll('.thread-generated-image-gallery')].map(e=>{const r=e.getBoundingClientRect();return{width:r.width,height:r.height};})};
      });
      await page.waitForFunction(()=>document.querySelectorAll('.thread-generated-image-gallery').length===4);
      if(variant==='failure'||variant==='retry')await page.waitForFunction(()=>window.fixture.detailReads===4);
      await page.getByRole('textbox',{name:'Draft'}).fill('Keep this unsent draft');
      await page.evaluate(()=>document.fonts.ready);
      await page.waitForTimeout(500);
      // Start at a reading position before triggering image loads. Let the scroll
      // handlers run first so delayed input cannot change the measured anchor.
      await page.locator('.thread-scroll').evaluate(async scroller=>{
        scroller.scrollTo({top:-350,behavior:'instant'});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      });
      const before=await geometry();
      assert.ok(before.top < -100, "exercise a real scrolled-up reading position: "+JSON.stringify(before));
      if(variant==='retry'){
        const buttons=page.getByRole('button',{name:'Try again'});assert.equal(await buttons.count(),4);
        // Programmatic clicks avoid Playwright auto-scrolling the test's anchor.
        await buttons.evaluateAll(elements=>elements.forEach(e=>e.click()));
      }
      await fetch(url+'/release');
      await page.waitForFunction(()=>[...document.querySelectorAll('img[alt="Generated image 1"]')].filter(i=>i.complete&&i.naturalWidth>0).length===4,null,{timeout:30000});
      await page.waitForTimeout(250);
      const after=await geometry();
      t.diagnostic(JSON.stringify({width,variant,before,after,errors}));
      if(variant!=='inline'){
        assert.deepEqual(after.frames,before.frames,`${width}/${variant} image slots must not resize`);
        assert.equal(after.height,before.height,`${width}/${variant} content height`);
        assert.equal(after.top,before.top,`${width}/${variant} scroll anchor`);
      }
      assert.equal(await page.getByRole('textbox',{name:'Draft'}).inputValue(),'Keep this unsent draft');
      assert.ok(await page.getByRole('textbox',{name:'Draft'}).evaluate(e=>e===document.activeElement),'focus remains with composer');
      assert.deepEqual(errors,[]);
      results.push({width,variant,before,after});
      if(variant==='reference'){
        await page.setViewportSize({width:width===390?1200:390,height:844});
        await page.waitForTimeout(200);
        const resized=await geometry();
        assert.ok(resized.frames.every(f=>f.width>0&&f.width<=400&&f.height<=560.1));
        assert.ok(resized.frames.every((f,i)=>Math.abs(f.width/f.height-images[i].imageDimensions.width/images[i].imageDimensions.height)<0.01));
        await page.setViewportSize({width,height:844});
        if(process.env.IMAGE_TEST_SCREENSHOTS)await page.screenshot({path:process.env.IMAGE_TEST_SCREENSHOTS+`/history-image-${process.env.IMAGE_TEST_BROWSER??"chromium"}-${width}.png`});
      }
      await context.close();
    }
    for(const width of [390,1200]){
      const expected=results.find(r=>r.width===width&&r.variant==='inline').after.images;
      for(const actual of results.filter(r=>r.width===width&&r.variant!=='inline'))assert.equal(actual.after.images.length, expected.length);
      for(const actual of results.filter(r=>r.width===width&&r.variant!=='inline'))for(let i=0;i<expected.length;i++){
        assert.ok(Math.abs(actual.after.images[i].width-expected[i].width)<=1/64,'rendered image width is unchanged apart from CSS rounding');
        assert.ok(Math.abs(actual.after.images[i].height-expected[i].height)<=1/64,'rendered image height is unchanged apart from CSS rounding');
      }
    }
    t.diagnostic(JSON.stringify(results));
  }finally{release();await browser?.close();await vite.close();}
});
