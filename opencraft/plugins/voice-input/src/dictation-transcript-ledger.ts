import type { NativeSpeechUtterance } from "@opencraft/app-host-protocol";

/** Codex-style ordered final results; hypotheses never enter confirmed history. */
export class DictationTranscriptLedger {
  private readonly entries = new Map<string, NativeSpeechUtterance>();
  private result: string | null = null;
  accept(frame: NativeSpeechUtterance): void {
    if (this.result !== null) throw new Error("听写会话已经结束");
    if (!/^[A-Za-z0-9-]{1,128}$/.test(frame.utteranceId) || !Number.isSafeInteger(frame.sequence) || frame.sequence < 1
      || !["partial", "final"].includes(frame.phase) || typeof frame.text !== "string" || frame.text.length > 100000) throw new Error("无效的听写片段");
    const previous = this.entries.get(frame.utteranceId);
    if (previous && (frame.sequence <= previous.sequence || (previous.phase === "final" && frame.phase === "partial"))) return;
    if (!previous && this.entries.size >= 1024) throw new Error("听写片段超过会话上限，请结束本次输入");
    const next = { ...frame, text: frame.phase === "final" ? frame.text : "" };
    let size = next.text.length;
    for (const entry of this.entries.values()) if (entry.utteranceId !== next.utteranceId) size += entry.text.length;
    if (size > 1024 * 1024) throw new Error("听写文本超过会话上限，请结束本次输入");
    this.entries.set(next.utteranceId, next);
  }
  finish(): string {
    if (this.result !== null) return this.result;
    if ([...this.entries.values()].some(entry => entry.phase !== "final")) throw new Error("听写片段尚未确认，不能提交");
    this.result = [...this.entries.values()].map(entry => entry.text).filter(Boolean).join(" ").trim();
    return this.result;
  }
}
