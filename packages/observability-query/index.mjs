import { fault } from '../observability-contract/index.mjs';
export const queryDefinitionRevision = 'observe-v1.1.3';
const latency = 'histogram_quantile(0.95, sum by (le, operation, cache, engine) (rate(opencraft_interactive_operation_duration_seconds_bucket[5m])))';
/** This is the only expression registry, shared by Observe and generated provisioning. */
export const definitions = Object.freeze({
  'platform.status': { title: '平台与采集状态', kind: 'resource_sample', promql: 'opencraft_producer_age_seconds', unit: 'seconds' },
  'operations.latency': { title: '前台交互耗时（P95 估算，5分钟窗口）', kind: 'histogram_approximation', promql: latency, unit: 'seconds' },
  'operations.outcomes': { title: '交互操作结果分布（按来源，5分钟窗口）', kind: 'histogram_approximation', promql: 'sum by (operation, outcome, origin) (increase(opencraft_observed_operations_total[5m]))', unit: 'operations', windowSemantics:'rolling_5m_at_evaluation' },
  'recovery.episodes': { title: '重连恢复周期（领域精确聚合）', kind: 'exact_domain_aggregation', promql: 'opencraft_recovery_episodes', unit: 'episodes', windowSemantics:'rolling_24h_at_evaluation' },
  'execution.progress': { title: '执行生命周期结果分布（领域精确聚合）', kind: 'exact_domain_aggregation', promql: 'opencraft_executions', unit: 'executions', windowSemantics:'rolling_24h_at_evaluation' },
  'execution.stages': { title: '活跃执行阶段分布（最新观测状态）', kind: 'exact_domain_aggregation', promql: 'opencraft_active_executions', unit: 'executions', windowSemantics:'latest_observed_state_at_evaluation' },
  'execution.last_progress': { title: '最长活跃执行停滞时长', kind: 'resource_sample', promql: 'opencraft_execution_last_progress_age_seconds', unit: 'seconds', windowSemantics:'latest_observed_state_at_evaluation' },
  'queues.summary': { title: '捕获的排队提交数（非执行轮次）', kind: 'resource_sample', promql: 'opencraft_queued_submissions', unit: 'submissions', windowSemantics:'fresh_owner_samples_at_evaluation' },
  'usage.activity24h': { title: '已校验交互真人用户数（24小时去重）', kind: 'exact_domain_aggregation', promql: 'opencraft_active_humans_24h', unit: 'humans', windowSemantics:'rolling_24h_at_evaluation' },
  'dependencies.summary': { title: 'RPC 依赖调用次数估算（5分钟增量）', kind: 'histogram_approximation', promql: 'sum by (method, outcome) (increase(opencraft_rpc_total[5m]))', unit: 'attempts' },
  'resources.summary': { title: '进程常驻物理内存 (RSS)', kind: 'resource_sample', promql: 'opencraft_process_rss_bytes', unit: 'bytes' },
  'usage.activity': { title: '已校验交互真人用户数（7天去重）', kind: 'exact_domain_aggregation', promql: 'opencraft_active_humans_7d', unit: 'humans', windowSemantics:'rolling_7d_at_evaluation' },
  'components.versions': { title: '组件身份识别覆盖率', kind: 'resource_sample', promql: 'opencraft_component_identity_known', unit: 'boolean' },
  'data.coverage': { title: '遥测数据采集丢弃数', kind: 'resource_sample', promql: 'opencraft_telemetry_losses_total', unit: 'events' },
  'incident.read': { title: '捕获的故障现场证据', kind: 'event_sample', unit: 'events' },
  'baseline.compare': { title: '基线对比操作样本', kind: 'event_sample', unit: 'milliseconds' },
});
export const percentile = (values, p) => values.length ? [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(p * values.length)-1)] : null;
export function issues(snapshot) {
  const result = [];
  if (snapshot.coverage !== 'complete') result.push({ id: 'collection-incomplete', severity: 'warning', evidenceKind: 'observed', hypothesis: 'Inspect missing/stale producers before interpreting absence of failures.' });
  const failures = snapshot.events?.filter(e => ['failed','timeout'].includes(e.outcome)) ?? [];
  if (failures.length) result.push({ id: 'observed-failures', severity: 'warning', evidenceKind: 'observed', count: failures.length, hypothesis: 'Inspect the recorded operation and dependency stages; association does not establish cause.' });
  return result;
}
export function compare(before, after, dimensions = {}) {
  const allowed={operationType:['navigation','thread_open','catalog_first','catalog_complete','configuration_confirmed','submit_ready','preference_save','recovery'],cache:['cold','warm'],engine:['codex','dsh','pi','none']};
  if(Object.entries(dimensions).some(([key,value])=>!allowed[key]?.includes(value)))throw fault('invalid_comparison_dimensions');
  const matches=e=>Object.entries(dimensions).every(([key,value])=>e[key]===value);
  const reasons = [];
  for (const key of ['deploymentId','queryDefinitionRevision','metricSchemaVersion']) if (before[key] !== after[key]) reasons.push(`different_${key}`);
  if (before.coverage !== 'complete' || after.coverage !== 'complete' || before.loss?.dropped || after.loss?.dropped) reasons.push('incomplete_capture');
  const select = s => (s.events ?? []).filter(e => e.kind === 'operation' && matches(e) && e.outcome === 'ok' && Number.isFinite(e.durationMs));
  let left = select(before), right = select(after);
  if([...left,...right].some(e=>!e.workloadDigest||!['cold','warm'].includes(e.cache)||!['codex','dsh','pi','none'].includes(e.engine)||!e.measurementScope))reasons.push('missing_workload_metadata');
  if(left.some(e=>e.eventId&&right.some(r=>r.eventId===e.eventId)))reasons.push('reused_samples');
  const group = e => JSON.stringify([e.operationType,e.measurementScope,e.cache,e.engine,e.originClass,e.workloadDigest]);
  const groups = rows => [...new Set(rows.map(group))].sort();
  if (JSON.stringify(groups(left)) !== JSON.stringify(groups(right))) reasons.push('incompatible_workload');
  if (groups(left).length !== 1 || groups(right).length !== 1) reasons.push('mixed_or_missing_workload');
  const real = [...left,...right].every(e => e.originClass === 'interactive');
  if (real) { if (left.length < 100 || right.length < 100) reasons.push('insufficient_real_samples'); }
  else {
    const paired = left.filter(e => e.pairId && right.some(r => r.pairId === e.pairId));
    const pairs=new Set(paired.map(e=>e.pairId));
    if (pairs.size < 20) reasons.push('insufficient_paired_samples');
    if(paired.length!==pairs.size||right.filter(e=>pairs.has(e.pairId)).length!==pairs.size)reasons.push('ambiguous_pair_samples');
    left=left.filter(e=>pairs.has(e.pairId));right=right.filter(e=>pairs.has(e.pairId));
  }
  const summary = rows => ({ count: rows.length, medianMs: percentile(rows.map(e => e.durationMs),.5), sampleP95Ms: percentile(rows.map(e => e.durationMs),.95), failures: rows.filter(e => e.outcome === 'failed').length });
  const a = summary(left), b = summary(right);
  const direction = a.medianMs !== null && b.medianMs !== null && b.medianMs < a.medianMs && b.sampleP95Ms < a.sampleP95Ms ? 'improved' : b.medianMs > a.medianMs && b.sampleP95Ms > a.sampleP95Ms ? 'regressed' : 'inconclusive';
  return { schemaVersion: 1, dimensions, components:{before:before.components??[],after:after.components??[]}, status: reasons.length ? 'inconclusive' : direction, reasons, before: a, after: b,
    evidenceKind: 'observed_association', causal: false, sideEffects: { beforeLoss: before.loss, afterLoss: after.loss,
      beforeFailures: (before.events??[]).filter(e=>['failed','timeout'].includes(e.outcome)).length,
      afterFailures: (after.events??[]).filter(e=>['failed','timeout'].includes(e.outcome)).length } };
}
export function requireQuery(name) { if (!Object.hasOwn(definitions,name)) throw fault('unknown_query'); return definitions[name]; }
