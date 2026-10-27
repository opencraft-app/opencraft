import assert from "node:assert/strict";
import { createServer } from "vite";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const source = `
import React from 'react';
import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
import {SettingsPanel,SettingsGroup,SettingsRow,SettingsSection,SettingsTextInput,SettingsActions} from '/packages/extension-react/src/index.ts';
import {AppShell} from '/apps/workbench-web/src/components/app-shell.tsx';
import {buildOpenCraftThemeCssProperties} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
window.setSpacingTheme=theme=>{for(const [key,value] of Object.entries(buildOpenCraftThemeCssProperties(theme))) document.documentElement.style.setProperty(key,value);document.documentElement.dataset.theme=theme;};
window.setSpacingTheme('light');
function Demo(){
 return <AppShell layoutScope="settings" sidebarOpen={false} sidebarWidth={310}
 sidebarCollapsible={false} sidebarResizable={false} sidebarTransientEnabled={false}
 windowChrome={{kind:'browser',platform:'linux',safeArea:{left:0,right:0}}}
 onSidebarCollapse={()=>{}} onSidebarExpand={()=>{}} onSidebarResizeEnd={()=>{}} onRightPanelOpenChange={()=>{}}
 rightPanelOpen={false} rightPanelFullWidth={false} rightPanel={null} header={null} floatingSidebarHeader={()=>null}
 leftPanel={null}>
 <section className="settings-page">
 <input aria-label="Draft" defaultValue=""/>
 <SettingsSection title="Page card"><SettingsGroup data-testid="page-card"><SettingsRow label="Page label">Value</SettingsRow></SettingsGroup></SettingsSection>
 <SettingsPanel title="Utility panel">
 <SettingsSection title="Utility card"><SettingsGroup data-testid="utility-card"><SettingsRow label="Card label">Value</SettingsRow><SettingsRow layout="stacked" label="Stacked label">Long content</SettingsRow></SettingsGroup></SettingsSection>
 <SettingsActions data-testid="between-actions"><button>Section action</button></SettingsActions>
 <SettingsSection title="Following section" data-testid="following-section"><p>Content</p></SettingsSection>
 <SettingsGroup appearance="plain" data-testid="plain-group"><SettingsRow label="Plain label">Value</SettingsRow></SettingsGroup>
 <div className="settings-panel-form" data-testid="compact-form"><SettingsRow label="Form label"><SettingsTextInput aria-label="Form input"/></SettingsRow></div>
 </SettingsPanel>
 </section></AppShell>;
}
createRoot(document.getElementById('root')).render(<Demo/>);`;
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{
  name: "settings-navigation-smoke", resolveId: id => id === "/probe.tsx" ? id : null, load: id => id === "/probe.tsx" ? source : null,
  configureServer(server) { server.middlewares.use((request, response, next) => {
    if (request.url !== "/") return next();
    response.setHeader("content-type", "text/html");
    response.end('<div id="root"></div><script type="module" src="/probe.tsx"></script>');
  }); },
}] });
let browser: any;
try {
  await vite.listen();
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE, args: ["--no-sandbox"] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors: string[] = []; page.on("pageerror", (error: Error) => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  await page.getByRole('textbox', { name: 'Draft', exact: true }).fill('retained draft');
  for (const width of [390, 1280]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => (window as any).setSpacingTheme(theme), theme);
    assert.equal(await page.getByRole('textbox', { name: 'Draft', exact: true }).inputValue(), 'retained draft');
    if (process.env.OPENCRAFT_SETTINGS_SPACING_NEGATIVE_CONTROL) await page.addStyleTag({ content: '.settings-panel .settings-control-row { padding-inline: 0; }' });
    const metrics = await page.evaluate(() => {
      const expected = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--spacing')) * 4;
      const rows = Array.from(document.querySelectorAll('[data-testid="page-card"] > .settings-control-row, [data-testid="utility-card"] > .settings-control-row')).map(row => {
        const style = getComputedStyle(row), box = row.getBoundingClientRect();
        const label = row.querySelector('.settings-control-row__copy')!.getBoundingClientRect(), value = row.querySelector('.settings-control-row__value')!.getBoundingClientRect();
        const separator = getComputedStyle(row, '::after');
        return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight), labelInset: label.left - box.left,
          valueInset: box.right - value.right, gap: row.classList.contains('settings-control-row--stacked') ? value.top - label.bottom : Math.max(value.left - label.right, value.top - label.bottom),
          separatorInset: separator.content !== 'none' ? parseFloat(separator.left) : null };
      });
      const plain = document.querySelector('[data-testid="plain-group"] > .settings-control-row')!, form = document.querySelector('[data-testid="compact-form"] > .settings-control-row')!;
      const body = document.querySelector('.settings-panel__body')!;
      const following = document.querySelector('[data-testid="following-section"]')!, actions = document.querySelector('[data-testid="between-actions"]')!;
      return { expected, rows, top: parseFloat(getComputedStyle(body).paddingTop), bottom: parseFloat(getComputedStyle(body).paddingBottom),
        sectionGap: following.getBoundingClientRect().top - actions.getBoundingClientRect().bottom,
        expectedSectionGap: parseFloat(getComputedStyle(body).getPropertyValue('--gap-token-settings-sections')),
        plainInset: getComputedStyle(plain).paddingLeft, formInset: getComputedStyle(form).paddingLeft };
    });
    assert.equal(metrics.rows.length, 3);
    assert.ok(metrics.top >= metrics.expected && metrics.bottom >= metrics.expected, 'panel body keeps vertical breathing room');
    assert.equal(metrics.sectionGap, metrics.expectedSectionGap, 'actions between sections preserve section spacing');
    for (const row of metrics.rows) {
      assert.equal(row.left, metrics.expected, 'composed card left inset');
      assert.equal(row.right, metrics.expected, 'composed card right inset');
      assert.ok(row.labelInset >= metrics.expected - 1 && row.valueInset >= metrics.expected - 1);
      assert.ok(row.gap > 0, 'label and value spacing');
      if (row.separatorInset !== null) assert.equal(row.separatorInset, metrics.expected);
    }
    assert.equal(metrics.plainInset, '0px', 'explicit plain group stays flush');
    assert.equal(metrics.formInset, '0px', 'explicit compact form stays flush');
  }
  assert.deepEqual(errors, []);
  console.log("Settings shell passed: page and utility card insets, stacked gaps, plain/form opt-outs, retained draft across narrow/wide themes.");
} finally { await browser?.close(); await vite.close(); }
