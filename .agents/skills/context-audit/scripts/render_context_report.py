#!/usr/bin/env python3
"""Render a self-contained Context Readiness & Remediation Report (TMR)."""

from __future__ import annotations

import argparse
import html
import importlib.util
import json
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "context_audit_runtime", SCRIPT_DIR / "audit_context.py",
)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError("cannot load audit_context.py")
AUDIT_MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT_MODULE)


def esc(value: Any) -> str:
    return html.escape(str(value), quote=True)


def score_text(value: float | None) -> str:
    return "待评测" if value is None else f"{value:g} / 100"


def text_value(value: Any, empty: str = "未记录") -> str:
    if value is None or value == "" or value == [] or value == {}:
        return empty
    if isinstance(value, bool):
        return "是" if value else "否"
    if isinstance(value, (dict, list, tuple)):
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    return str(value)


def command_text(value: Any) -> str:
    if isinstance(value, list):
        return " ".join(str(part) for part in value)
    return text_value(value)


def hash_manifest_text(value: Any) -> str:
    if isinstance(value, dict):
        return "；".join(f"{key}: {text_value(item)}" for key, item in value.items())
    if isinstance(value, list):
        entries: list[str] = []
        for item in value:
            if isinstance(item, dict):
                label = item.get("path") or item.get("name") or item.get("stream") or "item"
                digest = item.get("sha256") or item.get("hash") or item.get("digest")
                entries.append(f"{label}: {text_value(digest)}")
            else:
                entries.append(str(item))
        return "；".join(entries) if entries else "未记录"
    return text_value(value)


def output_hashes_text(item: dict[str, Any]) -> str:
    value = item.get("output_hashes")
    if value:
        return hash_manifest_text(value)
    outputs = {
        key.removesuffix("_sha256"): item[key]
        for key in ("stdout_sha256", "stderr_sha256")
        if item.get(key)
    }
    return hash_manifest_text(outputs)


def receipt_evidence_cards(items: list[dict[str, Any]]) -> str:
    if not items:
        return (
            '<div class="banner">当前结果未包含已核验的 Validator/测试回执。'
            "这不等同于检查失败；未评测阶段通常没有回执。</div>"
        )
    cards: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        claim = item.get("claim") or item.get("claim_id") or item.get("observation_id")
        artifact = item.get("artifact_path") or item.get("receipt") or item.get("path")
        artifact_sha = item.get("artifact_sha256") or item.get("receipt_sha256")
        selector = item.get("selector") or item.get("expected_output") or item.get("output_assertion")
        recorded_at = item.get("recorded_at") or item.get("started_at")
        duration = item.get("duration_ms")
        duration_text = f"{duration} ms" if duration is not None else "未记录"
        cards.append(
            f"""
            <article class="evidence-card">
              <div class="dimension-head"><h3><code>{esc(text_value(claim, '未绑定 claim'))}</code></h3><span>{esc(text_value(item.get('kind'), 'check'))}</span></div>
              <dl>
                <dt>命令</dt><dd><code>{esc(command_text(item.get('command')))}</code></dd>
                <dt>回执</dt><dd><code>{esc(text_value(artifact))}</code></dd>
                <dt>回执 SHA-256</dt><dd><code>{esc(text_value(artifact_sha))}</code></dd>
                <dt>输入 hashes</dt><dd><code>{esc(hash_manifest_text(item.get('input_hashes') or item.get('input_files')))}</code></dd>
                <dt>输出 hashes</dt><dd><code>{esc(output_hashes_text(item))}</code></dd>
                <dt>expect selector</dt><dd><code>{esc(text_value(selector))}</code></dd>
                <dt>执行指纹</dt><dd><code>{esc(text_value(item.get('execution_fingerprint')))}</code></dd>
                <dt>退出码 / 时间</dt><dd><code>{esc(text_value(item.get('exit_code')))}</code> · {esc(text_value(recorded_at))} · {esc(duration_text)}</dd>
              </dl>
            </article>
            """
        )
    return "".join(cards) or '<div class="banner">回执清单存在，但没有可展示的结构化条目。</div>'


def git_evidence_rows(items: list[dict[str, Any]]) -> str:
    rows: list[str] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        rows.append(
            "<tr>"
            f"<td><code>{esc(text_value(item.get('observation_id') or item.get('claim') or item.get('claim_id')))}</code></td>"
            f"<td><code>{esc(text_value(item.get('path')))}</code></td>"
            f"<td><code>{esc(text_value(item.get('commit')))}</code></td>"
            f"<td>{esc(text_value(item.get('statement')))}</td>"
            f"<td>{esc(text_value(item.get('proves')))}</td>"
            f"<td>{esc(text_value(item.get('does_not_prove')))}</td>"
            "</tr>"
        )
    if rows:
        return "".join(rows)
    return '<tr><td colspan="6">当前结果未包含 Assessment 引用的逐项 Git path + commit 证据。</td></tr>'


def evidence_text(items: list[dict[str, Any]]) -> str:
    if not items:
        return "尚未由 Agent 核查"
    parts: list[str] = []
    for item in items:
        prefix = item.get("kind", "evidence")
        path = item.get("path")
        statement = item.get("statement", "")
        parts.append(f"{prefix}: {path + ' · ' if path else ''}{statement}")
    return "；".join(parts)


def observation_rows(
    observations: dict[str, Any], definitions: list[dict[str, Any]],
) -> str:
    rows: list[str] = []
    for definition in definitions:
        claim_id = definition["id"]
        item = observations.get(claim_id, {})
        status = item.get("status", "unknown")
        labels = {"pass": "满足", "partial": "部分满足", "fail": "未满足", "unknown": "待核查"}
        flags = []
        if definition.get("critical"):
            flags.append("P0 门禁")
        if definition.get("strong"):
            flags.append("强证据")
        meta = f" · {' / '.join(flags)}" if flags else ""
        limitations = item.get("limitations") or []
        rows.append(
            "<tr>"
            f"<td><code>{esc(claim_id)}</code><br>{esc(definition['label'] + meta)}</td>"
            f"<td><span class='status {esc(status)}'>{esc(labels.get(status, status))}</span></td>"
            f"<td>{esc(item.get('subject') or '待映射')}</td>"
            f"<td>{esc(item.get('rationale') or '尚未完成 Agent 判断')}</td>"
            f"<td>{esc(evidence_text(item.get('evidence', [])))}</td>"
            f"<td>{esc('；'.join(limitations) if limitations else '未记录额外限制')}</td>"
            "</tr>"
        )
    return "".join(rows)


def dimension_cards(result: dict[str, Any], scope: str) -> str:
    rationales = result["dimension_rationale"][scope]
    scores = (
        result["dimensions"]
        if scope == "context_control_plane"
        else result["documentation"]["dimensions"]
    )
    levels = (
        result.get("derived_levels", {})
        if scope == "context_control_plane"
        else result["documentation"].get("derived_levels", {})
    )
    assessments = result["dimension_assessments"][scope]
    cards: list[str] = []
    for key, rationale in rationales.items():
        score = scores.get(key)
        score_label = "待评测" if score is None else f"{score:g} / {rationale['weight']}"
        assessment = assessments.get(key, {})
        level = levels.get(key)
        level_label = "待评测" if level is None else f"L{level:g} / 4"
        rows = observation_rows(
            assessment.get("observations", {}), rationale.get("observations", []),
        )
        cards.append(
            f"""
            <article class="dimension-card">
              <div class="dimension-head"><h3>{esc(rationale['label'])}</h3><span>{esc(score_label)}</span></div>
              <dl>
                <dt>成熟度</dt><dd>{esc(level_label)}</dd>
                <dt>为什么评</dt><dd>{esc(rationale['why_evaluate'])}</dd>
                <dt>为什么占分</dt><dd>{esc(rationale['why_this_weight'])}</dd>
                <dt>Agent 判断</dt><dd>{esc(assessment.get('rationale') or '尚未完成')}</dd>
                <dt>能证明</dt><dd>{esc(rationale['proves'])}</dd>
                <dt>不能证明</dt><dd>{esc(rationale['does_not_prove'])}</dd>
              </dl>
              <table class="observations"><thead><tr><th>观察项</th><th>状态</th><th>对象</th><th>Agent 判断</th><th>实际证据</th><th>限制</th></tr></thead><tbody>{rows}</tbody></table>
            </article>
            """
        )
    return "".join(cards)


def finding_rows(findings: list[dict[str, Any]]) -> str:
    if not findings:
        return '<tr><td colspan="4">当前没有已确认发现。</td></tr>'
    return "".join(
        f"<tr><td><span class='severity {esc(str(item.get('severity', 'P2')).lower())}'>{esc(item.get('severity', 'P2'))}</span></td>"
        f"<td>{esc(item.get('dimension', 'cross_cutting'))}</td>"
        f"<td>{esc(item.get('message') or item.get('title') or item.get('rationale', ''))}</td>"
        f"<td><code>{esc(item.get('observation_id') or item.get('evidence', ''))}</code></td></tr>"
        for item in findings
    )


def render(result: dict[str, Any], repo: Path) -> str:
    documentation = result["documentation"]
    profile = result["repository_profile"]
    discovery = result["discovery"]
    inventory = discovery["inventory"]
    git = result["git_evidence"]
    repository = result.get("repository") or {}
    discovery_repository = discovery.get("repository") or {}
    snapshot = discovery_repository.get("worktree_snapshot") or {}
    assessment_scope = (
        result.get("assessment_scope")
        or repository.get("assessment_scope")
        or discovery_repository.get("assessment_scope")
    )
    evidence_grade_reason = result.get("evidence_grade_reason") or (
        "当前结果未提供证据等级推导理由。"
    )
    receipt_evidence = result.get("receipt_evidence") or []
    git_assessment_evidence = result.get("git_assessment_evidence") or []
    gate_labels = {
        "not_assessed": "待 Agent 评测",
        "blocked": "P0 阻断",
        "needs_improvement": "未达到门禁",
        "passed": "通过",
    }
    gate_status = gate_labels.get(result["gate_status"], result["gate_status"])
    profile_class = profile.get("class") or "待评测"
    actions = "".join(f"<li>{esc(action)}</li>" for action in result["actions"])
    commands = "\n".join(
        f"exit {item.get('exit_code')} · {' '.join(item.get('command', []))}"
        for item in git.get("executed_commands", [])
    )
    assessment_errors = "".join(
        f"<li>{esc(error)}</li>" for error in result.get("assessment_errors", [])
    )
    error_block = (
        f'<div class="banner bad"><strong>Assessment 无效</strong><ul>{assessment_errors}</ul></div>'
        if assessment_errors else ""
    )
    context_cards = dimension_cards(result, "context_control_plane")
    documentation_cards = dimension_cards(result, "repository_documentation")
    receipt_cards = receipt_evidence_cards(receipt_evidence)
    git_assessment_rows = git_evidence_rows(git_assessment_evidence)
    return f"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Context Readiness &amp; Remediation Report</title>
  <style>
    :root{{--ink:#18212f;--muted:#657084;--line:#dce3ed;--soft:#f5f8fc;--brand:#2859d6;--good:#127a55;--warn:#9b6400;--bad:#b42318}}
    *{{box-sizing:border-box}} body{{margin:0;font:15px/1.65 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:var(--ink);background:#edf2f8}}
    main{{width:min(1180px,calc(100% - 32px));margin:32px auto 64px;background:white;border:1px solid var(--line);box-shadow:0 18px 60px rgba(24,33,47,.08)}}
    header,section{{padding:34px 42px}} header{{background:linear-gradient(135deg,#17223b,#2859d6);color:white}} h1{{margin:0 0 10px;font-size:32px}} h2{{margin:0 0 10px;font-size:23px}} h3{{margin:0;font-size:16px}} p{{margin:8px 0}} code{{font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}}
    .eyebrow{{font-size:12px;letter-spacing:.12em;text-transform:uppercase;opacity:.78}} .lede{{max-width:900px;color:#e4eafa}}
    .score-grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-top:24px}} .score{{padding:16px;border:1px solid rgba(255,255,255,.22);background:rgba(255,255,255,.08)}} .score strong{{display:block;font-size:25px}} .score small{{opacity:.82}}
    section+section{{border-top:1px solid var(--line)}} .section-copy{{color:var(--muted);max-width:920px}}
    .banner{{margin:18px 0 0;padding:16px 18px;border-left:4px solid var(--brand);background:var(--soft)}} .banner.bad{{border-color:var(--bad)}}
    .dimensions{{display:grid;grid-template-columns:1fr;gap:16px;margin-top:20px}} .dimension-card{{border:1px solid var(--line);padding:18px;background:#fff}}
    .dimension-head{{display:flex;justify-content:space-between;gap:16px;border-bottom:1px solid var(--line);padding-bottom:10px}} .dimension-head span{{font-weight:700;color:var(--brand)}}
    dl{{display:grid;grid-template-columns:105px 1fr;gap:8px 12px;margin:14px 0 0}} dt{{font-weight:700;color:#3f4b60}} dd{{margin:0;color:var(--muted)}}
    table{{width:100%;border-collapse:collapse;margin-top:18px}} th,td{{text-align:left;vertical-align:top;padding:10px;border:1px solid var(--line)}} th{{background:var(--soft)}}
    .observations{{font-size:13px}} .observations th:nth-child(1){{width:21%}} .status{{display:inline-block;padding:2px 8px;border-radius:10px;white-space:nowrap}} .status.pass{{background:#dcfce7;color:var(--good)}} .status.partial{{background:#fff0c7;color:var(--warn)}} .status.fail{{background:#fee4e2;color:var(--bad)}} .status.unknown{{background:#e7edf5;color:var(--muted)}}
    .severity{{display:inline-block;min-width:38px;text-align:center;border-radius:12px;font-weight:700}} .p0{{color:var(--bad);background:#fee4e2}} .p1{{color:var(--warn);background:#fff0c7}} .p2{{color:var(--good);background:#dcfce7}}
    .rounds{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:20px}} .round{{border:1px solid var(--line);padding:18px}} .round b{{color:var(--brand)}}
    .evidence-list{{display:grid;grid-template-columns:1fr;gap:16px;margin-top:18px}} .evidence-card{{border:1px solid var(--line);padding:18px;background:#fff}}
    pre{{padding:16px;background:#111827;color:#d9e4f7;white-space:pre-wrap;overflow-wrap:anywhere}} ol,ul{{padding-left:22px}}
    footer{{padding:20px 42px;color:var(--muted);border-top:1px solid var(--line);background:var(--soft)}}
    @media(max-width:850px){{.score-grid,.dimensions,.rounds{{grid-template-columns:1fr}}header,section{{padding:26px 22px}}dl{{grid-template-columns:1fr}}}}
  </style>
</head>
<body><main>
  <header>
    <div class="eyebrow">Repository context engineering · evidence-led audit</div>
    <h1>Context Readiness &amp; Remediation Report</h1>
    <p class="lede">仓库：{esc(repo)}。脚本负责发现与验证证据契约；维度判断由 Agent 根据当前文件、Git、Validator、测试和抽样事实完成。</p>
    <div class="score-grid">
      <div class="score"><small>Context 控制面</small><strong>{esc(score_text(result['score']))}</strong></div>
      <div class="score"><small>Repository Documentation</small><strong>{esc(score_text(documentation['score']))}</strong></div>
      <div class="score"><small>仓库画像</small><strong>{esc(profile_class)}</strong></div>
      <div class="score"><small>证据等级</small><strong>{esc(result['evidence_grade'])}</strong></div>
    </div>
  </header>
  <section>
    <h2>结论与证据边界</h2>
    <p class="section-copy">{esc(profile['rationale'])}</p>
    <div class="banner"><strong>当前门禁：{esc(gate_status)}</strong>。未完成 Agent Assessment 时不生成数值分数；完成后仍只表示证据覆盖范围内的仓库上下文成熟度。</div>
    <div class="banner"><strong>证据等级 {esc(result['evidence_grade'])}</strong>：{esc(evidence_grade_reason)}</div>
    {error_block}
  </section>
  <section>
    <h2>评测锚点</h2>
    <dl>
      <dt>Schema</dt><dd><code>{esc(text_value(result.get('schema_version')))}</code></dd>
      <dt>Assessment 范围</dt><dd>{esc(text_value(assessment_scope, '未记录；待 Agent 确定核查范围'))}</dd>
      <dt>HEAD</dt><dd><code>{esc(text_value(repository.get('head') or git.get('head')))}</code></dd>
      <dt>Worktree 指纹</dt><dd><code>{esc(text_value(repository.get('worktree_fingerprint') or snapshot.get('fingerprint')))}</code></dd>
      <dt>发现时点</dt><dd>{esc(text_value(result.get('discovered_at') or discovery.get('discovered_at') or discovery_repository.get('discovered_at')))}</dd>
    </dl>
  </section>
  <section>
    <h2>自动发现结果</h2>
    <p class="section-copy">扫描 {discovery['repository']['files_scanned']} 个非忽略文件；发现 {len(inventory['documents'])} 份文档、{len(inventory['instructions'])} 个指令候选、{len(inventory['owner_sources'])} 个 Owner 来源候选、{len(inventory['services'])} 个组件候选、{len(inventory['validator_candidates'])} 个 Validator/测试候选。审计器自身排除 {len(discovery.get('tooling_excluded', []))} 个文件；扫描截断：{esc(discovery['repository'].get('scan_truncated', False))}。</p>
    <div class="banner">链接检查范围：{esc(discovery['links'].get('scope'))}；检查 {discovery['links']['checked']} 条，发现 {discovery['links']['broken_count']} 个待 Agent 判定的失效候选；重复文档组 {len(inventory['duplicate_document_groups'])} 个。候选数量不会自动换算为分数。</div>
  </section>
  <section>
    <h2>Context 控制面：8 个维度</h2>
    <div class="dimensions">{context_cards}</div>
  </section>
  <section>
    <h2>Repository Documentation：6 个维度</h2>
    <div class="dimensions">{documentation_cards}</div>
  </section>
  <section>
    <h2>问题与优先级</h2>
    <h3>Context 控制面</h3><table><thead><tr><th>级别</th><th>维度</th><th>发现</th><th>证据</th></tr></thead><tbody>{finding_rows(result['findings'])}</tbody></table>
    <h3 style="margin-top:24px">Repository Documentation</h3><table><thead><tr><th>级别</th><th>维度</th><th>发现</th><th>证据</th></tr></thead><tbody>{finding_rows(documentation['findings'])}</tbody></table>
  </section>
  <section>
    <h2>Git 发现与执行记录</h2>
    <p class="section-copy">历史可用性：{esc(git.get('availability'))}；HEAD：{esc(git.get('head'))}；分支：{esc(git.get('branch'))}；dirty 路径：{len(git.get('dirty_paths', []))}；已执行历史抽样：{len(git.get('history_samples', []))}。</p>
    <pre>{esc(commands)}</pre>
  </section>
  <section>
    <h2>Assessment Git 证据</h2>
    <p class="section-copy">逐项显示 Agent Assessment 实际引用的路径和完整 commit；历史发现候选不自动等于 Assessment 证据，Owner 也不能由提交次数推断。</p>
    <table><thead><tr><th>Observation</th><th>Path</th><th>Commit</th><th>事实陈述</th><th>能证明</th><th>不能证明</th></tr></thead><tbody>{git_assessment_rows}</tbody></table>
  </section>
  <section>
    <h2>Validator / Test 回执</h2>
    <p class="section-copy">仅展示经审计器重新核验、绑定 claim 与仓库快照的执行事实。Selector 用于断言结果，不参与跨 claim 去重；同一执行指纹不能重复支持多个 claim。</p>
    <div class="evidence-list">{receipt_cards}</div>
  </section>
  <section>
    <h2>三轮建设规划</h2>
    <p class="section-copy">首次评测默认只读。用户确认后再创建 Goal，并按目标仓库自己的结构实施。</p>
    <div class="rounds">
      <article class="round"><b>Round 1 · 盘点与责任</b><p>确认文档母集、真实组件边界、Owner 来源和最短入口。</p></article>
      <article class="round"><b>Round 2 · 权威与控制面</b><p>建立权威映射、按需路由、生命周期、评测隔离与可执行门禁。</p></article>
      <article class="round"><b>Round 3 · 压缩与证据</b><p>治理重复和过期内容，补齐 Git、内容抽检、Validator、Receipt 或 Trace。</p></article>
    </div>
    <h3 style="margin-top:24px">当前建议</h3><ol>{actions}</ol>
  </section>
  <footer>Generated by context-audit · Agent 主审，脚本取证与确定性算分。</footer>
</main></body></html>"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--assessment", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    repo = args.repo.resolve()
    result = AUDIT_MODULE.audit(repo, args.assessment)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render(result, repo), encoding="utf-8")
    print(args.output.resolve())
    return 2 if result["assessment_status"] == "invalid" else 0


if __name__ == "__main__":
    raise SystemExit(main())
