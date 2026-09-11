import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve('public/lightvela-intl-home');
const fragments = readdirSync(root).filter((file) => /^index-fragment(?:\.[\w-]+)?\.html$/.test(file));
const introByLocale = {
  "en-US": "Install templates directly from the library. Notification and script tasks consume no tokens.",
  "zh-CN": "有模版库，直接装。通知任务&脚本任务无需消耗任何token。",
  "zh-SG": "有模版库，直接装。通知任务&脚本任务无需消耗任何token。",
  "zh-Hant": "有模版庫，直接裝。通知任務&腳本任務無需消耗任何token。",
  "id-ID": "Pasang template langsung dari pustaka. Tugas notifikasi dan skrip tidak mengonsumsi token.",
  "es": "Instala plantillas directamente desde la biblioteca. Las tareas de notificación y de scripts no consumen tokens.",
  "ja-JP": "ライブラリからテンプレートを直接インストール。通知タスクとスクリプトタスクはトークンを消費しません。",
  "ko-KR": "라이브러리에서 템플릿을 바로 설치하세요. 알림 및 스크립트 작업은 토큰을 소비하지 않습니다."
};

describe('homepage play tab badges', () => {
  it.each(['public/lightvela-intl-home/style.css', 'scripts/import-international-homepage.mjs'])('shares the Harness selected badge style in %s', (file) => {
    const source = readFileSync(path.resolve(file), 'utf8');
    const harnessSelector = "#lightvela-intl-home #pl-4:checked ~ .plays__tabs label[for='pl-4'] .play__new-badge";
    const rules = Array.from(source.matchAll(/([^{}]+)\{([^{}]*)\}/g));
    const rule = rules.find((match) => match[1].includes(harnessSelector));
    for (const id of ['pl-2', 'pl-3', 'pl-4']) {
      expect(rule?.[1]).toContain(`#lightvela-intl-home #${id}:checked ~ .plays__tabs label[for='${id}'] .play__new-badge`);
    }
    expect(rule?.[2]).toContain('background: rgba(255, 255, 255, 0.18);');
    expect(rule?.[2]).toContain('color: #fff;');
  });
  it.each(fragments)('shows the notification and script token explanation in %s', (file) => {
    const locale = file.match(/^index-fragment\.([\w-]+)\.html$/)?.[1] ?? 'en-US';
    const page = new DOMParser().parseFromString(readFileSync(path.join(root, file), 'utf8'), 'text/html');
    expect(page.querySelector('#play-2 .play__text > p')?.textContent).toBe(introByLocale[locale as keyof typeof introByLocale]);
  });
  it.each(fragments)('preserves the three tabs and adds the requested badges in %s', (file) => {
    const page = new DOMParser().parseFromString(readFileSync(path.join(root, file), 'utf8'), 'text/html');
    const tabs = page.querySelector('.plays__tabs');
    expect(tabs?.querySelectorAll('label')).toHaveLength(3);
    for (const [id, text] of [['pl-2', '0 Token'], ['pl-3', 'New'], ['pl-4', 'New']]) {
      const badges = tabs?.querySelectorAll(`label[for="${id}"] .play__new-badge`);
      expect(badges).toHaveLength(1);
      expect(badges?.[0].textContent).toBe(text);
    }
  });
});
