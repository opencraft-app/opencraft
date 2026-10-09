'use client';

import { useEffect, useState } from 'react';
import { Bot, CalendarClock, LayoutGrid, MessageSquare, Plus, Settings, Sparkles } from 'lucide-react';

import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useCurrentLocale } from '@/i18n/t';
import { DEFAULT_HERMES_APPEARANCE, parseHermesAppearance, type HermesAppearance } from '@/lib/hermes-appearance';
import { HermesAppearanceAvatar, HermesStepDressup } from '@/pages/marketing/agent-dressup-studio';

const PREVIEW_KEY = 'lightvela:hermes-studio-preview:v1';
const NAV = [[LayoutGrid, '总览'], [MessageSquare, '对话'], [Sparkles, '技能'], [CalendarClock, '定时任务'], [Settings, '设置']] as const;

/** A stand-in for the console, so the creation popup is judged in the place it really appears. */
function ConsoleBackdrop({ appearance, botName, onCreate }: { appearance: HermesAppearance; botName: string | null; onCreate: () => void }) {
  return <div className="flex min-h-dvh bg-[#f6f5f9] text-[#292638]">
    <aside className="hidden w-56 shrink-0 flex-col border-r border-[#e9e6f0] bg-white px-3 py-4 md:flex">
      <p className="px-2 text-base font-semibold">LightVela</p>
      <nav className="mt-5 space-y-1">
        {NAV.map(([Icon, text], index) => <div key={text} className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm ${index === 0 ? 'bg-[#f1ecff] font-medium text-[#6a47d6]' : 'text-[#6c677d]'}`}><Icon size={16} />{text}</div>)}
      </nav>
      <p className="mt-6 px-2.5 text-xs text-[#9b95aa]">我的 Bot</p>
      <div className="mt-2 space-y-1">
        {botName ? <div className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm"><HermesAppearanceAvatar appearance={appearance} size={28} /><span className="truncate">{botName}</span></div> : <div className="px-2.5 py-1.5 text-sm text-[#b4aebf]">还没有 Bot</div>}
      </div>
    </aside>
    <main className="min-w-0 flex-1 px-5 py-5 md:px-8">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Bot 总览</h2>
        <button type="button" onClick={onCreate} className="flex min-h-10 cursor-pointer items-center gap-1.5 rounded-xl bg-[#7150da] px-4 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500"><Plus size={16} />创建 Bot</button>
      </div>
      <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2].map((item) => <div key={item} className="rounded-2xl border border-[#e9e6f0] bg-white p-4">
          <div className="flex items-center gap-3"><Bot size={20} className="text-[#b9b2c9]" /><div className="h-3 w-24 rounded-full bg-[#ece9f3]" /></div>
          <div className="mt-4 h-2.5 w-full rounded-full bg-[#f1eff6]" /><div className="mt-2 h-2.5 w-2/3 rounded-full bg-[#f1eff6]" />
        </div>)}
      </div>
    </main>
  </div>;
}

export function AgentDressupPreview() {
  const zh = useCurrentLocale().startsWith('zh');
  const [appearance, setAppearance] = useState<HermesAppearance>(DEFAULT_HERMES_APPEARANCE);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ready, setReady] = useState(false);
  const [created, setCreated] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(true);
  const [storageError, setStorageError] = useState(false);
  useEffect(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(PREVIEW_KEY) || 'null');
      if (saved && typeof saved === 'object') {
        const record = saved as Record<string, unknown>;
        const parsed = parseHermesAppearance(record.appearance);
        if (parsed) setAppearance(parsed);
        if (typeof record.name === 'string') setName(record.name);
        if (typeof record.description === 'string') setDescription(record.description);
        setCreated(record.created === true);
      }
    } catch { /* Invalid or unavailable local preview storage never blocks creation. */ }
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try { localStorage.setItem(PREVIEW_KEY, JSON.stringify({ appearance, name, description, created })); setStorageError(false); }
    catch { setStorageError(true); }
  }, [appearance, name, description, created, ready]);
  return <>
    <ConsoleBackdrop appearance={appearance} botName={created ? name : null} onCreate={() => { setCreated(false); setDialogOpen(true); }} />
    {/* Creation remains required; after creating, the preview can close to show the console backdrop. */}
    <Dialog open={dialogOpen} onOpenChange={(open) => { if (created) setDialogOpen(open); }}>
      <DialogContent closeLabel={zh ? '关闭' : 'Close'}
        className={`max-h-[92dvh] overflow-y-auto rounded-3xl px-6 pb-6 pt-7 outline-none focus:outline-none focus-visible:outline-none ${created ? '' : '[&>button]:hidden'} ${created ? 'md:w-[34rem]' : 'md:w-[52rem]'}`}
        onEscapeKeyDown={(event) => { if (!created) event.preventDefault(); }}
        onPointerDownOutside={(event) => { if (!created) event.preventDefault(); }}
        onInteractOutside={(event) => { if (!created) event.preventDefault(); }}
        onOpenAutoFocus={(event) => { event.preventDefault(); (event.currentTarget as HTMLElement).focus(); }}>
        <DialogDescription className="sr-only">{zh ? '选择形象、起个名字，创建你的 Agent。' : 'Pick a look, choose a name, and create your Agent.'}</DialogDescription>
        {created ? <>
          <DialogTitle className="text-2xl font-semibold text-[#242034]">创建完成</DialogTitle>
          <div className="my-6 flex flex-col items-center rounded-2xl bg-[#faf8ff] py-5">
            <HermesAppearanceAvatar appearance={appearance} size={240} alive />
            <p className="text-sm text-[#625c73]">{description || '你的新搭档'}</p>
          </div>
          <div className="flex items-center gap-3 rounded-md border border-[#e9e3f4] p-3">
            <HermesAppearanceAvatar appearance={appearance} size={32} />
            <span className="flex-1 text-sm font-medium">{name}</span><span className="text-xs text-[#736b86]">侧栏效果</span>
          </div>
          <div className="mt-5 flex justify-center">
            <button type="button" className="min-h-11 cursor-pointer rounded-xl bg-[#7150da] px-5 text-sm font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500" onClick={() => setDialogOpen(false)}>开始旅程</button>
          </div>
          {!storageError && <p className="mt-4 text-center text-xs text-[#736b86]" role="status">已保存在本机预览，刷新后仍会保留。</p>}
        </> : <>
          <DialogTitle className="text-2xl font-semibold text-[#242034]">创建你的 Agent</DialogTitle>
          <div className="mt-4 grid gap-x-10 gap-y-5 md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:items-center">
            <HermesStepDressup appearance={appearance} onChange={setAppearance} zh={zh} />
            <div>
              <label className="block text-sm font-medium text-[#514a65]" htmlFor="preview-name">名字</label>
              <input id="preview-name" value={name} onChange={(event) => setName(event.target.value)} placeholder="给 Agent 起个名字" className="mt-2 min-h-11 w-full rounded-xl border border-[#e6e1ed] px-3 outline-none focus:border-violet-500" />
              <label className="mt-4 block text-sm font-medium text-[#514a65]" htmlFor="preview-description">用途 <span className="font-normal text-[#918b9d]">（可选）</span></label>
              <textarea id="preview-description" value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="它可以帮你做什么？" className="mt-2 w-full resize-none rounded-xl border border-[#e6e1ed] px-3 py-2 outline-none focus:border-violet-500" />
              <button type="button" disabled={!name.trim() || !ready} onClick={() => setCreated(true)} className="mt-6 min-h-12 w-full cursor-pointer rounded-xl bg-[#7150da] font-semibold text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-violet-500 disabled:cursor-not-allowed disabled:opacity-40">创建试玩 Agent</button>
            </div>
          </div>
        </>}
        {storageError && <p role="alert" className="mt-3 text-sm text-red-700">浏览器无法保存预览，刷新后可能丢失本次搭配。</p>}
      </DialogContent>
    </Dialog>
  </>;
}
