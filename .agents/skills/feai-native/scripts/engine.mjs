#!/usr/bin/env node
// feai-native 工作流引擎。零依赖，node >= 16。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

// ============ 受限 YAML 子集 ============
// 支持：嵌套 map（2 空格缩进）、标量列表、map 列表（- key: value）、
// 标量（string/number/bool/null/双引号字符串）、行内列表 [a, b]、注释。
// 不支持：锚点、多行字符串、flow 风格 map。非法输入抛错（fail-closed）。

function stripTrailingComment(s) {
  let inString = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '\\' && inString) { i += 1; continue; }
    if (ch === '"') inString = !inString;
    if (!inString && ch === '#' && (i === 0 || /\s/u.test(s[i - 1]))) {
      return s.slice(0, i).trim();
    }
  }
  return s.trim();
}

function parseScalar(raw) {
  const s = stripTrailingComment(raw);
  if (s === '' || s === 'null' || s === '~') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/u.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/u.test(s)) return Number.parseFloat(s);
  if (s === '{}') return {};
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((item) => parseScalar(item));
  }
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) throw new Error(`YAML: 字符串引号未闭合: ${s}`);
    return JSON.parse(s);
  }
  return s;
}

function parseYaml(text) {
  const lines = text.split('\n');
  lines.forEach((l, i) => {
    if (/^[ \t]*\t/u.test(l)) throw new Error(`YAML: 不允许 Tab 缩进 @${i + 1}`);
  });
  let pos = 0;
  const indentOf = (line) => line.match(/^ */u)[0].length;
  const skipBlank = () => {
    while (pos < lines.length && (/^\s*$/u.test(lines[pos]) || /^\s*#/u.test(lines[pos]))) pos += 1;
  };
  function parseBlock(indent) {
    skipBlank();
    if (pos >= lines.length) return null;
    const line = lines[pos];
    if (indentOf(line) < indent) return null;
    if (line.trimStart().startsWith('-')) return parseList(indentOf(line));
    return parseMap(indentOf(line));
  }
  const setKey = (obj, key, value) => {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
      Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
    } else {
      obj[key] = value;
    }
  };
  function parseMap(indent) {
    const obj = {};
    while (pos < lines.length) {
      skipBlank();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) throw new Error(`YAML: 意外缩进 @${pos + 1}: ${line.trim()}`);
      const trimmed = line.trim();
      if (trimmed.startsWith('-')) break;
      const m = trimmed.match(/^([^:]+):(.*)$/u);
      if (!m) throw new Error(`YAML: 无法解析 @${pos + 1}: ${trimmed}`);
      const key = m[1].trim();
      const rest = m[2].trim();
      pos += 1;
      setKey(obj, key, rest === '' ? parseBlock(indent + 1) : parseScalar(rest));
    }
    return obj;
  }
  function parseList(indent) {
    const arr = [];
    while (pos < lines.length) {
      skipBlank();
      if (pos >= lines.length) break;
      const line = lines[pos];
      const ind = indentOf(line);
      if (ind !== indent || !line.trimStart().startsWith('-')) break;
      const trimmed = line.trim();
      if (trimmed === '-') {
        pos += 1;
        arr.push(parseBlock(indent + 1));
        continue;
      }
      const content = trimmed.slice(1).trim();
      if (/^[^:]+:\s*/u.test(content) && !content.startsWith('"')) {
        // map 列表项：伪行注入，把 "- id: shape" 当作缩进 map 首行
        lines[pos] = ' '.repeat(indent + 2) + content;
        arr.push(parseMap(indent + 2));
        continue;
      }
      pos += 1;
      arr.push(parseScalar(content));
    }
    return arr;
  }
  const result = parseBlock(0);
  skipBlank();
  if (pos < lines.length) throw new Error(`YAML: 尾部存在无法解析的内容 @${pos + 1}`);
  return result;
}

function scalarToYaml(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  if (s.includes('\n') || s === '' || /[:#\[\]{}",]/u.test(s) || /^(true|false|null|~|-?\d+(\.\d+)?)$/u.test(s) || s !== s.trim()) {
    return JSON.stringify(s);
  }
  return s;
}

function dumpYaml(value, indent = 0) {
  const pad = ' '.repeat(indent);
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return value.map((item) => {
      if (item !== null && typeof item === 'object') {
        const isEmpty = Array.isArray(item) ? item.length === 0 : Object.keys(item).length === 0;
        if (!isEmpty) {
          const inner = dumpYaml(item, indent + 2);
          return `${pad}- ${inner.slice(indent + 2)}`;
        }
        return `${pad}- ${dumpYaml(item, 0)}`;
      }
      return `${pad}- ${scalarToYaml(item)}`;
    }).join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => {
      if (v !== null && typeof v === 'object') {
        const isEmpty = Array.isArray(v) ? v.length === 0 : Object.keys(v).length === 0;
        if (!isEmpty) return `${pad}${k}:\n${dumpYaml(v, indent + 2)}`;
      }
      return `${pad}${k}: ${dumpYaml(v, 0)}`;
    }).join('\n');
  }
  return scalarToYaml(value);
}

// ============ flow 加载与校验 ============
const KNOWN_STEP_GUARDS = new Set(['require_field', 'require_approval']);
const DEFAULT_LIMITS = Object.freeze({
  warnAt: 2, stopAt: 3, hardStopAtTotal: 12, allowOverridePerSignature: true,
});

function loadFlow(flowPath) {
  const raw = parseYaml(fs.readFileSync(flowPath, 'utf8'));
  if (!raw || typeof raw !== 'object') throw new Error('flow.yaml: 内容为空或非法');
  if (typeof raw.name !== 'string' || typeof raw.version !== 'string') {
    throw new Error('flow.yaml: name/version 必填');
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error('flow.yaml: steps 不能为空');
  const stepMap = new Map();
  for (const step of raw.steps) {
    if (!step || typeof step.id !== 'string') throw new Error('flow.yaml: 每个 step 需要字符串 id');
    if (stepMap.has(step.id)) throw new Error(`flow.yaml: step id 重复: ${step.id}`);
    stepMap.set(step.id, step);
  }
  const ids = [...stepMap.keys()];
  for (const step of raw.steps) {
    const checkTarget = (target, label) => {
      if (target !== null && !stepMap.has(target)) {
        throw new Error(`flow.yaml: step ${step.id} 的 ${label} 指向不存在的 step: ${target}`);
      }
    };
    if (step.next !== undefined) checkTarget(step.next, 'next');
    if (step.guards !== undefined) {
      if (!Array.isArray(step.guards)) throw new Error(`flow.yaml: step ${step.id} guards 必须是列表`);
      for (const g of step.guards) {
        const key = g && typeof g === 'object' ? Object.keys(g)[0] : null;
        if (!KNOWN_STEP_GUARDS.has(key)) throw new Error(`flow.yaml: step ${step.id} 未知 guard: ${key}`);
      }
    }
    if (step.outcomes !== undefined) {
      if (!Array.isArray(step.outcomes) || step.outcomes.length === 0) {
        throw new Error(`flow.yaml: step ${step.id} outcomes 不能为空列表`);
      }
      for (const o of step.outcomes) {
        if (!step.on || !(o in step.on)) throw new Error(`flow.yaml: step ${step.id} 的 outcome ${o} 缺少 on 映射`);
        const edge = step.on[o];
        const target = edge === null ? null : typeof edge === 'string' ? edge : edge.to ?? null;
        checkTarget(target, `on.${o}`);
        if (edge && typeof edge === 'object' && edge.guard !== undefined && edge.guard !== 'repeated-failure') {
          throw new Error(`flow.yaml: step ${step.id} on.${o} 未知边 guard: ${edge.guard}`);
        }
      }
    }
  }
  const limits = { ...DEFAULT_LIMITS, ...(raw.guards?.['repeated-failure'] ?? {}) };
  for (const k of ['warnAt', 'stopAt', 'hardStopAtTotal']) {
    if (!Number.isInteger(limits[k]) || limits[k] < 1) throw new Error(`flow.yaml: repeated-failure.${k} 必须是正整数`);
  }
  if (limits.warnAt >= limits.stopAt) throw new Error('flow.yaml: warnAt 必须小于 stopAt');
  return { name: raw.name, version: raw.version, approvals: raw.approvals ?? {}, steps: raw.steps, stepMap, firstStep: ids[0], limits };
}

// ============ 原子写与锁 ============
class LockConflictError extends Error {
  constructor(owner) {
    super(`change 被锁占用${owner?.command ? `（持有命令: ${owner.command}）` : ''}`);
    this.owner = owner ?? null;
  }
}

async function atomicWriteFile(filePath, content) {
  const tmp = `${filePath}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fd = await fsp.open(tmp, 'w');
  try {
    await fd.writeFile(content);
    await fd.sync();
  } finally {
    await fd.close();
  }
  await fsp.rename(tmp, filePath);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function readJsonSafe(p) {
  try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; }
}

const LOCK_STALE_MS = 10 * 60 * 1000;

async function acquireLock(changeDir, command) {
  const lockPath = path.join(changeDir, '.lock');
  const token = crypto.randomUUID();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = await fsp.open(lockPath, 'wx');
      try {
        await fd.writeFile(JSON.stringify({
          token, pid: process.pid, hostname: os.hostname(),
          startedAt: new Date().toISOString(), command,
        }));
      } finally {
        await fd.close();
      }
      return {
        async release() {
          const cur = await readJsonSafe(lockPath);
          if (cur?.token === token) await fsp.rm(lockPath, { force: true });
        },
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // 评估可回收性
      const owner = await readJsonSafe(lockPath);
      const before = await fsp.stat(lockPath).catch(() => null);
      let reclaimable = false;
      if (owner) {
        const sameHost = owner.hostname === os.hostname();
        const dead = !pidAlive(owner.pid);
        const old = Date.now() - Date.parse(owner.startedAt ?? 0) > LOCK_STALE_MS;
        reclaimable = sameHost && dead && old;
      } else if (before) {
        // 不可解析锁（如崩溃留下的 0 字节锁）：回退用 mtime 判龄
        reclaimable = Date.now() - before.mtimeMs > LOCK_STALE_MS;
      }
      if (!reclaimable || !before) throw new LockConflictError(owner);
      // rename 原子——竞态下只有一个回收者能拿到改名权
      const reclaimPath = `${lockPath}.reclaim-${token}`;
      try {
        await fsp.rename(lockPath, reclaimPath);
      } catch (renameErr) {
        if (renameErr.code === 'ENOENT') continue; // 已被他人回收，重试创建
        throw renameErr;
      }
      // 比对文件身份（mtimeMs+size）：一致才是我评估过的那个文件，可安全删除
      const after = await fsp.stat(reclaimPath).catch(() => null);
      if (after && after.mtimeMs === before.mtimeMs && after.size === before.size) {
        await fsp.rm(reclaimPath, { force: true });
        continue;
      }
      // 误伤他人新锁：rename 回去并抛冲突
      await fsp.rename(reclaimPath, lockPath).catch(() => {});
      throw new LockConflictError(await readJsonSafe(reclaimPath));
    }
  }
  throw new LockConflictError(await readJsonSafe(lockPath));
}

// ============ state 读写（两层 schema） ============
const STATE_SCHEMA = 'feai.native.v1';

class StateError extends Error {}

function initState(flow, now) {
  const steps = {};
  for (const step of flow.steps) {
    steps[step.id] = { status: step.id === flow.firstStep ? 'in_progress' : 'pending' };
  }
  return {
    schema: STATE_SCHEMA,
    revision: 1,
    current_step: flow.firstStep,
    steps,
    failure: { last_signature: null, consecutive_same: 0, total: 0, overrides_used: [] },
    last_transition: null,
    data: {},
  };
}

function validateState(raw) {
  if (!raw || typeof raw !== 'object') throw new StateError('state.yaml: 内容为空或非法');
  if (raw.schema !== STATE_SCHEMA) throw new StateError(`state.yaml: schema 不兼容: ${String(raw.schema)}`);
  if (!Number.isInteger(raw.revision) || raw.revision < 1) throw new StateError('state.yaml: revision 非法');
  if (typeof raw.current_step !== 'string') throw new StateError('state.yaml: current_step 缺失');
  if (!raw.steps || typeof raw.steps !== 'object') throw new StateError('state.yaml: steps 缺失');
  if (!raw.failure || typeof raw.failure !== 'object') throw new StateError('state.yaml: failure 缺失');
  if (!raw.data || typeof raw.data !== 'object') raw.data = {};
  return raw;
}

async function readState(changeDir) {
  const p = path.join(changeDir, 'state.yaml');
  let text;
  try { text = await fsp.readFile(p, 'utf8'); } catch { throw new StateError('state.yaml: 不存在'); }
  return validateState(parseYaml(text));
}

async function writeState(changeDir, nextState, { expectRevision } = {}) {
  const current = await readState(changeDir).catch((e) => {
    // 仅"文件不存在"视为无存储 revision（首次写入）；损坏/非法 state 一律 fail-closed。
    // expectRevision: 0 经下方 CAS 检查恰好匹配该情形（actual 落为 0）。
    if (e instanceof StateError && /不存在/u.test(e.message)) return null;
    throw e;
  });
  if (expectRevision !== undefined) {
    const actual = current?.revision ?? 0;
    if (actual !== expectRevision) {
      throw new StateError(`state.yaml: revision 冲突（期望 ${expectRevision}，实际 ${actual}），请重新读取后重试`);
    }
  }
  const out = { ...nextState, revision: (current?.revision ?? 0) + 1 };
  validateState(out);
  await atomicWriteFile(path.join(changeDir, 'state.yaml'), `${dumpYaml(out)}\n`);
  return out;
}

// ============ resolver 与 guards ============
class UsageError extends Error {}

function resolveNext(flow, stepId, outcome) {
  const stepDef = flow.stepMap.get(stepId);
  if (!stepDef) throw new UsageError(`未知 step: ${stepId}`);
  if (!stepDef.outcomes) {
    if (outcome !== undefined) throw new UsageError(`step ${stepId} 无分支，不接受 --outcome`);
    return stepDef.next ?? null;
  }
  if (outcome === undefined) throw new UsageError(`step ${stepId} 需要 --outcome（${stepDef.outcomes.join('|')}）`);
  if (!stepDef.outcomes.includes(outcome)) {
    throw new UsageError(`step ${stepId} 非法 outcome: ${outcome}（可选 ${stepDef.outcomes.join('|')}）`);
  }
  const edge = stepDef.on[outcome];
  if (edge === null || edge === undefined) return null;
  return typeof edge === 'string' ? edge : edge.to ?? null;
}

function edgeGuard(flow, stepId, outcome) {
  const edge = flow.stepMap.get(stepId)?.on?.[outcome];
  return edge && typeof edge === 'object' ? edge.guard ?? null : null;
}

function sha256File(p) {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
}

function checkStepGuards({ flow, stepDef, submission, changeDir, state }) {
  const findings = [];
  for (const g of stepDef.guards ?? []) {
    const [kind, arg] = Object.entries(g)[0];
    if (kind === 'require_field') {
      const v = submission[arg];
      if (typeof v !== 'string' || v.trim() === '') {
        findings.push({ guard: 'require_field', field: arg, kind: 'field', detail: `缺少必填字段: ${arg}` });
      }
    } else if (kind === 'require_approval') {
      const file = flow.approvals[arg];
      if (!file) throw new UsageError(`require_approval: 未知 basis ${arg}（flow.approvals 未声明）`);
      const filePath = path.join(changeDir, file);
      if (!fs.existsSync(filePath)) {
        findings.push({ guard: 'require_approval', basis: arg, kind: 'approval', detail: `${arg}（${file}）文件不存在` });
        continue;
      }
      const currentHash = sha256File(filePath);
      state.data[`current_${arg}_hash`] = currentHash;
      const approvedHash = state.data[`approved_${arg}_hash`] ?? null;
      if (approvedHash !== currentHash) {
        if (submission.confirmed) {
          state.data[`approved_${arg}_hash`] = currentHash;
        } else {
          findings.push({
            guard: 'require_approval', basis: arg, kind: 'approval',
            detail: approvedHash === null
              ? `${arg}（${file}）尚未批准`
              : `${arg}（${file}）内容已变化，需重新批准`,
          });
        }
      }
    }
  }
  return findings;
}

// ============ 失败签名追踪 ============
function recordFailure(failure, signature) {
  if (signature === failure.last_signature) {
    failure.consecutive_same += 1;
  } else {
    failure.last_signature = signature;
    failure.consecutive_same = 1;
  }
  failure.total += 1;
}

function failureVerdict(failure, limits, overrideRequested) {
  if (failure.total >= limits.hardStopAtTotal) return { verdict: 'hard-stop' };
  if (failure.consecutive_same >= limits.stopAt) {
    if (
      overrideRequested && limits.allowOverridePerSignature
      && !failure.overrides_used.includes(failure.last_signature)
    ) {
      return { verdict: 'override', signature: failure.last_signature };
    }
    return { verdict: 'stop' };
  }
  if (failure.consecutive_same >= limits.warnAt) return { verdict: 'warn', consecutive: failure.consecutive_same };
  return { verdict: 'proceed' };
}

// ============ continuation 推导 ============
function isTerminalStep(flow, stepId) {
  const def = flow.stepMap.get(stepId);
  if (!def) return false;
  if (def.next) return false;
  if (def.outcomes) return def.outcomes.every((o) => def.on[o] === null);
  return true;
}

function deriveContinuation({ flow, state, change, findings = [], repair = null }) {
  const step = state.current_step;
  const base = { schema: 'feai.native.continuation.v1', change, phase: step, revision: state.revision };
  if (repair && (repair.verdict === 'stop' || repair.verdict === 'hard-stop')) {
    return {
      ...base, disposition: 'blocked',
      reason: repair.verdict === 'hard-stop' ? 'repair-hard-stop' : 'repair-stopped',
      findings: repair.findings ?? [],
      suggested_command: null,
    };
  }
  const stepStatus = state.steps[step]?.status;
  if (isTerminalStep(flow, step) && stepStatus === 'done') {
    return { ...base, disposition: 'done', reason: 'complete', findings: [], suggested_command: null };
  }
  if (findings.length > 0) {
    const approval = findings.find((f) => f.kind === 'approval');
    return {
      ...base, disposition: 'await-user',
      reason: approval ? 'approval-required' : 'field-missing',
      findings,
      suggested_command: approval
        ? `feai native next --summary "<复述确认内容>" --confirmed --json`
        : null,
    };
  }
  if (isTerminalStep(flow, step)) {
    return {
      ...base, disposition: 'await-user', reason: 'await-final-action',
      findings: [{ kind: 'info', detail: '等待用户明确要求归档' }],
      suggested_command: 'feai native archive --json',
    };
  }
  const out = {
    ...base, disposition: 'continue', reason: 'proceed',
    findings: [],
    suggested_command: `feai native next --summary "<摘要>"${flow.stepMap.get(step).outcomes ? ' --outcome <结果>' : ''} --json`,
  };
  if (repair?.verdict === 'warn') {
    out.findings = [{ kind: 'repair-warn', detail: `同一失败签名已连续 ${repair.consecutive} 次，再失败将被停止` }];
  }
  return out;
}

// ============ 项目路径 ============
function nativeRoot(projectRoot) {
  return path.join(projectRoot, '.workflow', 'native');
}
function changesRoot(projectRoot) {
  return path.join(nativeRoot(projectRoot), 'changes');
}
function pointerPath(projectRoot) {
  return path.join(nativeRoot(projectRoot), 'current.json');
}

// ============ CLI ============
const EXIT = { OK: 0, USAGE: 64, DATA: 65, CONFLICT: 73, REPAIR: 75 };

class RepairError extends Error {}

function out(payload, code = EXIT.OK) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = code;
}

function fail(code, errCode, message, extra = {}) {
  out({ ok: false, error: { code: errCode, message }, ...extra }, code);
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      if (['json', 'confirmed'].includes(key)) opts[key] = true;
      else { opts[key] = argv[i + 1]; i += 1; }
    } else opts._.push(a);
  }
  return opts;
}

async function readPointer(projectRoot) {
  const pointer = await readJsonSafe(pointerPath(projectRoot));
  // 指针内容校验：非法 change 名（如路径逃逸）按损坏指针处理——删除并视为无 active change，
  // 统一保护 cmdStatus/cmdNext/cmdArchive 的 path.join（与 cmdStatus 自愈语义一致）。
  if (pointer?.change && !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(pointer.change)) {
    await fsp.rm(pointerPath(projectRoot), { force: true });
    return null;
  }
  return pointer;
}

async function writePointer(projectRoot, name) {
  await fsp.mkdir(nativeRoot(projectRoot), { recursive: true });
  await atomicWriteFile(pointerPath(projectRoot), JSON.stringify({ change: name }));
}

async function findDocumentCandidates(projectRoot) {
  const root = changesRoot(projectRoot);
  let entries;
  try { entries = await fsp.readdir(root, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(entry.name)) continue;
    const brief = path.join(root, entry.name, 'brief.md');
    if (fs.existsSync(brief)) candidates.push(entry.name);
  }
  return candidates.sort();
}

async function cmdNew(projectRoot, flow, opts) {
  const name = opts.name;
  if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name)) {
    return fail(EXIT.USAGE, 'usage', '--name 必须是 kebab-case（小写字母/数字/中划线）');
  }
  const existing = await readPointer(projectRoot);
  if (existing?.change) {
    return fail(EXIT.DATA, 'state', `已有 active change: ${existing.change}（请先归档或处理）`);
  }
  const candidates = await findDocumentCandidates(projectRoot);
  if (candidates.length > 0) {
    return fail(EXIT.DATA, 'state', `发现已共享但未选择的 active change: ${candidates.join(', ')}（请先运行 feai native resume --name <name>）`, { candidates });
  }
  const changeDir = path.join(changesRoot(projectRoot), name);
  if (fs.existsSync(changeDir)) return fail(EXIT.DATA, 'state', `change 目录已存在: ${name}`);
  await fsp.mkdir(changeDir, { recursive: true });
  const state = initState(flow, new Date().toISOString());
  await writeState(changeDir, state, { expectRevision: 0 });
  await writePointer(projectRoot, name);
  const stored = await readState(changeDir);
  out({
    ok: true, command: 'new', change: name, phase: stored.current_step, revision: stored.revision,
    continuation: deriveContinuation({ flow, state: stored, change: name }),
  });
}

async function cmdStatus(projectRoot, flow) {
  const pointer = await readPointer(projectRoot);
  const noActive = async (healed = false) => {
    const candidates = await findDocumentCandidates(projectRoot);
    const needsSelection = candidates.length > 0;
    return out({
    ok: true, command: 'status', active: false, healed,
    ...(needsSelection ? { candidates } : {}),
    continuation: {
      schema: 'feai.native.continuation.v1', change: null, phase: null, revision: null,
      disposition: 'await-user', reason: needsSelection ? 'resume-selection-required' : 'no-active-change',
      findings: needsSelection
        ? [{ kind: 'resume-candidates', detail: `发现 ${candidates.length} 个已共享 change，请显式选择恢复` }]
        : [{ kind: 'info', detail: '无 active change，新需求请运行 /feai-start' }],
      suggested_command: needsSelection
        ? `feai native resume --name ${candidates[0]} --json`
        : 'feai native new --name <kebab-slug> --json',
    },
  });
  };
  if (!pointer?.change) return noActive();
  const changeDir = path.join(changesRoot(projectRoot), pointer.change);
  if (!fs.existsSync(path.join(changeDir, 'state.yaml'))) {
    await fsp.rm(pointerPath(projectRoot), { force: true }); // 指针自愈
    return noActive(true);
  }
  const state = await readState(changeDir);
  out({
    ok: true, command: 'status', active: true, change: pointer.change,
    phase: state.current_step, revision: state.revision,
    continuation: deriveContinuation({ flow, state, change: pointer.change }),
  });
}

async function cmdResume(projectRoot, flow, opts) {
  const name = opts.name;
  if (!name || !/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(name)) {
    return fail(EXIT.USAGE, 'usage', '--name 必须是 kebab-case（小写字母/数字/中划线）');
  }
  const pointer = await readPointer(projectRoot);
  if (pointer?.change && pointer.change !== name) {
    return fail(EXIT.DATA, 'state', `本工作树已有 active change: ${pointer.change}`);
  }
  const changeDir = path.join(changesRoot(projectRoot), name);
  if (!fs.existsSync(path.join(changeDir, 'brief.md'))) {
    return fail(EXIT.DATA, 'state', `未找到可恢复的共享 brief: ${name}`);
  }
  let state;
  let reconstructed = false;
  if (fs.existsSync(path.join(changeDir, 'state.yaml'))) {
    state = await readState(changeDir);
  } else {
    // state.yaml 是本地忽略的运行态。跨设备恢复时从已提交 brief 安全重建到
    // shape，要求重新确认契约，而不是猜测此前执行到哪个阶段。
    state = initState(flow, new Date().toISOString());
    await writeState(changeDir, state, { expectRevision: 0 });
    reconstructed = true;
  }
  await writePointer(projectRoot, name);
  const stored = await readState(changeDir);
  out({
    ok: true, command: 'resume', change: name, phase: stored.current_step,
    revision: stored.revision, reconstructed,
    continuation: deriveContinuation({ flow, state: stored, change: name }),
  });
}

// ============ next 推进 ============
function requestFingerprint({ command, outcome, signature, summary, confirmed }) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    command, outcome: outcome ?? null, signature: signature ?? null,
    summary: summary ?? null, confirmed: Boolean(confirmed),
  })).digest('hex')}`;
}

async function appendAudit(changeDir, entry) {
  try {
    await fsp.appendFile(path.join(changeDir, 'audit.log'), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
  } catch { /* 审计允许滞后 */ }
}

async function cmdNext(projectRoot, flow, opts) {
  const pointer = await readPointer(projectRoot);
  if (!pointer?.change) return fail(EXIT.DATA, 'state', '无 active change');
  const changeDir = path.join(changesRoot(projectRoot), pointer.change);
  const lock = await acquireLock(changeDir, 'next');
  try {
    const state = await readState(changeDir);
    if (opts['expect-revision'] !== undefined && Number(opts['expect-revision']) !== state.revision) {
      return fail(EXIT.CONFLICT, 'conflict', `revision 不匹配（期望 ${opts['expect-revision']}，实际 ${state.revision}），请重新 status 后重试`);
    }
    const fingerprint = requestFingerprint({
      command: 'next', outcome: opts.outcome,
      signature: opts.signature, summary: opts.summary, confirmed: opts.confirmed,
    });
    // 终态推进（to=null）时 current_step 停在 from，回退到 from 比较，保证终态重放可命中
    const lastTo = state.last_transition?.to ?? state.last_transition?.from;
    if (
      state.last_transition?.fingerprint === fingerprint
      && lastTo === state.current_step
      && state.last_transition.result
    ) {
      return out({ ...state.last_transition.result, replayed: true });
    }
    const stepDef = flow.stepMap.get(state.current_step);
    const nextStep = resolveNext(flow, state.current_step, opts.outcome);

    // Guard 检查（require_field / require_approval）——只在完成性推进时检查；
    // outcome=fail 的回退不检查 guards（回退由失败追踪把关，失败声明无需防伪）
    const findings = opts.outcome === 'fail' ? [] : checkStepGuards({
      flow, stepDef, submission: { summary: opts.summary, report: opts.report, confirmed: opts.confirmed },
      changeDir, state,
    });
    if (findings.length > 0) {
      return out({
        ok: true, command: 'next', change: pointer.change, phase: state.current_step, revision: state.revision,
        continuation: deriveContinuation({ flow, state, change: pointer.change, findings }),
      });
    }

    // 失败签名追踪（fail + 边带 repeated-failure）
    let repair = null;
    if (opts.outcome === 'fail' && edgeGuard(flow, state.current_step, 'fail') === 'repeated-failure') {
      if (!opts.signature) return fail(EXIT.USAGE, 'usage', 'outcome=fail 且边带 repeated-failure 时 --signature 必传');
      recordFailure(state.failure, opts.signature);
      const v = failureVerdict(state.failure, flow.limits, Boolean(opts.confirmed));
      if (v.verdict === 'stop' || v.verdict === 'hard-stop') {
        // stop 也要落幂等指纹（from=to=当前步）：同一 fail 请求重试命中重放，
        // 不重复 recordFailure，避免失败计数被纯重试侵蚀（stop → hard-stop 漂移）。
        const stopRevision = state.revision + 1; // writeState 落盘后的 revision
        const continuation = deriveContinuation({
          flow, state: { ...state, revision: stopRevision }, change: pointer.change, repair: v,
        });
        const result = {
          ok: false, command: 'next', change: pointer.change,
          phase: state.current_step, revision: stopRevision,
          continuation,
        };
        state.last_transition = {
          fingerprint, from: state.current_step, to: state.current_step,
          at: new Date().toISOString(), result,
        };
        await writeState(changeDir, state, { expectRevision: state.revision });
        await appendAudit(changeDir, { type: 'repair', verdict: v.verdict, signature: opts.signature });
        return out(result, EXIT.REPAIR);
      }
      if (v.verdict === 'override') {
        state.failure.overrides_used.push(v.signature);
        state.failure.consecutive_same = 0;
      }
      repair = { ...v, consecutive: state.failure.consecutive_same };
    }

    // 推进（单次原子写：transition + 幂等指纹 + 完整重放结果一起落盘，无中间态）
    const from = state.current_step;
    state.steps[from].status = 'done';
    if (opts.outcome) state.steps[from].outcome = opts.outcome;
    if (nextStep !== null) {
      state.current_step = nextStep;
      state.steps[nextStep].status = 'in_progress';
      state.steps[nextStep].attempts = (state.steps[nextStep].attempts ?? 0) + 1;
    }
    const nextRevision = state.revision + 1; // writeState 落盘后的 revision
    const advancedState = { ...state, revision: nextRevision };
    const continuation = deriveContinuation({ flow, state: advancedState, change: pointer.change, repair });
    const result = {
      ok: true, command: 'next', change: pointer.change,
      phase: advancedState.current_step, revision: nextRevision,
      continuation,
    };
    state.last_transition = { fingerprint, from, to: nextStep, at: new Date().toISOString(), result };
    await writeState(changeDir, state, { expectRevision: state.revision });
    await appendAudit(changeDir, { type: 'transition', from, to: nextStep, outcome: opts.outcome ?? null, fingerprint });
    return out(result);
  } finally {
    await lock.release();
  }
}

// ============ archive ============
async function cmdArchive(projectRoot, flow) {
  const pointer = await readPointer(projectRoot);
  if (!pointer?.change) return fail(EXIT.DATA, 'state', '无 active change');
  const changeDir = path.join(changesRoot(projectRoot), pointer.change);
  const lock = await acquireLock(changeDir, 'archive');
  try {
    const state = await readState(changeDir);
    if (!isTerminalStep(flow, state.current_step)) {
      return fail(EXIT.DATA, 'state', `当前阶段 ${state.current_step} 不能归档（需在 ${flow.steps.at(-1).id} 阶段）`);
    }
    // 终步标记 done（若 next --outcome done 尚未走过，这里补齐）
    state.steps[state.current_step].status = 'done';
    const stored = await writeState(changeDir, state, { expectRevision: state.revision });
    await appendAudit(changeDir, { type: 'archive', change: pointer.change });
    // 原子 rename → 再清指针；崩溃残留由 status 自愈
    const archiveRoot = path.join(nativeRoot(projectRoot), 'archive');
    await fsp.mkdir(archiveRoot, { recursive: true });
    const target = path.join(archiveRoot, pointer.change);
    if (fs.existsSync(target)) return fail(EXIT.DATA, 'state', `archive 目标已存在: ${pointer.change}`);
    await fsp.rename(changeDir, target);
    await fsp.rm(pointerPath(projectRoot), { force: true });
    return out({
      ok: true, command: 'archive', change: pointer.change,
      continuation: {
        schema: 'feai.native.continuation.v1', change: pointer.change,
        phase: state.current_step, revision: stored.revision,
        disposition: 'done', reason: 'complete', findings: [], suggested_command: null,
      },
    });
  } finally {
    await lock.release().catch(() => {}); // 目录已移动时锁文件随之搬走，忽略释放失败
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const opts = parseArgs(argv.slice(1));
  const projectRoot = process.cwd();
  const flowPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'flow.yaml');
  let flow;
  try {
    flow = loadFlow(flowPath);
  } catch (e) {
    return fail(EXIT.DATA, 'state', `flow.yaml 加载失败: ${e.message}`);
  }
  try {
    if (command === 'new') return await cmdNew(projectRoot, flow, opts);
    if (command === 'status') return await cmdStatus(projectRoot, flow);
    if (command === 'resume') return await cmdResume(projectRoot, flow, opts);
    if (command === 'next') return await cmdNext(projectRoot, flow, opts);
    if (command === 'archive') return await cmdArchive(projectRoot, flow);
    return fail(EXIT.USAGE, 'usage', `未知命令: ${command ?? '(空)'}（可用: new|status|resume|next|archive）`);
  } catch (e) {
    if (e instanceof UsageError) return fail(EXIT.USAGE, 'usage', e.message);
    if (e instanceof StateError) return fail(EXIT.DATA, 'state', e.message);
    if (e instanceof LockConflictError) return fail(EXIT.CONFLICT, 'conflict', e.message, { owner: e.owner });
    if (e instanceof RepairError) return fail(EXIT.REPAIR, 'repair', e.message);
    return fail(EXIT.DATA, 'state', e.message ?? String(e));
  }
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) main();

export { parseYaml, dumpYaml, loadFlow, atomicWriteFile, acquireLock, LockConflictError, initState, readState, writeState, StateError, resolveNext, edgeGuard, checkStepGuards, UsageError, recordFailure, failureVerdict, isTerminalStep, deriveContinuation, RepairError };
