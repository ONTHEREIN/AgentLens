"""Runner：批量执行 + 落盘。结果写进 results/<run_id>/，一次运行一个目录，可回溯。

trace 先落盘、再统计 —— 顺序不能反：报告里的每个数字都必须能顺着 run_id 找回原始 span。
"""

from __future__ import annotations

import json
import secrets
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

from .adapters.base import BaseAdapter
from .attribute import attribute
from .cases import Case
from .judge.rules import judge
from .schema import Trace


def new_run_id() -> str:
    return f"{datetime.now().strftime('%Y%m%d-%H%M')}-{secrets.token_hex(2)}"


@dataclass
class RunResult:
    run_id: str
    pairs: list[tuple[Case, Trace]] = field(default_factory=list)
    out_dir: Path | None = None

    @property
    def traces(self) -> list[Trace]:
        return [t for _, t in self.pairs]

    @property
    def cases(self) -> list[Case]:
        return [c for c, _ in self.pairs]

    def metrics(self) -> dict:
        traces = self.traces
        total = len(traces)
        passed = sum(1 for t in traces if t.verdict.rule == "pass")
        failed = sum(1 for t in traces if t.verdict.rule == "fail")
        layers: dict[str, int] = {}
        for t in traces:
            if t.layer:
                layers[t.layer] = layers.get(t.layer, 0) + 1

        # 稳定性：同一条用例多次执行判定是否一致（G4 的同源指标）
        seen: dict[str, set[str]] = {}
        for c, t in self.pairs:
            seen.setdefault(c.id, set()).add(t.verdict.rule)
        unstable = [cid for cid, s in seen.items() if len(s) > 1]

        return {
            "total": total,
            "pass": passed,
            "fail": failed,
            "skip": total - passed - failed,
            "score": round(passed / total * 100, 1) if total else 0.0,
            "layers": dict(sorted(layers.items())),
            "unstable_cases": unstable,
        }

    def summary(self) -> dict:
        return {
            "run_id": self.run_id,
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "metrics": self.metrics(),
            "cases": [
                {
                    "case_id": c.id,
                    "dimension": c.dimension,
                    "verdict": t.verdict.rule,
                    "layer": t.layer,
                    "layer_reason": t.layer_reason,
                    "latency_ms": t.latency_ms,
                    "failed_checks": [ck.check for ck in t.verdict.failed],
                }
                for c, t in self.pairs
            ],
        }


def run(
    cases: list[Case],
    adapter: BaseAdapter,
    *,
    out_dir: Path,
    repeat: int = 1,
    seed: int = 42,
) -> RunResult:
    run_id = new_run_id()
    run_dir = out_dir / run_id
    run_dir.mkdir(parents=True, exist_ok=True)

    result = RunResult(run_id=run_id, out_dir=run_dir)

    for case in cases:
        for _ in range(repeat):
            out = adapter.invoke(case, run_id=run_id)
            trace = Trace(
                run_id=run_id,
                case_id=case.id,
                adapter=adapter.name,
                seed=seed,
                model=adapter.model,
                status=out.status,  # type: ignore[arg-type]
                answer=out.answer,
                spans=out.spans,
                tokens=out.tokens,
                latency_ms=out.latency_ms,
                meta=out.meta,
            )
            trace.verdict = judge(case, trace)

            if trace.verdict.rule == "fail":
                att = attribute(case, trace)
                trace.layer = att.layer  # type: ignore[assignment]
                trace.layer_reason = att.reason
                trace.layer_evidence = att.evidence

            result.pairs.append((case, trace))

    # 落盘：traces.jsonl 是唯一真相源，报告由它二次生成
    with (run_dir / "traces.jsonl").open("w", encoding="utf-8") as fh:
        for _, trace in result.pairs:
            fh.write(json.dumps(trace.dump(), ensure_ascii=False) + "\n")

    (run_dir / "summary.json").write_text(
        json.dumps(result.summary(), ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return result


def load_run(path: Path) -> list[dict]:
    """读取一次运行的全部 trace（供 show / compare / 报告复用）。"""
    file = path / "traces.jsonl" if path.is_dir() else path
    return [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line.strip()]
