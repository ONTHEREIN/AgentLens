"""AgentLens 命令行入口。

    python -m agentlens validate cases/          # 只校验，不执行（fail fast）
    python -m agentlens run cases/ --trace       # 批量跑 + 打印完整 trace
    python -m agentlens run cases/ --filter tag:smoke --repeat 3
    python -m agentlens show results/<run_id>    # 回看某次运行
    python -m agentlens schema                   # 导出 trace 的 JSON Schema
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from pathlib import Path

from rich.console import Console

from .adapters.campus_copilot import CampusCopilotAdapter
from .adapters.onegzus import OneGzusAdapter
from .cases import Case, CaseError, load_cases
from .render import print_summary, print_trace
from .runner import load_run, run
from .schema import Trace

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CASES = ROOT / "cases"
DEFAULT_OUT = ROOT / "results"

ADAPTERS = {"campus_copilot": CampusCopilotAdapter, "onegzus": OneGzusAdapter}


def _filter(cases: list[Case], specs: list[str]) -> list[Case]:
    for spec in specs:
        if ":" not in spec:
            print(f"过滤器格式应为 key:value，收到 {spec!r}", file=sys.stderr)
            sys.exit(2)
        key, value = spec.split(":", 1)
        if key == "tag":
            cases = [c for c in cases if value in c.tags]
        elif key == "dimension":
            cases = [c for c in cases if c.dimension == value]
        elif key == "source":
            cases = [c for c in cases if c.source == value]
        elif key == "id":
            cases = [c for c in cases if fnmatch.fnmatch(c.id, value)]
        else:
            print(f"未知过滤器：{key}", file=sys.stderr)
            sys.exit(2)
    return cases


def cmd_validate(args: argparse.Namespace, console: Console) -> int:
    try:
        cases = load_cases(Path(args.path))
    except CaseError as exc:
        console.print(f"[red]用例校验失败[/red] {exc}")
        return 2
    console.print(f"[green]通过[/green] {len(cases)} 条用例")
    for c in cases:
        console.print(f"  [bold]{c.id}[/bold]  {c.dimension} · {c.source} · tools={c.expected_tools}")
    return 0


def cmd_run(args: argparse.Namespace, console: Console) -> int:
    try:
        cases = load_cases(Path(args.path))
    except CaseError as exc:
        console.print(f"[red]用例校验失败[/red] {exc}")
        return 2

    cases = _filter(cases, args.filter)
    if not cases:
        console.print("[red]过滤器筛完为空[/red]：拒绝产出 100% 通过的假报告")
        return 2

    adapter_cls = ADAPTERS[args.adapter]
    adapter = adapter_cls()

    result = run(cases, adapter, out_dir=Path(args.out), repeat=args.repeat, seed=args.seed)

    if args.trace:
        for case, trace in result.pairs:
            print_trace(console, case, trace)

    print_summary(console, result.pairs, result.run_id)
    console.print(f"[dim]落盘：{result.out_dir}/traces.jsonl · summary.json[/dim]")

    if args.strict and result.metrics()["fail"]:
        return 1
    return 0


def cmd_show(args: argparse.Namespace, console: Console) -> int:
    target = Path(args.run)
    if not target.exists():
        target = DEFAULT_OUT / args.run
    if not target.exists():
        console.print(f"[red]找不到运行记录[/red] {args.run}")
        return 2

    rows = load_run(target)
    if args.case:
        rows = [r for r in rows if r["case_id"] == args.case]
        if not rows:
            console.print(f"[red]该次运行中没有用例[/red] {args.case}")
            return 2
        for row in rows:
            trace = Trace.model_validate(row)
            console.print_json(json.dumps(trace.dump(), ensure_ascii=False))
        return 0

    console.print_json(json.dumps([{"case": r["case_id"], "verdict": r["verdict"]["rule"], "layer": r.get("layer"),
                                    "reason": r.get("layer_reason")} for r in rows], ensure_ascii=False))
    return 0


def cmd_schema(args: argparse.Namespace, console: Console) -> int:
    schema = Trace.model_json_schema()
    text = json.dumps(schema, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
        console.print(f"[green]已写出[/green] {args.out}")
    else:
        print(text)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="agentlens", description="AgentLens · 智能体分层归因体检中心")
    sub = parser.add_subparsers(dest="command", required=True)

    p_val = sub.add_parser("validate", help="校验用例文件（不执行）")
    p_val.add_argument("path", nargs="?", default=str(DEFAULT_CASES))
    p_val.set_defaults(func=cmd_validate)

    p_run = sub.add_parser("run", help="批量执行")
    p_run.add_argument("path", nargs="?", default=str(DEFAULT_CASES))
    p_run.add_argument("--adapter", default="campus_copilot", choices=sorted(ADAPTERS))
    p_run.add_argument("--filter", action="append", default=[], metavar="KEY:VALUE")
    p_run.add_argument("--repeat", type=int, default=1, help="同用例重跑次数（稳定性）")
    p_run.add_argument("--seed", type=int, default=42)
    p_run.add_argument("--out", default=str(DEFAULT_OUT))
    p_run.add_argument("--trace", action="store_true", help="打印每条用例的完整 span 链路")
    p_run.add_argument("--strict", action="store_true", help="有失败则以非零码退出（CI 门禁用）")
    p_run.set_defaults(func=cmd_run)

    p_show = sub.add_parser("show", help="回看某次运行")
    p_show.add_argument("run", help="run_id 或路径")
    p_show.add_argument("--case", default=None)
    p_show.set_defaults(func=cmd_show)

    p_schema = sub.add_parser("schema", help="导出 trace JSON Schema")
    p_schema.add_argument("--out", default="docs/trace.schema.json")
    p_schema.set_defaults(func=cmd_schema)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    console = Console()
    try:
        return args.func(args, console)
    except CaseError as exc:
        console.print(f"[red]{exc}[/red]")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
