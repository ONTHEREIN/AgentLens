"""自包含 HTML 报告：一次运行 → 一个 .html 文件，断网可开、可直接发给评委或附在缺陷单里。

报告是 `traces.jsonl` 的二次生成物，不另存真相：页脚写明源文件的 sha256，
每条失败都带归因层、理由、证据 span 与完整链路，能顺着 run_id 找回原始数据。
统计口径全部复用 `audit.py`（与审计台、命令行门禁同一份逻辑），这里只负责排版。

    python -m agentlens report <run_id>                       # → results/<run_id>/report.html
    python -m agentlens report <run_id> --baseline <run_id>   # 附基线门禁
"""

from __future__ import annotations

import hashlib
import json
from html import escape
from pathlib import Path
from typing import Any

from . import __version__, audit
from .cases import Case, load_cases
from .runner import load_run
from .schema import LAYER_NAMES


def load_case_index(root: Path) -> dict[str, Case]:
    """cases/ 及其一级子目录下的全部用例，按 id 索引（报告要用维度、标题、提问与注入信息）。"""
    index: dict[str, Case] = {}
    for d in [root, *sorted(p for p in root.iterdir() if p.is_dir())]:
        if any(d.glob("*.yaml")):
            index.update({c.id: c for c in load_cases(d)})
    return index


SOURCE_LABELS = {"golden": "人工用例", "llm": "LLM 改写", "mutated": "录制变异"}


def _e(value: Any) -> str:
    return escape(str(value), quote=True)


def _ms(value: float | None) -> str:
    return "—" if value is None else f"{value:,.0f}ms"


def _short(value: Any, limit: int = 160) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
    return text if len(text) <= limit else text[:limit] + "…"


def _span_summary(span: dict[str, Any]) -> str:
    kind = span["span"]
    if kind == "plan":
        return f"意图：{_e(_short(span.get('intent', '')))}<br>步骤：<code>{_e(span.get('steps', []))}</code>"
    if kind == "tool_call":
        bad = "" if span.get("schema_ok", True) else f" <b class='bad'>参数不合法：{_e('; '.join(span.get('schema_errors', [])))}</b>"
        return f"<code>{_e(span['name'])}({_e(_short(span.get('args', {})))})</code>{bad}"
    if kind == "observation":
        if not span.get("ok", True):
            return f"<b class='bad'>报错：{_e(span.get('error') or '?')}</b>"
        rows = span.get("row_count")
        raw = span.get("raw")
        return (f"ok · {rows} 行" if rows is not None else "ok") + (
            f"<div class='raw'>{_e(_short(raw, 400))}</div>" if raw is not None else ""
        )
    if kind == "retrieve":
        hits = span.get("chunk_ids", [])
        return f"查询「{_e(span.get('query', ''))}」→ {'零召回' if not hits else _e(', '.join(hits))}"
    if kind == "guardrail":
        if not span.get("triggered"):
            return "未触发"
        return f"触发 <code>{_e(span.get('rule'))}</code> → {_e(span.get('action'))}" + (
            f"：{_e(span.get('reason'))}" if span.get("reason") else ""
        )
    if kind == "generate":
        cites = span.get("citations", [])
        return "生成回答" + (f" · 引用 {_e(', '.join(cites))}" if cites else "")
    return ""


def _spans_table(trace: dict[str, Any]) -> str:
    evidence = set(trace.get("layer_evidence", [])) | {
        e for c in trace["verdict"]["checks"] if not c["passed"] for e in c.get("evidence", [])
    }
    rows = "".join(
        f"<tr class='{'ev' if s['span_id'] in evidence else ''}'>"
        f"<td class='mono'>{_e(s['span_id'])}</td><td>{_e(audit.SPAN_LABELS.get(s['span'], s['span']))}</td>"
        f"<td>{_span_summary(s)}</td><td class='num'>{_ms(s.get('latency_ms'))}</td></tr>"
        for s in trace["spans"]
    )
    return (
        "<table class='spans'><thead><tr><th>span</th><th>类型</th><th>内容</th><th class='num'>耗时</th></tr></thead>"
        f"<tbody>{rows}</tbody></table>"
    )


def _failure(row: dict[str, Any]) -> str:
    t, case = row["trace"], row["case"] or {}
    layer = t.get("layer") or "?"
    question = (case.get("input", {}).get("messages") or [{}])[-1].get("content", "")
    checks = "".join(
        f"<li><code>{_e(c['check'])}</code> {_e(c['reason'])}</li>"
        for c in t["verdict"]["checks"] if not c["passed"]
    )
    inject = case.get("inject")
    origin = (
        f"<span class='chip warn'>注入 {_e(inject['op'])} · 已知根因 {_e(inject['layer'])}</span>" if inject
        else f"<span class='chip'>{_e(SOURCE_LABELS.get(case.get('source', ''), case.get('source', '?')))}</span>"
    )
    return f"""
    <details class="case" id="{_e(t['case_id'])}">
      <summary>
        <span class="layer l-{_e(layer)}">{_e(layer)}</span>
        <span class="mono">{_e(t['case_id'])}</span>
        <span class="muted">{_e(audit.DIMENSION_LABELS.get(row['dimension'], row['dimension']))}</span>
        {origin}
        <span class="why">{_e(t.get('layer_reason') or '')}</span>
      </summary>
      <div class="case-body">
        <p class="muted">{_e(case.get('title', ''))}</p>
        <p><b>提问</b>　{_e(question)}</p>
        <p><b>失败断言</b></p><ul>{checks}</ul>
        <p><b>回答</b></p><div class="answer">{_e(t.get('answer', ''))}</div>
        <p><b>执行链路</b> <span class="muted">高亮行为证据 span · 端到端 {_ms(t.get('latency_ms'))} ·
          token {t['tokens']['prompt'] + t['tokens']['completion']}</span></p>
        {_spans_table(t)}
      </div>
    </details>"""


def _heatmap(hm: dict[str, Any]) -> str:
    peak = max((n for d in hm["cells"].values() for n in d.values()), default=0) or 1
    head = "".join(f"<th title='{_e(LAYER_NAMES[l])}'>{_e(l)}<small>{_e(LAYER_NAMES[l])}</small></th>" for l in hm["layers"])
    body = ""
    for dim in hm["dimensions"]:
        cells = ""
        for layer in hm["layers"]:
            n = hm["cells"][dim][layer]
            level = 0 if n == 0 else min(4, 1 + int(3 * n / peak))
            cells += f"<td class='h{level}'>{n or ''}</td>"
        label = audit.DIMENSION_LABELS.get(dim, "其他（旧维度）" if dim == "other" else dim)
        body += f"<tr><th>{_e(label)}</th>{cells}</tr>"
    return f"<table class='heat'><thead><tr><th></th>{head}</tr></thead><tbody>{body}</tbody></table>"


def _rate(r: dict[str, Any]) -> str:
    if not r["n"]:
        return "—"
    lo, hi = r["ci"]
    return f"{r['k']}/{r['n']} = {r['rate']}% <small class='muted'>CI {lo}–{hi}</small>"


def _calibration(c: dict[str, Any] | None) -> str:
    if not c:
        return ""
    rows = "".join(
        f"<tr><td>{_e(r['layer'])}</td><td class='mono'>{_e(r['op'])}</td>"
        f"<td>{_rate(r['detected'])}</td><td>{_rate(r['attributed'])}</td></tr>"
        for r in c["by_op"]
    )
    return f"""
    <section><h2>故障注入校准</h2>
      <p class="muted">根因已知的注入样本：裁判能否发现（检出率）、归因能否归对层（归因准确率）。这些失败不计入被测对象缺陷；
      录制变异的算子与归因分支一一对应，高分只说明决策顺序自洽。</p>
      <table class="grid"><thead><tr><th>注入层</th><th>算子</th><th>检出率</th><th>归因准确率</th></tr></thead>
      <tbody>{rows}<tr class="total"><td>合计</td><td></td><td>{_rate(c['detected'])}</td><td>{_rate(c['attributed'])}</td></tr></tbody></table>
    </section>"""


def _gate(g: dict[str, Any] | None, base_id: str | None) -> str:
    if not g:
        return ""
    n = g["counts"]
    moved = [i for i in g["items"] if i["state"] not in ("still_passing",)]

    def side(s: dict[str, Any] | None) -> str:
        return "—" if s is None else s["verdict"].upper() + (f" {s['layer']}" if s["layer"] else "")

    rows = "".join(
        f"<tr><td class='mono'>{_e(i['case_id'])}</td><td class='st-{_e(i['state'])}'>{_e(audit.GATE_STATES[i['state']])}</td>"
        f"<td>{_e(side(i['base']))}</td><td>{_e(side(i['cur']))}</td></tr>"
        for i in moved
    )
    perf = g["perf"]
    change = "" if perf["p90_change"] is None else f"（{perf['p90_change']:+.0%}）"
    return f"""
    <section><h2>基线门禁 <span class="{'ok' if g['passed'] else 'bad'}">{'放行' if g['passed'] else '拦截'}</span></h2>
      <p class="muted">基线 <span class="mono">{_e(base_id)}</span> · 共同用例 {g['common']} 条 ·
        新增失败 {n['regressed']} · 已修复 {n['fixed']} · 仍失败 {n['still_failing'] + n['relayered']}（换层 {n['relayered']}）·
        McNemar p = {g['mcnemar_p']} · p90 {_ms(perf['base']['p90_ms'])} → {_ms(perf['cur']['p90_ms'])}{change}</p>
      {''.join(f"<p class='bad'>{_e(r)}</p>" for r in g['reasons'])}
      {f"<table class='grid'><thead><tr><th>用例</th><th>状态</th><th>基线</th><th>本次</th></tr></thead><tbody>{rows}</tbody></table>" if rows else ""}
    </section>"""


def _all_cases(rows: list[dict[str, Any]]) -> str:
    body = "".join(
        f"<tr><td class='mono'>{_e(r['trace']['case_id'])}</td>"
        f"<td>{_e(audit.DIMENSION_LABELS.get(r['dimension'], r['dimension']))}</td>"
        f"<td class='v-{_e(r['trace']['verdict']['rule'])}'>{_e(r['trace']['verdict']['rule'].upper())}</td>"
        f"<td>{_e(r['trace'].get('layer') or '')}</td><td class='num'>{_ms(r['trace']['latency_ms'])}</td></tr>"
        for r in rows
    )
    return (
        f"<details class='all'><summary>全部 {len(rows)} 条用例</summary>"
        "<table class='grid'><thead><tr><th>用例</th><th>维度</th><th>判定</th><th>归因</th><th class='num'>耗时</th></tr></thead>"
        f"<tbody>{body}</tbody></table></details>"
    )


def build_report(run_dir: Path, cases: dict[str, Case], baseline: Path | None = None) -> str:
    detail = audit.run_detail(run_dir, cases)
    s, rows = detail["summary"], detail["rows"]
    traces = [r["trace"] for r in rows]
    perf = audit.perf_stats(traces)
    gate = audit.gate(load_run(baseline), traces) if baseline else None
    calib_only = bool(detail["calibration"]) and detail["calibration"]["detected"]["n"] == len(rows)
    failures = sorted((r for r in rows if r["trace"]["verdict"]["rule"] == "fail"),
                      key=lambda r: (r["trace"].get("layer") or "Z", r["trace"]["case_id"]))
    by_layer = {layer: sum(1 for r in failures if r["trace"].get("layer") == layer) for layer in LAYER_NAMES}
    digest = hashlib.sha256((run_dir / "traces.jsonl").read_bytes()).hexdigest()
    track = "双轨判定（规则 + LLM 忠实度）" if s["llm_judge"] else "仅规则轨"
    degraded = f" · LLM 裁判降级 {s['judge_degraded']} 条" if s["judge_degraded"] else ""
    layer_chips = "".join(
        f"<span class='layer l-{l}'>{l} {_e(LAYER_NAMES[l])} × {n}</span>" for l, n in by_layer.items() if n
    )

    return f"""<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AgentLens 报告 {_e(s['run_id'])}</title>
<style>{CSS}</style>
</head>
<body>
<main>
  <header>
    <p class="eyebrow">AgentLens · 智能体分层归因体检报告</p>
    <h1>{_e(s['run_id'])}</h1>
    <p class="muted">{_e(s['generated_at'])} · 被测对象 {_e(s['adapter'])}（{_e(', '.join(s['models']))}）· {track}{degraded}</p>
  </header>

  <section class="kpis">
    <div><span>可靠性分</span><strong>{'—' if calib_only else s['score']}</strong><small>{'注入集不计分' if calib_only else '通过 / 总数'}</small></div>
    <div><span>通过</span><strong class="ok">{s['pass']}</strong><small>共 {s['total']} 条</small></div>
    <div><span>失败</span><strong class="bad">{s['fail']}</strong><small>跳过 {s['skip']}</small></div>
    <div><span>耗时 p50 / p90</span><strong>{_ms(perf['p50_ms'])}</strong><small>p90 {_ms(perf['p90_ms'])}</small></div>
    <div><span>平均 token</span><strong>{perf['tokens_mean'] if perf['tokens_mean'] is not None else '—'}</strong><small>prompt + completion</small></div>
  </section>

  <section><h2>维度 × 归因层</h2>
    <p class="muted">每行是官方七维度之一（测什么），每列是 L0–L6 归因层（失败归到哪），格子里是失败条数。</p>
    {_heatmap(detail['heatmap'])}
  </section>
  {_calibration(detail['calibration'])}
  {_gate(gate, baseline.name if baseline else None)}

  <section><h2>失败样本 {len(failures)} 条</h2>
    <div class="chips">{layer_chips}</div>
    <p class="muted">按归因层排序。展开可看失败断言、回答原文与执行链路；高亮的 span 是归因证据。</p>
    {''.join(_failure(r) for r in failures) or '<p>没有失败样本。</p>'}
  </section>

  <section>{_all_cases(rows)}</section>

  <footer>
    <p>本报告由 <span class="mono">results/{_e(s['run_id'])}/traces.jsonl</span> 二次生成，不另存数据。<br>
    源文件 sha256 <span class="mono">{digest}</span><br>
    复现：<span class="mono">python -m agentlens show {_e(s['run_id'])}</span> · AgentLens {__version__}</p>
  </footer>
</main>
</body>
</html>
"""


CSS = """
:root {
  --bg: #f6f4ee; --paper: #fffdf8; --ink: #1f2420; --muted: #6b6f68; --line: #e2ddd1;
  --ok: #2f7a4a; --ok-soft: #e3f1e7; --bad: #b54838; --bad-soft: #f8e7e2; --warn: #9a6a12; --warn-soft: #f6ecd4;
  --heat: 181, 72, 56;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #161917; --paper: #1f2320; --ink: #e8e6df; --muted: #9ca098; --line: #343a35;
    --ok: #7cc495; --ok-soft: #1f3327; --bad: #ec8a7a; --bad-soft: #3a2420; --warn: #e0b45c; --warn-soft: #3a3020;
    --heat: 236, 138, 122;
  }
}
:root[data-theme="dark"] {
  --bg: #161917; --paper: #1f2320; --ink: #e8e6df; --muted: #9ca098; --line: #343a35;
  --ok: #7cc495; --ok-soft: #1f3327; --bad: #ec8a7a; --bad-soft: #3a2420; --warn: #e0b45c; --warn-soft: #3a3020;
  --heat: 236, 138, 122;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 14px/1.6 -apple-system, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; }
main { max-width: 1080px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { font-size: 26px; margin: 4px 0; font-family: ui-monospace, Menlo, monospace; }
h2 { font-size: 17px; margin: 0 0 8px; }
section { background: var(--paper); border: 1px solid var(--line); border-radius: 12px; padding: 18px 20px; margin-top: 16px; }
.eyebrow { margin: 0; color: var(--muted); font-size: 12px; letter-spacing: .08em; }
.muted { color: var(--muted); }
.mono, code { font-family: ui-monospace, Menlo, monospace; font-size: 12.5px; }
.ok { color: var(--ok); } .bad { color: var(--bad); }
small { font-size: 12px; }
.kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 12px; }
.kpis div { display: flex; flex-direction: column; }
.kpis span { color: var(--muted); font-size: 12px; }
.kpis strong { font-size: 24px; }
.kpis small { color: var(--muted); }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
th { font-weight: 600; font-size: 12.5px; }
.num { text-align: right; white-space: nowrap; }
.heat td { text-align: center; font-weight: 600; min-width: 48px; }
.heat th small { display: block; font-weight: 400; color: var(--muted); }
.h1 { background: rgba(var(--heat), .15); } .h2 { background: rgba(var(--heat), .3); }
.h3 { background: rgba(var(--heat), .5); } .h4 { background: rgba(var(--heat), .72); }
.grid tr.total td { font-weight: 600; }
.v-pass { color: var(--ok); } .v-fail { color: var(--bad); font-weight: 600; }
.st-regressed { color: var(--bad); font-weight: 600; } .st-fixed { color: var(--ok); font-weight: 600; }
.st-relayered { color: var(--warn); }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 6px 0; }
.chip, .layer { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px;
  background: var(--line); white-space: nowrap; }
.chip.warn { background: var(--warn-soft); color: var(--warn); }
.layer { background: var(--bad-soft); color: var(--bad); font-weight: 600; }
.layer.l-L0 { background: var(--warn-soft); color: var(--warn); }
details.case { border-top: 1px solid var(--line); }
details.case > summary { cursor: pointer; padding: 10px 0; display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; }
details.case .why { flex-basis: 100%; color: var(--muted); font-size: 13px; }
.case-body { padding: 0 0 14px; }
.case-body ul { margin: 4px 0; padding-left: 20px; }
.answer { white-space: pre-wrap; background: var(--bg); border-radius: 8px; padding: 10px 12px; font-size: 13px; }
.spans { font-size: 13px; }
.spans tr.ev td { background: var(--bad-soft); }
.spans td:nth-child(-n+2) { white-space: nowrap; }
.raw { color: var(--muted); font-family: ui-monospace, Menlo, monospace; font-size: 11.5px; word-break: break-all; }
details.all > summary { cursor: pointer; font-weight: 600; }
footer { color: var(--muted); font-size: 12px; margin-top: 20px; word-break: break-all; }
@media (max-width: 720px) {
  .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  section { padding: 14px; overflow-x: auto; }
}
@media print { section { break-inside: avoid; } }
"""


def write_report(run_dir: Path, cases: dict[str, Case], out: Path | None = None, baseline: Path | None = None) -> Path:
    out = out or run_dir / "report.html"
    out.write_text(build_report(run_dir, cases, baseline), encoding="utf-8")
    return out
