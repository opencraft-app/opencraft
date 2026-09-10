import { useEffect, useRef, useState } from "react";
import { SettingsButton, SettingsNotice } from "@opencraft/extension-react";
import type { HermesConnectorClient } from "./connector-client";
import { CliAuthTerminal } from "./cli-auth-terminal";

interface Snapshot { id: string; connectorId: string; phase: "running" | "connected" | "failed" | "cancelled"; output: string; outputOffset: number; inputReady: boolean; inputSequence: number; error?: string }
export function CliAuthPanel({ createClient, packageId, name }: {
  createClient(): HermesConnectorClient; packageId: string; name: string;
}) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputQueue = useRef(Promise.resolve());
  const [starting, setStarting] = useState(false);
  const owner = useRef<{client: HermesConnectorClient; id?: string; sequence: number; timer?: ReturnType<typeof setTimeout>; retired: boolean} | null>(null);
  const retire = () => {
    const current = owner.current; owner.current = null;
    if (!current) return;
    current.retired = true; clearTimeout(current.timer);
    if (current.id) {
      const deadline = setTimeout(() => current.client.dispose(), 5000);
      void current.client.request(`/v1/cli-auth/sessions/${current.id}/cancel`, {}).catch(()=>{}).finally(()=>{clearTimeout(deadline);current.client.dispose();});
    } else current.client.dispose();
  };
  useEffect(() => () => retire(), [packageId]);
  const start = async () => {
    retire(); setError(null); setSnapshot(null); setStarting(true); inputQueue.current = Promise.resolve();
    const current = {client: createClient(), sequence: 0, retired: false} as NonNullable<typeof owner.current>;
    owner.current = current;
    const deadline = setTimeout(()=>current.client.dispose(),45000);
    try {
      await current.client.connect();
      const capabilities = await current.client.request<{cliAuthPty?: boolean}>("/v1/capabilities");
      if (!capabilities.cliAuthPty) throw new Error("请先升级 Bot 上的运行服务，以支持 PTY 终端授权。");
      const {instances} = await current.client.request<{instances:{instanceId:string;packageId:string}[]}>("/v1/instances");
      const instance = instances.find(i=>i.packageId===packageId) ?? await current.client.request<{instanceId:string}>("/v1/instances",{packageId,displayName:name,defaultOpen:true});
      const first = await current.client.request<Snapshot>("/v1/cli-auth/sessions",{connectorId:instance.instanceId});
      current.id=first.id;
      current.sequence=first.inputSequence;
      if (current.retired) { await current.client.request(`/v1/cli-auth/sessions/${first.id}/cancel`,{}); return; }
      setSnapshot(first);
      const poll = async () => {
        if (current.retired) return;
        try {
          const next=await current.client.request<Snapshot>(`/v1/cli-auth/sessions/${first.id}`);
          if (current.retired) return;
          setSnapshot(next);
          if(next.phase==="running") current.timer=setTimeout(()=>void poll(),150);
        } catch { if(!current.retired) setError("状态读取失败。可取消后重试；远端授权最长保留 5 分钟。"); }
      };
      current.timer=setTimeout(()=>void poll(),500);
    } catch(e) {
      if (!current.retired) setError(e instanceof Error && e.message.includes("404") ? "当前运行服务版本尚不支持 CLI 输入，请先升级 Sidecar。" : e instanceof Error ? e.message : "无法启动授权");
    } finally {clearTimeout(deadline); if(!current.retired)setStarting(false);}
  };
  const send = (text: string) => {
    const current=owner.current;
    if(!current?.id || !snapshot?.inputReady) return;
    inputQueue.current = inputQueue.current.then(async () => {
    if (current.retired) return;
    try {
      // Bound pasted input; preserve control sequences and exact newlines.
      let chunk = "";
      const flush = async () => { if (!chunk || current.retired) return; await current.client.request(`/v1/cli-auth/sessions/${current.id}/input`,{sequence:current.sequence+1,text:chunk}); current.sequence++; chunk=""; };
      for (const character of text) { chunk += character; if (chunk.length >= 1024) await flush(); }
      await flush();
    } catch {
      // No blind replay: input may already have reached the process.
      if(!current.retired){setError("输入结果未确认。请取消并重新授权，避免重复提交。");retire();setSnapshot(null);}
    }
    });
  };
  const resize = (cols: number, rows: number) => {
    const current = owner.current; if (!current?.id || current.retired) return;
    inputQueue.current = inputQueue.current.then(async () => {
      if (!current.retired) await current.client.request(`/v1/cli-auth/sessions/${current.id}/resize`, {cols, rows});
    }).catch(() => { if (!current.retired) setError("终端尺寸同步失败，请重试授权。"); });
  };
  return <section className="hermes-connectors__cli-auth">
    <p>CLI 在 Bot 的真实终端中运行，支持方向键、密码输入和 Ctrl+C。关闭详情会请求取消；断连时远端最多保留 5 分钟。终端不会转发浏览器 OAuth 回调。</p>
    {error && <SettingsNotice tone="error">{error}</SettingsNotice>}
    {!starting && snapshot?.phase!=="running" && <SettingsButton onClick={()=>void start()}>开始 CLI 授权</SettingsButton>}
    {(starting || snapshot?.phase==="running") && <SettingsButton onClick={()=>{retire();setStarting(false);setSnapshot(null);}}>取消授权</SettingsButton>}
    {starting && <p role="status">正在连接运行服务…</p>}
    {snapshot && <>
      <p role="status">{({running:"授权进程运行中",connected:"授权完成并已连接",failed:"授权未完成",cancelled:"已取消"})[snapshot.phase]}</p>
      <CliAuthTerminal key={snapshot.id} output={snapshot.output} offset={snapshot.outputOffset} ready={snapshot.phase === "running" && snapshot.inputReady} onData={send} onResize={resize} />
      {snapshot.error && <SettingsNotice tone="error">{snapshot.error}</SettingsNotice>}
      <p>回显由 CLI 控制；终端内容可能含敏感信息，请勿分享授权输出。</p>
    </>}
  </section>;
}
