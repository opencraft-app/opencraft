import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("dashboard keeps the model distribution chart section", () => {
  const pageSource = readFileSync(
    new URL("./page.tsx", import.meta.url),
    "utf8"
  );
  const chartSource = readFileSync(
    new URL("../../../components/dashboard/model-distribution.tsx", import.meta.url),
    "utf8"
  );

  assert.match(pageSource, /import\s+\{\s*ModelDistribution\s*\}/);
  assert.match(pageSource, /<ModelDistribution\s*\/>/);
  assert.match(chartSource, /\{selectedPeriod\.label\}模型使用结构/);
  assert.match(chartSource, /查看近期 token 消耗主要集中在哪些模型。/);
  assert.match(chartSource, /<BarChart/);
  assert.match(chartSource, /dataKey="date"/);
  assert.match(chartSource, /dailyRows = data\?\.model_daily_distribution \?\? \[\]/);
  assert.match(chartSource, /modelKeys/);
  assert.match(chartSource, /<Table>/);
  assert.match(chartSource, /时间/);
  assert.match(chartSource, /模型/);
  assert.match(chartSource, /消耗/);
  assert.match(chartSource, /请求数/);
  assert.match(chartSource, /占比/);
  assert.match(chartSource, /useState<UsageTrendPeriod>\("7d"\)/);
  assert.match(chartSource, /useUsageTrend\(period\)/);
  assert.match(chartSource, /<Select[\s\S]*value=\{period\}/);
  assert.match(chartSource, /<SelectValue>\{selectedPeriod\.label\}<\/SelectValue>/);
  assert.match(chartSource, /<SelectItem value="7d">近 7 天<\/SelectItem>/);
  assert.match(chartSource, /<SelectItem value="30d">近 30 天<\/SelectItem>/);
});
