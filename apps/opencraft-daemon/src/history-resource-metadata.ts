import { readFile } from "node:fs/promises";

type PsiStats = { someAvg10: number | null; someAvg60: number | null; someAvg300: number | null; fullAvg10: number | null; fullAvg60: number | null; fullAvg300: number | null };
export type HistoryResourceMetadata = {
  status: "captured" | "unavailable";
  loadAvg1m: number | null; loadAvg5m: number | null; loadAvg15m: number | null;
  cpuPsi: PsiStats; ioPsi: PsiStats; memoryPsi: PsiStats;
};
const emptyPsi = (): PsiStats => ({ someAvg10: null, someAvg60: null, someAvg300: null, fullAvg10: null, fullAvg60: null, fullAvg300: null });
function parsePsi(text: string): PsiStats {
  const result = emptyPsi();
  for (const line of text.split("\n")) {
    const [, kind, values] = /^(some|full)\s+(.+)$/.exec(line.trim()) ?? [];
    if (!kind || !values) continue;
    const fields = new Map(values.split(/\s+/).map(field => field.split("=")).filter(pair => pair.length === 2).map(([key, value]) => [key!, Number(value)]));
    const prefix = kind === "some" ? "some" : "full";
    for (const interval of [10, 60, 300] as const) {
      const value = fields.get(`avg${interval}`);
      if (value !== undefined && Number.isFinite(value)) result[`${prefix}Avg${interval}`] = value;
    }
  }
  return result;
}
/** Capture only fixed-key, low-cardinality proc aggregates; never retain raw proc text. */
export async function readHistoryResourceMetadata(procRoot = "/proc"): Promise<HistoryResourceMetadata> {
  const [load, cpu, io, memory] = await Promise.allSettled([
    readFile(`${procRoot}/loadavg`, "utf8"), readFile(`${procRoot}/pressure/cpu`, "utf8"),
    readFile(`${procRoot}/pressure/io`, "utf8"), readFile(`${procRoot}/pressure/memory`, "utf8"),
  ]);
  const loadFields = load.status === "fulfilled" ? load.value.trim().split(/\s+/).slice(0, 3).map(Number) : [];
  const validLoad = (index: number) => Number.isFinite(loadFields[index]) ? loadFields[index]! : null;
  return { status: [load, cpu, io, memory].every(value => value.status === "fulfilled") ? "captured" : "unavailable",
    loadAvg1m: validLoad(0), loadAvg5m: validLoad(1), loadAvg15m: validLoad(2),
    cpuPsi: cpu.status === "fulfilled" ? parsePsi(cpu.value) : emptyPsi(),
    ioPsi: io.status === "fulfilled" ? parsePsi(io.value) : emptyPsi(),
    memoryPsi: memory.status === "fulfilled" ? parsePsi(memory.value) : emptyPsi() };
}
