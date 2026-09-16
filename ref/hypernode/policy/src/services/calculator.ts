import { Service, type Inject } from "@deepseek-ai/cordis";
import { utf8Decode } from "../runtime/bytes.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  McpServerRegistration,
  McpToolCallResult,
  PendingMcpToolCall,
} from "../types/mcp.ts";

export const CALCULATOR_SERVER_NAME = "hypernode-calculator";
export const CALCULATOR_RESOURCE_URI = "ui://hypernode/calculator.html";
export const CMB_RATE_API_URL = "https://fx.cmbchina.com/api/v1/fx/rate";

type CurrencyCode = "CNY" | "HKD";
type Dependencies = "httpClient" | "mcpRegistry";

interface CmbRateRow {
  ccyNbr?: unknown;
  ccyNbrEng?: unknown;
  rthOfr?: unknown;
  rthBid?: unknown;
  ratDat?: unknown;
  ratTim?: unknown;
}

interface CurrencyConversion {
  sourceAmount: number;
  sourceCurrency: CurrencyCode;
  targetCurrency: CurrencyCode;
  convertedAmount: number;
  bankRateCnyPer100Hkd: number;
  quoteType: "现汇卖出价" | "现汇买入价" | "sameCurrency";
  quotedAt: string | null;
  sourceName: string;
  sourceUrl: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) throw new TypeError(`${label} must be a finite number`);
  return number;
}

function currency(value: unknown, label: string): CurrencyCode {
  if (value === "CNY" || value === "HKD") return value;
  throw new TypeError(`${label} must be CNY or HKD`);
}

function rounded(value: number, digits = 8): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

class ArithmeticParser {
  private offset = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  parse(): number {
    const value = this.expression();
    this.space();
    if (this.offset !== this.source.length) {
      throw new SyntaxError(`unexpected token at position ${this.offset + 1}`);
    }
    if (!Number.isFinite(value)) throw new RangeError("calculation produced a non-finite result");
    return Object.is(value, -0) ? 0 : value;
  }

  private expression(): number {
    let value = this.term();
    while (true) {
      this.space();
      if (this.consume("+")) value += this.term();
      else if (this.consume("-")) value -= this.term();
      else return value;
    }
  }

  private term(): number {
    let value = this.factor();
    while (true) {
      this.space();
      if (this.consume("*")) value *= this.factor();
      else if (this.consume("/")) {
        const divisor = this.factor();
        if (divisor === 0) throw new RangeError("division by zero");
        value /= divisor;
      } else return value;
    }
  }

  private factor(): number {
    this.space();
    if (this.consume("+")) return this.factor();
    if (this.consume("-")) return -this.factor();
    if (this.consume("(")) {
      const value = this.expression();
      this.space();
      if (!this.consume(")")) throw new SyntaxError("missing closing parenthesis");
      return value;
    }
    return this.number();
  }

  private number(): number {
    this.space();
    const rest = this.source.slice(this.offset);
    const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(rest);
    if (match === null) throw new SyntaxError(`expected a number at position ${this.offset + 1}`);
    this.offset += match[0].length;
    return finiteNumber(match[0], "number");
  }

  private consume(token: string): boolean {
    if (!this.source.startsWith(token, this.offset)) return false;
    this.offset += token.length;
    return true;
  }

  private space(): void {
    while (/\s/.test(this.source[this.offset] ?? "")) this.offset += 1;
  }
}

export function evaluateExpression(expression: unknown): number {
  if (typeof expression !== "string" || expression.trim().length === 0) {
    throw new TypeError("expression must be a non-empty string");
  }
  if (expression.length > 200) throw new RangeError("expression is too long");
  return new ArithmeticParser(expression).parse();
}

function hkdRow(payload: unknown): CmbRateRow {
  if (!isRecord(payload) || payload["returnCode"] !== "SUC0000" || !Array.isArray(payload["body"])) {
    throw new Error("招商银行汇率接口返回了无法识别的数据");
  }
  const row = payload["body"].find((candidate) => (
    isRecord(candidate) &&
    (candidate["ccyNbr"] === "港币" || String(candidate["ccyNbrEng"] ?? "").includes("HKD"))
  ));
  if (!isRecord(row)) throw new Error("招商银行汇率接口未返回港币牌价");
  return row;
}

export function convertCmbRate(
  payload: unknown,
  amountValue: unknown,
  fromValue: unknown,
  toValue: unknown,
): CurrencyConversion {
  const amount = finiteNumber(amountValue, "amount");
  if (amount < 0 || amount > 1_000_000_000_000) {
    throw new RangeError("amount must be between 0 and 1,000,000,000,000");
  }
  const from = currency(fromValue, "from");
  const to = currency(toValue, "to");
  if (from === to) {
    return {
      sourceAmount: amount,
      sourceCurrency: from,
      targetCurrency: to,
      convertedAmount: amount,
      bankRateCnyPer100Hkd: 100,
      quoteType: "sameCurrency",
      quotedAt: null,
      sourceName: "招商银行外汇实时汇率",
      sourceUrl: CMB_RATE_API_URL,
    };
  }
  const row = hkdRow(payload);
  const quotedAt = [row.ratDat, row.ratTim]
    .filter((part) => typeof part === "string" && part.length > 0)
    .join(" ") || null;
  if (from === "CNY") {
    const ask = finiteNumber(row.rthOfr, "CMB HKD current exchange selling rate");
    if (ask <= 0) throw new Error("招商银行港币现汇卖出价无效");
    return {
      sourceAmount: amount,
      sourceCurrency: from,
      targetCurrency: to,
      convertedAmount: rounded(amount * 100 / ask),
      bankRateCnyPer100Hkd: ask,
      quoteType: "现汇卖出价",
      quotedAt,
      sourceName: "招商银行外汇实时汇率",
      sourceUrl: CMB_RATE_API_URL,
    };
  }
  const bid = finiteNumber(row.rthBid, "CMB HKD current exchange buying rate");
  if (bid <= 0) throw new Error("招商银行港币现汇买入价无效");
  return {
    sourceAmount: amount,
    sourceCurrency: from,
    targetCurrency: to,
    convertedAmount: rounded(amount * bid / 100),
    bankRateCnyPer100Hkd: bid,
    quoteType: "现汇买入价",
    quotedAt,
    sourceName: "招商银行外汇实时汇率",
    sourceUrl: CMB_RATE_API_URL,
  };
}

function textResult(structuredContent: unknown, text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], structuredContent };
}

function toolMeta(entrypoint = false): Record<string, unknown> {
  return {
    ui: { resourceUri: CALCULATOR_RESOURCE_URI, visibility: ["app", "model"] },
    "ui/resourceUri": CALCULATOR_RESOURCE_URI,
    "openai/outputTemplate": CALCULATOR_RESOURCE_URI,
    ...(entrypoint
      ? { "openai/ui": { entrypoints: [{ type: "global" }, { type: "thread" }] } }
      : {}),
  };
}

export const CALCULATOR_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    :root {
      color-scheme: light dark;
      font-family: ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      font-size: var(--font-size-base,14px);
      --app-background: var(--background,Canvas);
      --app-foreground: var(--foreground,CanvasText);
      --app-card: var(--card,color-mix(in srgb,CanvasText 4%,Canvas));
      --app-card-foreground: var(--card-foreground,var(--app-foreground));
      --app-muted: var(--muted,color-mix(in srgb,CanvasText 6%,Canvas));
      --app-muted-foreground: var(--muted-foreground,GrayText);
      --app-border: var(--border,color-mix(in srgb,CanvasText 16%,transparent));
      --app-input: var(--input,var(--app-border));
      --app-primary: var(--primary,AccentColor);
      --app-primary-foreground: var(--primary-foreground,AccentColorText);
      --app-destructive: var(--destructive,CanvasText);
    }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 12px; color: var(--app-foreground); background: transparent; }
    button,input,select { font: inherit; }
    strong,h1,h2 { font-weight: 500; }
    .calculator-app { width: 100%; }
    .calculator-heading { margin-bottom: 14px; }
    h1 { margin: 0; font: inherit; font-weight: 500; }
    .text-small { font-size: max(11px,.86em); }
    .text-muted { color: var(--app-muted-foreground); }
    .calculator-subtitle { margin: 4px 0 0; }
    .viz-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
    .calculator-tabs { margin-bottom: 16px; }
    .btn { min-height: 40px; padding: 7px 14px; border: 1px solid var(--app-border); border-radius: 8px; color: var(--app-foreground); background: var(--app-background); cursor: pointer; }
    .btn-primary,.btn[aria-selected="true"] { border-color: var(--app-primary); color: var(--app-primary-foreground); background: var(--app-primary); }
    .btn-ghost { border-color: transparent; background: transparent; }
    .btn-block { width: 100%; }
    .btn:disabled { opacity: .5; cursor: default; }
    .panel[hidden] { display: none; }
    .form-label { display: block; margin: 0 0 6px; color: var(--app-muted-foreground); font-weight: 500; }
    .form-control,.form-select { width: 100%; min-height: 40px; padding: 7px 10px; border: 1px solid var(--app-input); border-radius: 8px; color: var(--app-foreground); background: var(--app-background); font-size: max(16px,1em); }
    .calculator-row { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; }
    .currency-fields { display: grid; grid-template-columns: minmax(0,1.3fr) minmax(0,.85fr) auto minmax(0,.85fr); gap: 8px; align-items: end; }
    .swap { width: 40px; padding-inline: 0; }
    .card { margin-top: 14px; padding: 13px; border: 1px solid var(--app-border); border-radius: 10px; color: var(--app-card-foreground); background: var(--app-card); }
    .viz-stat-value { margin: 0; overflow-wrap: anywhere; font-weight: 500; }
    .result-meta { margin: 6px 0 0; }
    .text-destructive { margin: 0; color: var(--app-destructive); }
    .calculator-hint { margin: 10px 0 0; }
    .currency-action { margin-top: 10px; }
    @media (pointer: coarse) { .btn,.form-control,.form-select { min-height: 44px; } }
    @media (width <= 520px) { .currency-fields { grid-template-columns: 1fr 1fr; } .swap { display: none; } }
    @media (width <= 360px) { body { padding: 8px; } .calculator-row { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main class="calculator-app">
    <header class="calculator-heading">
      <h1>HyperNode 计算器</h1>
      <p class="calculator-subtitle text-small text-muted">算式与人民币 / 港币实时换算</p>
    </header>
    <nav class="calculator-tabs viz-controls" role="tablist" aria-label="计算器功能">
      <button id="math-tab" class="btn" type="button" role="tab" aria-selected="true" aria-controls="math" data-panel="math">算式</button>
      <button id="fx-tab" class="btn btn-ghost" type="button" role="tab" aria-selected="false" aria-controls="fx" data-panel="fx">人民币 · 港币</button>
    </nav>
    <section id="math" class="panel" role="tabpanel" aria-labelledby="math-tab">
      <label class="form-label" for="expression">输入算式</label>
      <div class="calculator-row"><input id="expression" class="form-control" value="12 * 8" autocomplete="off"><button id="compute" class="btn btn-primary" type="button">计算</button></div>
      <div id="math-result" class="card" role="status" aria-live="polite"><h2 class="viz-stat-value">准备就绪</h2><p class="result-meta text-small text-muted">支持 + − × ÷ 与括号</p></div>
    </section>
    <section id="fx" class="panel" role="tabpanel" aria-labelledby="fx-tab" hidden>
      <div class="currency-fields">
        <div><label class="form-label" for="amount">金额</label><input id="amount" class="form-control" type="number" min="0" step="0.01" value="1000"></div>
        <div><label class="form-label" for="from">从</label><select id="from" class="form-select"><option value="CNY">人民币 CNY</option><option value="HKD">港币 HKD</option></select></div>
        <button id="swap" class="btn swap" type="button" aria-label="交换币种">⇄</button>
        <div><label class="form-label" for="to">到</label><select id="to" class="form-select"><option value="HKD">港币 HKD</option><option value="CNY">人民币 CNY</option></select></div>
      </div>
      <button id="convert" class="currency-action btn btn-primary btn-block" type="button">获取招行牌价并换算</button>
      <div id="fx-result" class="card" role="status" aria-live="polite"><h2 class="viz-stat-value">等待换算</h2><p class="result-meta text-small text-muted">数据由 HyperNode 服务端向招商银行查询</p></div>
      <p class="calculator-hint text-small text-muted">牌价仅供参考，以实际办理业务时的汇率为准。</p>
    </section>
  </main>
  <script>
    const q = (id) => document.getElementById(id);
    const number = (value, digits) => new Intl.NumberFormat("zh-CN", { maximumFractionDigits: digits }).format(value);
    function show(id, value, meta, error) {
      const root = q(id); root.textContent = "";
      root.setAttribute("role", error ? "alert" : "status");
      const main = document.createElement(error ? "p" : "h2"); main.className = error ? "text-destructive" : "viz-stat-value"; main.textContent = value; root.appendChild(main);
      if (meta) { const detail = document.createElement("p"); detail.className = "result-meta text-small text-muted"; detail.textContent = meta; root.appendChild(detail); }
    }
    async function call(name, args) {
      if (!window.openai || typeof window.openai.callTool !== "function") throw new Error("当前宿主没有提供 MCP App 工具桥接");
      const response = await window.openai.callTool(name, args);
      return response && response.structuredContent ? response.structuredContent : response;
    }
    async function compute() {
      const button = q("compute"); button.disabled = true;
      try { const data = await call("calculator.compute", { expression: q("expression").value }); show("math-result", number(data.value, 12), data.expression + " = " + data.value); }
      catch (error) { show("math-result", error && error.message ? error.message : String(error), "", true); }
      finally { button.disabled = false; }
    }
    async function convert() {
      const button = q("convert"); button.disabled = true; show("fx-result", "正在获取实时牌价…", "由服务端连接招商银行");
      try {
        const data = await call("calculator.convertCurrency", { amount: Number(q("amount").value), from: q("from").value, to: q("to").value });
        const unit = data.targetCurrency === "CNY" ? " CNY" : " HKD";
        const meta = data.quoteType + " · 100 HKD = " + data.bankRateCnyPer100Hkd + " CNY" + (data.quotedAt ? " · " + data.quotedAt : "");
        show("fx-result", number(data.convertedAmount, 4) + unit, meta);
      } catch (error) { show("fx-result", error && error.message ? error.message : String(error), "", true); }
      finally { button.disabled = false; }
    }
    document.querySelectorAll('[role="tab"]').forEach((tab) => tab.addEventListener("click", () => {
      document.querySelectorAll('[role="tab"]').forEach((candidate) => {
        const active = candidate === tab;
        candidate.setAttribute("aria-selected", String(active));
        candidate.classList.toggle("btn-ghost", !active);
        q(candidate.dataset.panel).hidden = !active;
      });
    }));
    q("compute").addEventListener("click", compute); q("expression").addEventListener("keydown", (event) => { if (event.key === "Enter") compute(); });
    q("convert").addEventListener("click", convert); q("swap").addEventListener("click", () => { const from = q("from").value; q("from").value = q("to").value; q("to").value = from; });
    const initial = window.openai && window.openai.toolOutput;
    if (initial && typeof initial === "object") {
      if (typeof initial.value === "number") show("math-result", number(initial.value, 12), (initial.expression || "") + " = " + initial.value);
      if (typeof initial.convertedAmount === "number") show("fx-result", number(initial.convertedAmount, 4) + " " + initial.targetCurrency, initial.quoteType || "");
    }
  </script>
</body>
</html>`;

export class CalculatorService extends Service {
  static inject = ["httpClient", "mcpRegistry"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;
  private requestSequence = 0;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "calculator");
    ctx.effect(() => ctx.mcpRegistry.registerServer(this.registration()));
  }

  registration(): McpServerRegistration {
    return {
      name: CALCULATOR_SERVER_NAME,
      pluginId: "hypernode-control",
      title: "HyperNode 计算器",
      description: "进行算式计算，并使用招商银行实时牌价换算人民币与港币。",
      version: "1.2.0",
      websiteUrl: "https://fx.cmbchina.com/",
      tools: [
        {
          name: "calculator.compute",
          title: "计算算式",
          description: "计算包含加、减、乘、除和括号的算术表达式。",
          inputSchema: {
            type: "object",
            properties: { expression: { type: "string", description: "Arithmetic expression" } },
            required: ["expression"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: { expression: { type: "string" }, value: { type: "number" } },
            required: ["expression", "value"],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: true, openWorldHint: false },
          _meta: toolMeta(true),
          call: (argumentsValue) => {
            const expression = isRecord(argumentsValue) ? argumentsValue["expression"] : undefined;
            const value = evaluateExpression(expression);
            const structuredContent = { expression, value };
            return textResult(structuredContent, `${String(expression)} = ${value}`);
          },
        },
        {
          name: "calculator.convertCurrency",
          title: "换算人民币与港币",
          description: "使用招商银行当前牌价换算人民币与港币。",
          inputSchema: {
            type: "object",
            properties: {
              amount: { type: "number", minimum: 0 },
              from: { type: "string", enum: ["CNY", "HKD"] },
              to: { type: "string", enum: ["CNY", "HKD"] },
            },
            required: ["amount", "from", "to"],
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            properties: {
              sourceAmount: { type: "number" }, sourceCurrency: { type: "string" },
              targetCurrency: { type: "string" }, convertedAmount: { type: "number" },
              bankRateCnyPer100Hkd: { type: "number" }, quoteType: { type: "string" },
              quotedAt: { type: ["string", "null"] }, sourceName: { type: "string" },
              sourceUrl: { type: "string" },
            },
            required: ["sourceAmount", "sourceCurrency", "targetCurrency", "convertedAmount", "bankRateCnyPer100Hkd", "quoteType", "sourceName", "sourceUrl"],
          },
          annotations: { readOnlyHint: true, openWorldHint: true },
          _meta: toolMeta(),
          call: (argumentsValue) => this.currencyTask(argumentsValue),
        },
      ],
      resources: [{
        uri: CALCULATOR_RESOURCE_URI,
        name: "hypernode-calculator-ui",
        title: "HyperNode 计算器",
        description: "交互式算式计算器与人民币/港币换算工具。",
        mimeType: "text/html;profile=mcp-app",
        read: () => CALCULATOR_HTML,
      }],
    };
  }

  private currencyTask(argumentsValue: unknown): PendingMcpToolCall {
    const amount = isRecord(argumentsValue) ? argumentsValue["amount"] : undefined;
    const from = isRecord(argumentsValue) ? argumentsValue["from"] : undefined;
    const to = isRecord(argumentsValue) ? argumentsValue["to"] : undefined;
    finiteNumber(amount, "amount");
    currency(from, "from");
    currency(to, "to");

    const requestId = `mcp-cmb-rate:${++this.requestSequence}`;
    const responseBytes: number[] = [];
    let status = 0;
    this.ctx.httpClient.open(requestId, {
      method: "GET",
      url: CMB_RATE_API_URL,
      headers: { Accept: "application/json", "User-Agent": "HyperNode-MCP/1.0" },
      telemetry: { correlationId: requestId, requestId },
    });
    return {
      kind: "pending",
      timeoutMs: 16_000,
      cancel: () => this.ctx.httpClient.close(requestId),
      poll: () => {
        const drained = this.ctx.httpClient.drain(requestId);
        if (drained.status > 0) status = drained.status;
        responseBytes.push(...drained.dataBytes);
        if (responseBytes.length > 256 * 1024) throw new Error("招商银行汇率响应过大");
        if (drained.error) throw new Error(`招商银行汇率请求失败：${drained.error}`);
        if (!drained.closed) return null;
        if (status < 200 || status >= 300) throw new Error(`招商银行汇率请求返回 HTTP ${status}`);
        const payload = JSON.parse(utf8Decode(Uint8Array.from(responseBytes)));
        const converted = convertCmbRate(payload, amount, from, to);
        return textResult(
          converted,
          `${converted.sourceAmount} ${converted.sourceCurrency} = ` +
            `${converted.convertedAmount} ${converted.targetCurrency} ` +
            `(${converted.quoteType}, ${converted.bankRateCnyPer100Hkd} CNY/100 HKD)`,
        );
      },
    };
  }
}
