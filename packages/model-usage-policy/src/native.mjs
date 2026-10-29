import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';

export const POLICY_PATH = '/__opencraft_model_policy';
export const engines = ['codex', 'pi', 'dsh', 'acp', 'dsh-acp', 'claude-code'];
export function parseRules(value) {
  if (!Array.isArray(value) || value.length > 1000) throw Error('invalid_model_policy');
  const seen = new Set();
  return value.map(row => {
    if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some(k => !['engine','model','effort'].includes(k))
      || !engines.includes(row.engine) || ![row.model,row.effort].some(v => v !== undefined)
      || [row.model,row.effort].some(v => v !== undefined && (typeof v !== 'string' || !v || v.length > 512 || /[\x00-\x1f]/u.test(v)))) throw Error('invalid_model_policy');
    const result = {engine:row.engine,...(row.model === undefined ? {} : {model:row.model}),...(row.effort === undefined ? {} : {effort:row.effort})};
    const key = JSON.stringify(result); if (seen.has(key)) throw Error('invalid_model_policy'); seen.add(key); return result;
  });
}
export function readPolicy(path) {
  if (!path) return {revision:0,rules:[]};
  if (!isAbsolute(path)) throw Error('model_policy_unavailable');
  let db;
  try {
    db = new DatabaseSync(path,{readOnly:true}); db.exec('PRAGMA busy_timeout=5000');
    const row = db.prepare('SELECT revision,rules FROM model_usage_policy WHERE singleton=1').get();
    if (!row || !Number.isSafeInteger(row.revision)) throw Error();
    return {revision:row.revision,rules:parseRules(JSON.parse(row.rules))};
  } catch { throw Error('model_policy_unavailable'); }
  finally { db?.close(); }
}
export function denied(rules, engine, model, effort) {
  return rules.some(r => r.engine === engine && (r.model === undefined || r.model === model) && (r.effort === undefined || r.effort === effort));
}
export class ModelPolicyError extends Error {
  constructor(kind, alternatives = []) {
    super(alternatives.length ? `${kind === 'effort' ? 'Thinking level' : 'Model'} restricted by administrator. Choose: ${alternatives.join(', ')}` : 'No permitted option. Contact your administrator.');
    this.code = -32043; this.data = {code:'model_usage_restricted',kind,alternatives};
  }
}
export function assertModelPolicy(path, engine, model, effort, catalog = []) {
  const policy = readPolicy(path);
  if (!policy.rules.some(r=>r.engine===engine)) return policy.revision;
  // A missing native default cannot mean "not restricted".
  if (typeof model !== 'string' || !model || policy.rules.some(r=>r.engine===engine && r.effort !== undefined) && (typeof effort !== 'string' || !effort)) throw new ModelPolicyError('unresolved');
  if (!denied(policy.rules,engine,model,effort)) return policy.revision;
  const kind = policy.rules.some(r=>r.engine===engine && r.effort===undefined && (r.model===undefined || r.model===model)) ? 'model' : 'effort';
  const alternatives = kind === 'effort' ? (catalog.find(m=>(m.model ?? m.id)===model)?.supportedReasoningEfforts ?? []).map(e=>e.reasoningEffort).filter(e=>!denied(policy.rules,engine,model,e))
    : catalog.filter(m=>!denied(policy.rules,engine,m.model ?? m.id,m.defaultReasoningEffort)).map(m=>m.model ?? m.id);
  throw new ModelPolicyError(kind,alternatives.slice(0,10));
}
export function projectModels(path, engine, models, policy = readPolicy(path)) {
  const {rules} = policy;
  return models.map(m=>({...m,policyRestricted:rules.some(r=>r.engine===engine),policyRestrictedEfforts:(m.supportedReasoningEfforts ?? []).filter(e=>denied(rules,engine,m.model ?? m.id,e.reasoningEffort)).map(e=>e.reasoningEffort),hidden:m.hidden || rules.some(r=>r.engine===engine && r.effort===undefined && r.model===(m.model ?? m.id)),
    supportedReasoningEfforts:(m.supportedReasoningEfforts ?? []).filter(e=>!denied(rules,engine,m.model ?? m.id,e.reasoningEffort))}));
}

/** Called after native provider defaults resolve, before the first LLM call. */
export function createDshPolicyBoundary(path, catalog) {
  const admitted = new WeakMap();
  return {async admit(session,turn,config) {
    const key=JSON.stringify([turn,config.provider,config.model,config.reasoningEffort]);
    if(admitted.get(session)===key) return;
    const model=`dsh-model:${encodeURIComponent(config.provider)}:${encodeURIComponent(config.model)}`;
    try {assertModelPolicy(path,'dsh',model,config.reasoningEffort ?? 'none');}
    catch(error) {
      if (!(error instanceof ModelPolicyError) || !catalog) throw error;
      const models=await catalog(config);
      assertModelPolicy(path,'dsh',model,config.reasoningEffort ?? 'none',models);
    }
    admitted.set(session,key);
  }};
}

/** Resolve wire overrides in the same order as the native Turn protocol. */
export function resolvePolicySelection(engine, params, thread, catalog) {
  const collaboration=engine==='codex' ? params.collaborationMode?.settings : null;
  const model=collaboration?.model ?? params.model ?? thread.model ?? catalog.find(m=>m.isDefault)?.model;
  const entry=catalog.find(m=>(m.model ?? m.id)===model);
  const explicit=collaboration ? collaboration.reasoning_effort : params.effort ?? params.reasoningEffort ?? params.config?.model_reasoning_effort;
  const effort=collaboration ? explicit ?? entry?.defaultReasoningEffort : explicit ?? (model===thread.model ? thread.reasoningEffort : null) ?? entry?.defaultReasoningEffort;
  return {model,effort};
}
