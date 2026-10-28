"""终端渲染：把一条 trace 完整摊开。这是 M0 的验收动作本身。

"一条用例能跑通并打印完整 trace" —— 打印得出来，才证明 schema 里真有东西可归因。
"""

from __future__ import annotations

from rich import box
from rich.console import Console
from rich.markup import escape
from rich.panel import Panel
from rich.table import Table
from rich.tree import Tree

from .cases import Case
from .schema import (
    LAYER_NAMES,
    GenerateSpan,
    GuardrailSpan,
    ObservationSpan,
    PlanSpan,
    RetrieveSpan,
    TokenUsage,
    ToolCallSpan,
    Trace,
)

ICON = {
    "plan": ("🧭", "cyan"),
    "tool_call": ("🔧", "magenta"),
    "observation": ("👁 ", "blue"),
    "retrieve": ("📚", "green"),
    "generate": ("✍ ", "yellow"),
    "guardrail": ("🛡 ", "red"),
}


def _span_text(span) -> str:
    icon, color = ICON[span.span]
    head = f"[{color}]{icon} {span.span}#{span.step}[/{color}]"
    if isinstance(span, PlanSpan):
        body = f"intent={escape(span.intent)} steps={escape(str(span.steps))}"
    elif isinstance(span, ToolCallSpan):
        flag = "[green]schema_ok[/green]" if span.schema_ok else f"[red]schema_bad {escape(str(span.schema_errors))}[/red]"
        body = f"[bold]{escape(span.name)}[/bold]({escape(_kv(span.args))}) {flag}"
    elif isinstance(span, ObservationSpan):
        if span.ok:
            body = f"ok rows={span.row_count}"
        else:
            body = f"[red]error: {escape(span.error or '')}[/red]"
    elif isinstance(span, RetrieveSpan):
        hits = ", ".join(f"{escape(c)}({s})" for c, s in zip(span.chunk_ids, span.scores))
        body = f"query={escape(span.query)} -> {hits or '[red]零召回[/red]'}"
    elif isinstance(span, GenerateSpan):
        body = f"citations={escape(str(span.citations))}"
    elif isinstance(span, GuardrailSpan):
        if span.triggered:
            body = f"[red]{span.action}[/red] rule={escape(str(span.rule))} :: {escape(str(span.reason))}"
        else:
            body = "allow（未触发）"
    else:
        body = ""
    tail = f" [dim]{span.latency_ms}ms[/dim]" if span.latency_ms else ""
    return f"{head}  {body}{tail}"


def _kv(d: dict) -> str:
    return ", ".join(f"{k}={v!r}" for k, v in d.items())


def print_trace(console: Console, case: Case, trace: Trace) -> None:
    verdict = trace.verdict.rule
    badge = {
        "pass": "[black on green] PASS [/black on green]",
        "fail": "[white on red] FAIL [/white on red]",
        "skip": "[black on yellow] SKIP [/black on yellow]",
    }[verdict]

    head = (
        f"[bold]{escape(case.id)}[/bold]  {escape(case.title)}\n"
        f"[dim]dimension[/dim] {case.dimension}   [dim]source[/dim] {case.source}   "
        f"[dim]difficulty[/dim] {case.difficulty}   [dim]tags[/dim] {escape(','.join(case.tags) or '-')}"
    )
    console.print(Panel(head, title=badge, subtitle=f"run {trace.run_id} · model {trace.model} · seed {trace.seed}", box=box.ROUNDED))

    console.print(f"[dim]USER[/dim] {escape(case.input.text)}")

    tree = Tree(f"[bold]trace[/bold] {escape(trace.case_id)}  [dim]{len(trace.spans)} spans[/dim]")
    for span in trace.spans:
        node = tree.add(_span_text(span))
        if isinstance(span, ObservationSpan) and span.raw is not None:
            preview = _kv(span.raw) if isinstance(span.raw, dict) else str(span.raw)
            if len(preview) > 120:
                preview = preview[:120] + " …"
            node.add(f"[dim]{escape(preview)}[/dim]")
    console.print(tree)

    console.print(f"[dim]ANSWER[/dim] {escape(trace.answer)}")

    if trace.verdict.checks:
        table = Table(title="规则裁判", box=box.SIMPLE_HEAD, title_justify="left", pad_edge=False)
        table.add_column("check", style="bold")
        table.add_column("", justify="center")
        table.add_column("reason")
        for check in trace.verdict.checks:
            mark = "[green]✔[/green]" if check.passed else "[red]✘[/red]"
            table.add_row(check.check, mark, escape(check.reason))
        console.print(table)

    if trace.layer:
        name = LAYER_NAMES.get(trace.layer, "")
        console.print(
            Panel(
                f"[bold]{trace.layer} {name}[/bold]\n{escape(trace.layer_reason or '')}\n"
                f"[dim]证据 span: {escape(', '.join(trace.layer_evidence) or '无')}[/dim]",
                title="五层归因",
                border_style="red" if trace.layer == "L6" else "yellow",
                box=box.ROUNDED,
            )
        )
    console.print()


def print_summary(console: Console, pairs: list[tuple[Case, Trace]], run_id: str) -> None:
    total = len(pairs)
    passed = sum(1 for _, t in pairs if t.verdict.rule == "pass")
    failed = sum(1 for _, t in pairs if t.verdict.rule == "fail")
    skipped = total - passed - failed

    table = Table(title=f"本批次 {total} 条 · run {run_id}", box=box.SIMPLE_HEAD, title_justify="left")
    table.add_column("case", style="bold")
    table.add_column("维度")
    table.add_column("判定", justify="center")
    table.add_column("根因", justify="center")
    table.add_column("耗时", justify="right")
    for case, trace in pairs:
        mark = {"pass": "[green]PASS[/green]", "fail": "[red]FAIL[/red]", "skip": "[yellow]SKIP[/yellow]"}[trace.verdict.rule]
        layer = f"{trace.layer} {LAYER_NAMES.get(trace.layer, '')}" if trace.layer else "-"
        table.add_row(case.id, case.dimension, mark, layer, f"{trace.latency_ms:.1f}ms")
    console.print(table)

    layers: dict[str, int] = {}
    for _, t in pairs:
        if t.layer:
            layers[t.layer] = layers.get(t.layer, 0) + 1
    layer_line = "  ".join(f"{k}({LAYER_NAMES.get(k, '')})×{v}" for k, v in sorted(layers.items())) or "无"

    console.print(
        f"可靠性分 [bold]{passed / total * 100:.1f}[/bold] / 100    "
        f"通过 {passed} · 失败 {failed} · 跳过 {skipped}    "
        f"可定位缺陷 [bold]{failed}[/bold] 个"
    )
    console.print(f"[dim]缺陷分布（维度×根因的纵向切片）：{layer_line}[/dim]")
    console.print(f"[dim]复现：python -m agentlens run cases/ --out results/[/dim]")
