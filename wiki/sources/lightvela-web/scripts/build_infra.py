#!/usr/bin/env python3
"""适配用户提供的8页HTML；保留SVG、ACTS、分段时序与事实标注。"""
from pathlib import Path
import re
import json
import hashlib

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'sources/infra/agent-stability-original.html'
OUT = ROOT / 'src/data/infra-template.html'

# 将深色背景、浅色正文和语义高亮一起换色，状态仍有红/绿/琥珀区分。
PALETTE = {
    '#0a0e16': '#ffffff', '#111827': '#f5f5f7', '#0f1623': '#fafafd', '#04060a': '#ffffff',
    '#13233d': '#f2edff', '#1a1433': '#ffffff', '#243044': '#d9dce5',
    '#e6edf7': '#1d1d1f', '#8b98ad': '#6e707b', '#c7d2e3': '#424653', '#5b6b85': '#787e8e',
    '#38bdf8': '#6842ff', '#34d399': '#17805b', '#fbbf24': '#956009', '#f87171': '#ce3450',
    '#a78bfa': '#7651d9', '#f472b6': '#b14885', '#c4b5fd': '#6842ff', '#a3e635': '#17805b',
    '#0d1420': '#ffffff', '#1e4a63': '#b9a9eb', '#2a1414': '#fff0f2', '#5c2424': '#e6abb8',
    '#0b111c': '#ffffff', '#0f1d2c': '#f3efff', '#0f2a22': '#eaf6ef', '#1d5443': '#a9cfb9',
    '#2c3a52': '#ccd2de', '#0e1522': '#fafafd', '#221c46': '#ede7fb', '#2a1730': '#f9edf4',
    '#0b1a14': '#edf8f1', '#141a26': '#f5f5f7', '#3f4b63': '#c5cbd9', '#05080d': '#f5f5f7',
    '#334155': '#a4adbd', '#1f1a0c': '#fff7e7', '#5c4a17': '#d4bc89', '#1b2433': '#e9eaf0',
    '#3a4a64': '#c8cedb', '#1a0f12': '#fff1f4', '#0d1726': '#f2effb', '#0c1f1a': '#edf8f2',
    '#151530': '#f3efff', '#161a33': '#f1eef8', '#101826': '#f5f5f7', '#101d2e': '#f5f1ff',
    '#1c1709': '#fff7e8', '#1d1838': '#f1ebff', '#120d2a': '#ffffff', '#231d0b': '#fff8e9',
    '#475569': '#b4bdcd', '#141127': '#f6f2ff', '#2c2650': '#d1c5ea', '#1f2a3b': '#e5e5ea',
    '#3a4558': '#b6bdcd', '#10141c': '#f3f3f6', '#55627a': '#9299a8', '#4b5568': '#9da5b5',
    '#7dd3fc': '#8b6de2', '#fde2e2': '#a8273f', '#2a2210': '#fff5e1', '#4b5b75': '#a6adbc',
    '#06121c': '#ffffff', '#052016': '#ffffff', '#06231a': '#ffffff',
}

BRIDGE = r'''
  // 集成模式只开放演示导航，不开放主站DOM、凭据或网络。
  const send = (action, extra = {}) => parent.postMessage({ type: 'lightvela-infra', token: EMBED.token, action, ...extra }, EMBED.parentOrigin);
  const next = () => send('navigate', { delta: 1 });
  const prev = () => send('navigate', { delta: -1 });
  const advance = () => { players[cur].advance(); syncHint(); };
  const replay = () => { players[cur].play(undefined, { now: true }); syncHint(); };
  const toggleMode = () => { setMode(!MANUAL); players[cur].play(); syncHint(); send('mode', { manual: MANUAL }); };
  const blur = (e) => e.currentTarget.blur();
  document.getElementById('prev').addEventListener('click', (e) => { blur(e); prev(); });
  document.getElementById('next').addEventListener('click', (e) => { blur(e); next(); });
  stepBtn.addEventListener('click', (e) => { blur(e); advance(); });
  modeBtn.addEventListener('click', (e) => { blur(e); toggleMode(); });
  slides.forEach((s, i) => {
    const rb = s.querySelector('.replay');
    if (rb) rb.addEventListener('click', (e) => { blur(e); replay(); });
    s.querySelectorAll('.tabs button').forEach((b, k) => b.addEventListener('click', (e) => { blur(e); players[i].play(k, { now: true }); syncHint(); }));
  });
  deck.addEventListener('click', (e) => { if (MANUAL && !e.target.closest('button')) advance(); });
  addEventListener('keydown', (e) => {
    if (EMBED.static || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target instanceof Element && e.target.closest('button') && ['Enter', ' '].includes(e.key)) return;
    const k = e.key;
    if (['ArrowRight', 'ArrowDown', 'PageDown', 'Enter'].includes(k) || (k === ' ' && !e.shiftKey)) { e.preventDefault(); next(); }
    else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k) || (k === ' ' && e.shiftKey)) { e.preventDefault(); prev(); }
    else if (k === 'Home') { e.preventDefault(); send('edge', { edge: 'first' }); }
    else if (k === 'End') { e.preventDefault(); send('edge', { edge: 'last' }); }
    else if (k.toLowerCase() === 'r') { e.preventDefault(); replay(); }
    else if (k.toLowerCase() === 'm') { e.preventDefault(); toggleMode(); }
    else if (k.toLowerCase() === 'n') { e.preventDefault(); advance(); }
    else if (['f', 'c', 'g', '?', 'Escape'].includes(k)) { e.preventDefault(); send('key', { key: k }); }
  });
  addEventListener('message', (e) => {
    if (e.source !== parent || e.origin !== EMBED.parentOrigin || !e.data || e.data.token !== EMBED.token || e.data.type !== 'lightvela-infra-control') return;
    const action = e.data.action;
    if (action === 'pause') { players.forEach(p => p.reset()); document.documentElement.classList.add('paused'); }
    if (action === 'resume') { document.documentElement.classList.remove('paused'); players[cur].play(); }
    if (EMBED.static) return;
    if (action === 'advance') advance();
    if (action === 'replay') replay();
    if (action === 'mode') toggleMode();
  });
  let wheelLock = 0;
  addEventListener('wheel', (e) => {
    if (EMBED.static) return;
    const d = Math.abs(e.deltaY) >= Math.abs(e.deltaX) ? e.deltaY : e.deltaX;
    if (Math.abs(d) < 12 || Date.now() < wheelLock) return;
    wheelLock = Date.now() + 900; if (d > 0) next(); else prev();
  }, { passive: true });
  let tx = null;
  addEventListener('touchstart', (e) => { tx = e.touches[0].clientX; }, { passive: true });
  addEventListener('touchend', (e) => {
    if (tx === null || EMBED.static) return;
    const dx = e.changedTouches[0].clientX - tx; tx = null;
    if (Math.abs(dx) > 50) { if (dx < 0) next(); else prev(); }
  }, { passive: true });
  addEventListener('pagehide', () => players.forEach(p => p.reset()));
  setMode(!STATIC && !!EMBED.manual);
  go(EMBED.pageIndex);
  send('ready', { pageIndex: cur });
'''

STYLE = r'''
  /* LightVela白底适配；不改变原SVG图元几何或动画时序。 */
  html, body, .deck { background: #fff; }
  .grad { background: none; color: var(--cyan); }
  .kicker { color: #6842ff; letter-spacing: .08em; }
  .deck::before { content: ''; position: absolute; left: 50px; top: 23px; width: 1500px; border-top: 1px solid #e5e5ea; }
  .deck::after { content: ''; position: absolute; left: 950px; top: 23px; width: 300px; border-top: 3px solid #6842ff; }
  .slide { padding-top: 48px; }
  .tabs button.on { color: #fff; }
  .replay { color: #6842ff; }
  .ctrl { right: 185px; bottom: 24px; }
  #prev, #next, #pg, .prog { display: none; }
  .embed-footer { position: absolute; left: 1475px; bottom: 20px; width: 78px; text-align: right; font-size: 15px; color: #777b89; z-index: 6; }
  .foot { max-width: 1000px; color: #6e707b; }
  .cap { font-size: 18px; flex-wrap: wrap; max-width: 1280px; gap: 5px 9px; }
  .ctrl .stepbtn-wait, .ctrl #stepBtn.wait { color: #956009; }
  .paused *, .paused *::before, .paused *::after { animation-play-state: paused !important; }
  .static .ctrl, .static .replay { display: none; }
  .static body { pointer-events: none; }
  .cmp { background: #fafafd; }
'''


def build():
    original = SOURCE.read_text()
    assert len(re.findall(r'<section class="slide', original)) == 8
    source = re.sub(r'#[0-9a-fA-F]{6}\b', lambda m: PALETTE.get(m.group().lower(), m.group()), original)
    source = source.replace('rgba(52,211,153,', 'rgba(23,128,91,').replace('rgba(251,191,36,', 'rgba(149,96,9,').replace('rgba(167,139,250,', 'rgba(118,81,217,')
    csp = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; connect-src \'none\'; base-uri \'none\'; form-action \'none\'">'
    source = source.replace('<meta charset="UTF-8">', '<meta charset="UTF-8">\n' + csp)
    source = source.replace('</style>', STYLE + '\n</style>', 1)
    source = source.replace("const STATIC = /[?&]static\\b/.test(location.search);", 'const EMBED = __LV_EMBED_CONFIG__;\n  const STATIC = !!EMBED.static;')
    source = source.replace("try { localStorage.setItem('deck-mode', manual ? 'manual' : 'auto'); } catch (_) {}", '')
    source = source.replace("history.replaceState(null, '', location.search + '#' + n);", '')
    start = source.index('  // 键盘、滚轮、‹ › 只负责翻页')
    end = source.index('\n})();', start)
    source = source[:start] + BRIDGE + source[end:]
    source = source.replace("const pg = document.getElementById('pg'), prog = document.getElementById('prog');", "const pg = document.getElementById('pg'), prog = document.getElementById('prog');\n  const globalFooter = document.createElement('div'); globalFooter.className = 'embed-footer'; globalFooter.textContent = String(EMBED.number).padStart(2, '0') + ' / ' + EMBED.total; deck.appendChild(globalFooter);")
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(source)
    # 外部素材文件保留为可生成资产，正文实际通过srcDoc安全隔离。
    titles = ['让 Agent 弄坏的只是可替换的部分', '现状与风险：Agent 能弄坏整台 VM', '缩小破坏范围，坏了能恢复', '方案一：单 VM + Sandbox', '方案二：大脑与工作台分离', '预热：换机恢复，目标最快约 10 秒', '两套方案对比：各有取舍', '管家 Agent：已跑通 POC']
    metadata = {'sourceSha256': hashlib.sha256(SOURCE.read_bytes()).hexdigest(), 'pageCount': 8, 'titles': titles}
    (ROOT / 'sources/infra/metadata.json').write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + '\n')
    # 提取动画脚本给node --check，运行时无需此副本。
    print('已保留8页、原ACTS及SVG动画，生成白底隔离模板。')

if __name__ == '__main__':
    build()
