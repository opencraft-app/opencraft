import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

// Run only against an explicitly selected disposable desktop preview.
const endpoint = process.env.OPENCRAFT_CDP_URL;
if (!endpoint) throw new Error("Set OPENCRAFT_CDP_URL to the isolated preview being verified");
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.connectOverCDP(endpoint);
const name = `Catalog smoke ${randomUUID().slice(0,8)}`;
const model = `catalog-sync-${randomUUID().slice(0,8)}`;
try {
  const page = browser.contexts()[0].pages()[0];
  const openChat = async () => {
    await page.getByRole('button',{name:/^(Chat|聊天)$/}).filter({visible:true}).first().click();
    const fresh = page.getByRole('button',{name:/^(New chat|新对话)$/}).filter({visible:true});
    if (await fresh.count()) await fresh.first().click();
  };
  const openSettings = async () => {
    await page.getByRole('button',{name:'Settings',exact:true}).filter({visible:true}).first().click();
    await page.locator('.settings-page__navigation').getByRole('button',{name:'模型服务',exact:true}).click();
  };
  const openModels = async () => { await page.locator('.opencraft-composer-mode--intelligence').filter({visible:true}).first().click(); };
  await openChat(); await openModels();
  await page.locator('.opencraft-composer-selection-menu--intelligence [role=menuitem]').first().waitFor();
  await page.keyboard.press('Escape');
  await openSettings();
  await page.getByRole('button',{name:'添加提供商',exact:true}).filter({visible:true}).click();
  await page.getByRole('textbox',{name:'添加提供商',exact:true}).fill(name);
  await page.getByRole('button',{name:'添加',exact:true}).click();
  await page.getByRole('heading',{name,exact:true}).waitFor();
  await page.getByLabel('API 基础地址（Base URL）',{exact:true}).fill('http://127.0.0.1:1/v1');
  await page.getByLabel('API Key',{exact:true}).fill('synthetic-catalog-only-key');
  await page.getByRole('button',{name:'保存并收起',exact:true}).click();
  await page.locator('#model-service-connection').waitFor({state:'hidden'});
  await page.getByRole('button',{name:'添加模型',exact:true}).click();
  await page.getByRole('textbox',{name:'添加模型',exact:true}).fill(model);
  await page.getByRole('button',{name:'添加',exact:true}).click();
  await page.getByRole('switch',{name:`启用 ${model}`,exact:true}).waitFor();
  await page.getByRole('switch',{name:`启用提供商：${name}`,exact:true}).click();
  await page.getByText('连接已配置 · 已启用',{exact:true}).waitFor();
  await openChat(); await openModels();
  await page.locator('.opencraft-composer-selection-menu--intelligence').getByText(model,{exact:true}).waitFor();
  await page.screenshot({path:'/tmp/opencraft-composer-model-sync.png'});
  await page.keyboard.press('Escape');
  await openSettings();
  const row=page.locator('.model-services__navigation .model-services__provider').filter({hasText:name});
  await row.click({button:'right'});
  await page.getByRole('menuitem',{name:'删除',exact:true}).click();
  await page.getByRole('button',{name:'确认删除',exact:true}).click();
  await row.waitFor({state:'detached'});
  await openChat(); await openModels();
  await page.waitForFunction((id:string)=>![...document.querySelectorAll('.opencraft-composer-selection-menu--intelligence [role=menuitem]')].some(el=>el.textContent?.includes(id)),model);
  assert.equal(await page.locator('.opencraft-composer-selection-menu--intelligence').getByText(model,{exact:true}).count(),0);
  await page.keyboard.press('Escape');
  console.log('Actual desktop Composer: warmed catalog -> configure/add/enable -> model visible -> delete -> model absent. No inference request; synthetic credentials only.');
} finally { await browser.close(); }
