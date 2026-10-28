#!/usr/bin/env python3
"""AgentLens 功能演示：一条命令看完「测链路 → 归因 → 回溯」全流程。

运行：
    .venv/bin/python demo.py

演示只复用现有模块与 5 条种子用例，不修改执行管线、不联网、不调用 LLM。
"""

from __future__ import annotations

import json
from pathlib import Path

from rich import box
from rich.console import Console
from rich.markup import escape
from rich.panel import Panel
from rich.rule import Rule
from rich.table import Table

from agentlens.adapters.campus_copilot import CampusCopilotAdapter
from agentlens.cases import CaseError, load_cases
from agentlens.render import print_summary, print_trace
from agentlens.runner import load_run, run

ROOT = Path(__file__).resolve().parent
CASES_DIR = ROOT / "cases"
RESULTS_DIR = ROOT / "results"

# 三个有代表性的观察点：一个正常样本 + 两个不同层的失败样本
FOCUS_CASES = [
    ("schedule_001", "对照：链路完整、判定通过"),
    ("interpret_001", "价值：失败被定位到 L2 工具选型"),
    ("guard_false_001", "价值：误拒被单列为 L6 护栏误伤"),
]

console = Console()


def stage(title: str, subtitle: str) -> None:
    console.print()
    console.print(Rule(f"[bold]{title}[/bold]", style="cyan"))
    console.print(f"[dim]{subtitle}[/dim]\n")


def show_intro() -> None:
    console.print(
        Panel(
            "普通测试只给 [bold]PASS / FAIL[/bold]。\n"
            "AgentLens 沿着 [bold]trace → span 断言 → 失败归因[/bold]，"
            "回答“错在哪一环、证据是哪一步”。\n\n"
            "[dim]本次演示：5 条声明式用例 · 分 span 判定 · L2/L6 归因 · 结果落盘回溯[/dim]",
            title="[bold]AgentLens · 分层归因体检[/bold]",
            subtitle="测链路，不是测答案",
            box=box.ROUNDED,
            border_style="cyan",
        )
    )


def load_and_show_cases():
    stage("第 1 幕 · 用例是声明式的", "YAML 加载即校验；非法用例整体拒绝，不会只跑一半。")

    cases = load_cases(CASES_DIR)

    table = Table(box=box.SIMPLE_HEAD, title_justify="left")
    table.add_column("case", style="bold")
    table.add_column("测试维度")
    table.add_column("期望工具")
    table.add_column("标签")
    for case in cases:
        table.add_row(
            case.id,
            case.dimension,
            ", ".join(case.expected_tools) or "-",
            ", ".join(case.tags) or "-",
        )
    console.print(table)
    console.print(f"[green]校验通过[/green]：{len(cases)} 条用例，全部来自 {CASES_DIR.name}/")
    return cases


def execute(cases):
    stage(
        "第 2 幕 · 执行并逐 span 判定",
        "被测对象是确定性的 CampusCopilot 桩；每步执行都留下 plan / tool_call / observation 等 span。",
    )

    adapter = CampusCopilotAdapter()
    result = run(cases, adapter, out_dir=RESULTS_DIR)

    print_summary(console, result.pairs, result.run_id)
    console.print(f"[dim]落盘目录：{result.out_dir}[/dim]")
    return result


def show_focus_traces(result) -> None:
    stage(
        "第 3 幕 · 从 FAIL 到根因",
        "同一套 trace 上，规则裁判负责判定，归因引擎负责指出失败层级与证据 span。",
    )

    by_id = {case.id: (case, trace) for case, trace in result.pairs}
    for case_id, reason in FOCUS_CASES:
        if case_id not in by_id:
            console.print(f"[yellow]跳过缺失用例[/yellow] {case_id}")
            continue
        case, trace = by_id[case_id]
        console.print(f"[bold]{reason}[/bold]")
        print_trace(console, case, trace)


def show_persistence(result) -> None:
    stage(
        "第 4 幕 · 结论可回溯",
        "traces.jsonl 是唯一真相源；下面的表不是内存对象，而是从落盘文件重新读出来的。",
    )

    assert result.out_dir is not None
    rows = load_run(result.out_dir)

    table = Table(box=box.SIMPLE_HEAD, title_justify="left")
    table.add_column("case", style="bold")
    table.add_column("判定")
    table.add_column("归因")
    table.add_column("证据 span")
    for row in rows:
        table.add_row(
            row["case_id"],
            row["verdict"]["rule"].upper(),
            row.get("layer") or "-",
            ", ".join(row.get("layer_evidence") or []) or "-",
        )
    console.print(table)

    summary_path = result.out_dir / "summary.json"
    summary = json.loads(summary_path.read_text(encoding="utf-8"))
    console.print(
        f"[dim]{summary_path.name} 记录：{summary['metrics']['pass']} PASS · "
        f"{summary['metrics']['fail']} FAIL · 可靠性分 {summary['metrics']['score']}[/dim]"
    )
    console.print(f"\n[bold]回看本次运行：[/bold] python -m agentlens show {result.out_dir}")
    console.print(f"[bold]刷新本次演示：[/bold] .venv/bin/python {Path(__file__).name}")


def closing(result) -> None:
    by_id = {case.id: trace for case, trace in result.pairs}
    expectations = [
        ("schedule_001", "pass", None),
        ("interpret_001", "fail", "L2"),
        ("guard_false_001", "fail", "L6"),
    ]
    checks = []
    for case_id, verdict, layer in expectations:
        trace = by_id.get(case_id)
        ok = trace is not None and trace.verdict.rule == verdict and (
            layer is None or trace.layer == layer
        )
        checks.append((case_id, ok))

    metrics = result.metrics()
    console.print()
    if all(ok for _, ok in checks):
        console.print(
            Panel(
                "[bold green]核心链路演示完成。[/bold green]\n"
                f"{metrics['total']} 条用例 → {metrics['pass']} PASS / "
                f"{metrics['fail']} FAIL → L2 与 L6 各自带证据定位。",
                box=box.ROUNDED,
                border_style="green",
            )
        )
    else:
        failed = ", ".join(cid for cid, ok in checks if not ok)
        console.print(
            Panel(
                f"[bold yellow]演示跑完，但基线发生变化[/bold yellow]：{escape(failed)}\n"
                "这通常意味着用例或被测对象被改动，请核对是否属于刻意调整。",
                box=box.ROUNDED,
                border_style="yellow",
            )
        )


def main() -> int:
    show_intro()
    try:
        cases = load_and_show_cases()
    except CaseError as exc:
        console.print(f"[red]用例校验失败[/red] {escape(str(exc))}")
        return 2

    result = execute(cases)
    show_focus_traces(result)
    show_persistence(result)
    closing(result)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
