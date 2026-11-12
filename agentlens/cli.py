"""AgentLens 命令行入口。

    python -m agentlens validate cases/          # 只校验，不执行（fail fast）
    python -m agentlens run cases/ --trace       # 批量跑 + 打印完整 trace
    python -m agentlens run cases/ --filter tag:smoke --repeat 3
    python -m agentlens show results/<run_id>    # 回看某次运行
    python -m agentlens schema                   # 导出 trace 的 JSON Schema
    python -m agentlens inject cases/onegzus/    # 由真实录制生成故障注入用例（给裁判和归因打分）
    python -m agentlens generate cases/onegzus/  # LLM 保义改写黄金用例，期望沿用（离线联网一次）
    python -m agentlens compare <基线> <本次>     # 基线门禁：新增失败或 p90 耗时超标则退出码 1
    python -m agentlens run cases/ --baseline <run_id>   # 跑完直接对基线做门禁
    python -m agentlens report <run_id>          # 自包含 HTML 报告 → results/<run_id>/report.html
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import sys
from pathlib import Path

from rich.console import Console

from .adapters.campus_copilot import CampusCopilotAdapter
from .adapters.library import LibraryAdapter
from .adapters.onegzus import MUTANT_RECORDINGS, RECORDINGS, OneGzusAdapter
from .cases import Case, CaseError, load_cases
from .inject import mutant_case, mutate
from .render import print_gate, print_summary, print_trace
from .runner import load_run, run
from .schema import Trace

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CASES = ROOT / "cases"
DEFAULT_OUT = ROOT / "results"

ADAPTERS = {"campus_copilot": CampusCopilotAdapter, "onegzus": OneGzusAdapter, "library": LibraryAdapter}


def _resolve_run(spec: str) -> Path | None:
    target = Path(spec)
    if not target.exists():
        target = DEFAULT_OUT / spec
    return target if target.exists() else None


def _gate(args: argparse.Namespace, console: Console, base: Path, cur: Path) -> int:
    from .audit import gate

    result = gate(
        load_run(base), load_run(cur),
        max_regressions=args.max_regressions, latency_tolerance=args.latency_tolerance,
    )
    print_gate(console, result, base.name, cur.name)
    return 0 if result["passed"] else 1


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

    result = run(
        cases, adapter, out_dir=Path(args.out), repeat=args.repeat, seed=args.seed,
        llm_judge=args.llm_judge,
    )

    if args.trace:
        for case, trace in result.pairs:
            print_trace(console, case, trace)

    print_summary(console, result.pairs, result.run_id)
    degraded = sum(1 for _, t in result.pairs if t.verdict.judge_degraded)
    if degraded:
        console.print(f"[yellow]LLM 裁判降级 {degraded} 条[/yellow]：无缓存且未配置 .env.judge，这些条目只有规则轨结论")
    console.print(f"[dim]落盘：{result.out_dir}/traces.jsonl · summary.json[/dim]")

    if args.html:
        from .report import load_case_index, write_report

        out = write_report(result.out_dir, load_case_index(DEFAULT_CASES),
                           baseline=_resolve_run(args.baseline) if args.baseline else None)
        console.print(f"[dim]报告：{out}[/dim]")
    if args.baseline:
        base = _resolve_run(args.baseline)
        if base is None:
            console.print(f"[red]找不到基线运行[/red] {args.baseline}")
            return 2
        code = _gate(args, console, base, result.out_dir)
        if code:
            return code
    if args.strict and result.metrics()["fail"]:
        return 1
    return 0


def cmd_compare(args: argparse.Namespace, console: Console) -> int:
    base, cur = _resolve_run(args.base), _resolve_run(args.cur)
    for spec, found in ((args.base, base), (args.cur, cur)):
        if found is None:
            console.print(f"[red]找不到运行记录[/red] {spec}")
            return 2
    return _gate(args, console, base, cur)


def cmd_report(args: argparse.Namespace, console: Console) -> int:
    from .report import load_case_index, write_report

    run_dir = _resolve_run(args.run)
    base = _resolve_run(args.baseline) if args.baseline else None
    for spec, found in ((args.run, run_dir), (args.baseline, base)):
        if spec and found is None:
            console.print(f"[red]找不到运行记录[/red] {spec}")
            return 2
    out = write_report(run_dir, load_case_index(Path(args.cases)), Path(args.out) if args.out else None, base)
    console.print(f"[green]已生成[/green] {out}")
    return 0


def cmd_show(args: argparse.Namespace, console: Console) -> int:
    target = _resolve_run(args.run)
    if target is None:
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


def cmd_inject(args: argparse.Namespace, console: Console) -> int:
    import yaml

    try:
        cases = load_cases(Path(args.path))
    except CaseError as exc:
        console.print(f"[red]用例校验失败[/red] {exc}")
        return 2

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    MUTANT_RECORDINGS.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    skipped = []
    for case in cases:
        rec_file = RECORDINGS / f"{case.id}.json"
        if not rec_file.exists():
            skipped.append(case.id)
            continue
        for mutant in mutate(case, json.loads(rec_file.read_text(encoding="utf-8"))):
            doc = mutant_case(case, mutant)
            (out_dir / f"{doc['id']}.yaml").write_text(
                yaml.safe_dump(doc, allow_unicode=True, sort_keys=False), encoding="utf-8",
            )
            (MUTANT_RECORDINGS / f"{doc['id']}.json").write_text(
                json.dumps(mutant.recording, ensure_ascii=False, indent=2) + "\n", encoding="utf-8",
            )
            counts[f"{mutant.layer} {mutant.op}"] = counts.get(f"{mutant.layer} {mutant.op}", 0) + 1

    load_cases(out_dir)  # 生成物必须能被正常加载，否则当场报错
    console.print(f"[green]生成[/green] {sum(counts.values())} 条注入用例 → {out_dir}")
    for key, n in sorted(counts.items()):
        console.print(f"  {key:<22} {n}")
    if skipped:
        console.print(f"[yellow]无录制、跳过[/yellow] {len(skipped)} 条：{', '.join(skipped)}")
    return 0


def cmd_generate(args: argparse.Namespace, console: Console) -> int:
    from concurrent.futures import ThreadPoolExecutor

    import yaml

    from .generate import generate
    from .judge.llm import JudgeConfig

    config = JudgeConfig.load()
    if config is None:
        console.print("[red]未配置生成模型[/red]：需要 .env.judge 或 AGENTLENS_JUDGE_* 环境变量")
        return 2
    try:
        bases = [c for c in load_cases(Path(args.path)) if c.source == "golden" and c.inject is None]
    except CaseError as exc:
        console.print(f"[red]用例校验失败[/red] {exc}")
        return 2

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    # 已生成过的基准跳过：生成物是提交进仓库的资产，重跑不应悄悄换掉它们
    todo = [c for c in bases if args.force or not any(out_dir.glob(f"{c.id}__gen_*.yaml"))]
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda c: generate(c, config), todo))

    written, rejected = 0, []
    for docs, why in results:
        rejected += why
        for doc in docs:
            (out_dir / f"{doc['id']}.yaml").write_text(
                yaml.safe_dump(doc, allow_unicode=True, sort_keys=False), encoding="utf-8",
            )
            written += 1
    load_cases(out_dir)
    console.print(f"[green]生成[/green] {written} 条改写用例（{len(todo)} 条基准）→ {out_dir}")
    for line in rejected:
        console.print(f"  [yellow]拒收[/yellow] {line}")
    return 0


def _gate_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--max-regressions", type=int, default=0, help="允许的新增失败条数（默认 0）")
    p.add_argument("--latency-tolerance", type=float, default=0.2, help="允许的 p90 耗时涨幅（默认 0.2 = 20%%）")


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
    p_run.add_argument(
        "--llm-judge", action="store_true",
        help="追加 LLM 忠实度裁判（优先命中 judgements/ 缓存；未命中且未配置时标记降级）",
    )
    p_run.add_argument("--baseline", default=None, metavar="RUN", help="跑完对这次基线做门禁（退出码 1 = 拦截）")
    _gate_args(p_run)
    p_run.add_argument("--html", action="store_true", help="跑完生成自包含 HTML 报告（results/<run_id>/report.html）")
    p_run.set_defaults(func=cmd_run)

    p_cmp = sub.add_parser("compare", help="基线门禁：两次运行逐条对比修复状态，判定放行 / 拦截")
    p_cmp.add_argument("base", help="基线 run_id 或路径")
    p_cmp.add_argument("cur", help="本次 run_id 或路径")
    _gate_args(p_cmp)
    p_cmp.set_defaults(func=cmd_compare)

    p_rep = sub.add_parser("report", help="由 traces.jsonl 生成自包含 HTML 报告（断网可开）")
    p_rep.add_argument("run", help="run_id 或路径")
    p_rep.add_argument("--out", default=None, help="输出路径（默认 results/<run_id>/report.html）")
    p_rep.add_argument("--baseline", default=None, metavar="RUN", help="附带对这次基线的门禁结论")
    p_rep.add_argument("--cases", default=str(DEFAULT_CASES), help="用例根目录（取维度、标题、提问）")
    p_rep.set_defaults(func=cmd_report)

    p_show = sub.add_parser("show", help="回看某次运行")
    p_show.add_argument("run", help="run_id 或路径")
    p_show.add_argument("--case", default=None)
    p_show.set_defaults(func=cmd_show)

    p_schema = sub.add_parser("schema", help="导出 trace JSON Schema")
    p_schema.add_argument("--out", default="docs/trace.schema.json")
    p_schema.set_defaults(func=cmd_schema)

    p_inj = sub.add_parser("inject", help="由真实录制生成故障注入用例（只改 LLM 回复，已知根因层）")
    p_inj.add_argument("path", nargs="?", default=str(DEFAULT_CASES / "onegzus"))
    p_inj.add_argument("--out", default=str(DEFAULT_CASES / "calibration"))
    p_inj.set_defaults(func=cmd_inject)

    p_gen = sub.add_parser("generate", help="LLM 保义改写黄金用例生成新用例（期望沿用基准）")
    p_gen.add_argument("path", nargs="?", default=str(DEFAULT_CASES / "onegzus"))
    p_gen.add_argument("--out", default=str(DEFAULT_CASES / "generated"))
    p_gen.add_argument("--force", action="store_true", help="已生成过的基准也重新生成")
    p_gen.set_defaults(func=cmd_generate)
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
