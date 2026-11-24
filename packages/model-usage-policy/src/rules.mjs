// Model usage policy rules: the route, the engines a rule can name and rule
// validation. Runtime-neutral: the policy owner (Node or a Durable Object), the
// HTTP handler and the Node cross-process readers (native.mjs) share it.
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
