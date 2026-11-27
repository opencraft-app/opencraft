import { DatabaseSync } from 'node:sqlite';
import { isAbsolute } from 'node:path';

// The rule vocabulary is runtime-neutral (rules.mjs); this module adds the cross-process Node readers.
export { POLICY_PATH, engines, parseRules } from './rules.mjs';
import { parseRules } from './rules.mjs';

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
  const canonical = gatewayPolicyModel(engine, model);
  return rules.some(r => r.engine === engine && (r.model === undefined || r.model === model || r.model === canonical) && (r.effort === undefined || r.effort === effort));
}

// Contributed keys retain the administrator's original model-policy identity.
// The contribution table holds references only; this reader never opens secrets.
function gatewayPolicyModel(engine, model) {
  const path = process.env.OPENCRAFT_MODEL_GATEWAY_DATABASE;
  if (path === undefined || engine !== 'codex' || typeof model !== 'string' || !model.startsWith('configured/')) return model;
  if (!isAbsolute(path)) throw Error('model_gateway_unavailable');
  let db;
  try {
    const parts = model.slice('configured/'.length).split('/');
    if(parts.length !== 2) throw Error();
    const provider = decodeURIComponent(parts[0]);
    db = new DatabaseSync(path,{readOnly:true});db.exec('PRAGMA busy_timeout=5000');
    const contribution = db.prepare('SELECT template_provider,state FROM gateway_contributions WHERE provider=?').get(provider);
    if (!contribution) return model;
    if (contribution.state !== 'shared') throw Error();
    return 'configured/' + encodeURIComponent(contribution.template_provider) + '/' + parts[1];
  } catch { throw Error('model_gateway_connection_unavailable'); }
  finally { db?.close(); }
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
  if (typeof model !== 'string' || !model) throw new ModelPolicyError('unresolved');
  const canonical = gatewayPolicyModel(engine,model);
  const modelDenied = policy.rules.some(r=>r.engine===engine && r.effort===undefined && (r.model===undefined || r.model===model || r.model===canonical));
  const effortRuleApplies = !modelDenied && policy.rules.some(r=>r.engine===engine && r.effort !== undefined && (r.model===undefined || r.model===model || r.model===canonical));
  // A missing native default cannot mean "not restricted" unless every declared level for this model is permitted.
  if (effortRuleApplies && (typeof effort !== 'string' || !effort)) {
    const entry = catalog.find(m=>(m.model ?? m.id)===model);
    const supported = Array.isArray(entry?.supportedReasoningEfforts)
      ? entry.supportedReasoningEfforts.map(e=>e?.reasoningEffort ?? e).filter(e=>typeof e==='string' && e)
      : null;
    if (!entry || !supported?.length) throw new ModelPolicyError('unresolved');
    if (supported.some(e=>denied(policy.rules,engine,model,e))) {
      throw new ModelPolicyError('effort',supported.filter(e=>!denied(policy.rules,engine,model,e)).slice(0,10));
    }
    return policy.revision;
  }
  if (!modelDenied && !denied(policy.rules,engine,model,effort)) return policy.revision;
  const kind = modelDenied ? 'model' : 'effort';
  const alternatives = kind === 'effort' ? (catalog.find(m=>(m.model ?? m.id)===model)?.supportedReasoningEfforts ?? []).map(e=>e.reasoningEffort).filter(e=>!denied(policy.rules,engine,model,e))
    : catalog.filter(m=>!denied(policy.rules,engine,m.model ?? m.id,m.defaultReasoningEffort)).map(m=>m.model ?? m.id);
  throw new ModelPolicyError(kind,alternatives.slice(0,10));
}
export function projectModels(path, engine, models, policy = readPolicy(path)) {
  const {rules} = policy;
  return models.map(m=>({...m,policyRestricted:denied(rules.filter(r=>r.effort===undefined),engine,m.model ?? m.id),policyRestrictedEfforts:(m.supportedReasoningEfforts ?? []).filter(e=>denied(rules,engine,m.model ?? m.id,e.reasoningEffort)).map(e=>e.reasoningEffort),hidden:m.hidden || denied(rules.filter(r=>r.effort===undefined),engine,m.model ?? m.id),
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
  const explicit=collaboration?.reasoning_effort ?? params.effort ?? params.reasoningEffort ?? params.config?.model_reasoning_effort;
  const effort=explicit ?? (model===thread.model ? thread.reasoningEffort : null) ?? entry?.defaultReasoningEffort;
  return {model,effort};
}
