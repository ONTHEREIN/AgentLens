"""审计台的数据层：运行记录、维度 × 归因热力图、运行对比、人工复核与一致性。

只读 `results/<run_id>/traces.jsonl`（唯一真相源）和 `reviews/labels.jsonl`（人工标注），
不保存任何派生结果：页面上的每个数字都从这两份文件现算。

人工复核按「trace 内容指纹」而不是 run_id 记账：回放是确定性的，同一条 trace
在任何一次复跑里指纹相同，标注自动沿用。
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from datetime import datetime
from pathlib import Path
from typing import Any

from .cases import Case
from .runner import load_run
from .schema import DIMENSIONS, LAYER_NAMES

REVIEW_TARGETS: dict[str, str] = {
    "verdict": "总判定",
    "layer": "归因层",
    "llm_faithfulness": "LLM 忠实度结论",
}
LAYER_VALUES = ["none", *LAYER_NAMES]


# ---------------------------------------------------------------- runs


def trace_key(trace: dict[str, Any]) -> str:
    """同一用例、同样的回答与 span → 同一指纹（与 run_id、耗时无关）。

    回放时工具在本机实测耗时（0ms / 1ms 抖动），计时字段不进指纹，否则标注无法跨运行沿用。
    """
    spans = [
        {k: v for k, v in span.items() if k not in ("latency_ms", "t_start_ms")}
        for span in trace.get("spans", [])
    ]
    blob = json.dumps(
        {"case": trace["case_id"], "answer": trace.get("answer", ""), "spans": spans},
        ensure_ascii=False, sort_keys=True,
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


def llm_check(trace: dict[str, Any]) -> dict[str, Any] | None:
    return next((c for c in trace["verdict"]["checks"] if c["check"] == "llm_faithfulness"), None)


def machine_value(trace: dict[str, Any], target: str) -> str | None:
    """机器在某个复核目标上给出的结论；不适用时为 None。"""
    rule = trace["verdict"]["rule"]
    if rule == "skip":
        return None
    if target == "verdict":
        return rule
    if target == "layer":
        return trace.get("layer") or "none"
    if target == "llm_faithfulness":
        check = llm_check(trace)
        return None if check is None else ("faithful" if check["passed"] else "unfaithful")
    raise ValueError(f"未知复核目标：{target}")


def run_summary(run_dir: Path) -> dict[str, Any] | None:
    file = run_dir / "traces.jsonl"
    if not file.is_file():
        return None
    traces = load_run(run_dir)
    if not traces:
        return None
    counts = Counter(t["verdict"]["rule"] for t in traces)
    total = len(traces)
    summary_file = run_dir / "summary.json"
    generated = None
    if summary_file.is_file():
        generated = json.loads(summary_file.read_text(encoding="utf-8")).get("generated_at")
    return {
        "run_id": run_dir.name,
        "generated_at": generated or datetime.fromtimestamp(file.stat().st_mtime).isoformat(timespec="seconds"),
        "adapter": traces[0].get("adapter", "unknown"),
        "models": sorted({t.get("model", "unknown") for t in traces}),
        "total": total,
        "pass": counts["pass"],
        "fail": counts["fail"],
        "skip": counts["skip"],
        "score": round(counts["pass"] / total * 100, 1),
        "llm_judge": any(llm_check(t) or t["verdict"].get("judge_degraded") for t in traces),
        "judge_degraded": sum(1 for t in traces if t["verdict"].get("judge_degraded")),
    }


def list_runs(results_dir: Path) -> list[dict[str, Any]]:
    if not results_dir.is_dir():
        return []
    runs = [run_summary(d) for d in results_dir.iterdir() if d.is_dir()]
    return sorted((r for r in runs if r), key=lambda r: r["generated_at"], reverse=True)


def heatmap(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """维度 × 归因层的失败计数；维度取自用例定义（老运行里改过名的维度归入 other）。"""
    dims = [*DIMENSIONS, "other"]
    cells = {d: {layer: 0 for layer in LAYER_NAMES} for d in dims}
    for row in rows:
        layer = row["trace"].get("layer")
        if row["trace"]["verdict"]["rule"] != "fail" or not layer:
            continue
        dim = row["dimension"] if row["dimension"] in DIMENSIONS else "other"
        cells[dim][layer] += 1
    used = [d for d in dims if d != "other" or any(cells["other"].values())]
    return {"dimensions": used, "layers": list(LAYER_NAMES), "cells": {d: cells[d] for d in used}}


def run_detail(run_dir: Path, cases: dict[str, Case]) -> dict[str, Any]:
    summary = run_summary(run_dir)
    if summary is None:
        raise FileNotFoundError(run_dir.name)
    rows = []
    for trace in load_run(run_dir):
        case = cases.get(trace["case_id"])
        rows.append({
            "case": case.model_dump(mode="json") if case else None,
            "dimension": case.dimension if case else "other",
            "trace": trace,
            "trace_key": trace_key(trace),
        })
    return {"summary": summary, "heatmap": heatmap(rows), "rows": rows}


# ---------------------------------------------------------------- compare


def compare_runs(a: dict[str, Any], b: dict[str, Any]) -> dict[str, Any]:
    """按用例对齐两次运行（每条用例取首条 trace），列出判定、归因、裁判与回答的变化。"""

    def index(detail: dict[str, Any]) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for row in detail["rows"]:
            out.setdefault(row["trace"]["case_id"], row)
        return out

    left, right = index(a), index(b)

    def side(row: dict[str, Any] | None) -> dict[str, Any] | None:
        if row is None:
            return None
        t = row["trace"]
        check = llm_check(t)
        return {
            "verdict": t["verdict"]["rule"],
            "layer": t.get("layer"),
            "llm": None if check is None else check["passed"],
            "llm_score": t["verdict"].get("llm_score"),
            "failed_checks": [c["check"] for c in t["verdict"]["checks"] if not c["passed"]],
            "trace_key": row["trace_key"],
        }

    items = []
    for case_id in sorted(set(left) | set(right)):
        sa, sb = side(left.get(case_id)), side(right.get(case_id))
        changes = []
        if sa and sb:
            for field, label in (("verdict", "判定"), ("layer", "归因"), ("llm", "LLM 结论")):
                if sa[field] != sb[field]:
                    changes.append(label)
            if sa["trace_key"] != sb["trace_key"]:
                changes.append("执行内容")
        else:
            changes.append("仅一侧有")
        row = left.get(case_id) or right.get(case_id)
        items.append({"case_id": case_id, "dimension": row["dimension"], "a": sa, "b": sb, "changes": changes})
    changed = [i for i in items if i["changes"]]
    return {
        "a": a["summary"],
        "b": b["summary"],
        "items": items,
        "changed": len(changed),
        "counts": dict(Counter(c for i in changed for c in i["changes"])),
    }


# ---------------------------------------------------------------- reviews


def load_labels(path: Path) -> list[dict[str, Any]]:
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def latest_labels(labels: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, Any]]:
    """同一 trace 同一目标只认最后一次标注（追加写，不改历史）。"""
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for label in labels:
        out[(label["trace_key"], label["target"])] = label
    return out


def add_label(path: Path, label: dict[str, Any]) -> dict[str, Any]:
    target = label.get("target")
    if target not in REVIEW_TARGETS:
        raise ValueError(f"未知复核目标：{target}")
    allowed = {
        "verdict": {"pass", "fail"},
        "layer": set(LAYER_VALUES),
        "llm_faithfulness": {"faithful", "unfaithful"},
    }[target]
    if label.get("human") not in allowed:
        raise ValueError(f"{REVIEW_TARGETS[target]} 的人工结论只能是 {sorted(allowed)}")
    for key in ("trace_key", "case_id", "run_id", "machine"):
        if not label.get(key):
            raise ValueError(f"缺少字段：{key}")
    record = {
        "trace_key": label["trace_key"],
        "case_id": label["case_id"],
        "run_id": label["run_id"],
        "target": target,
        "machine": label["machine"],
        "human": label["human"],
        "agree": label["machine"] == label["human"],
        "note": str(label.get("note") or "")[:500],
        "reviewer": str(label.get("reviewer") or "")[:40],
        "at": datetime.now().isoformat(timespec="seconds"),
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    return record


def cohen_kappa(pairs: list[tuple[str, str]]) -> float | None:
    """两位标注者（机器 vs 人工）的 Cohen's κ；样本为空或期望一致率为 1 时无定义。"""
    n = len(pairs)
    if n == 0:
        return None
    observed = sum(1 for m, h in pairs if m == h) / n
    machine, human = Counter(m for m, _ in pairs), Counter(h for _, h in pairs)
    expected = sum(machine[k] * human[k] for k in set(machine) | set(human)) / (n * n)
    if expected >= 1:
        return None
    return round((observed - expected) / (1 - expected), 3)


def agreement(labels: list[dict[str, Any]]) -> dict[str, Any]:
    latest = latest_labels(labels)
    stats = {}
    for target, name in REVIEW_TARGETS.items():
        pairs = [(lb["machine"], lb["human"]) for (_, t), lb in latest.items() if t == target]
        agree = sum(1 for m, h in pairs if m == h)
        stats[target] = {
            "name": name,
            "n": len(pairs),
            "agree": agree,
            "rate": round(agree / len(pairs) * 100, 1) if pairs else None,
            "kappa": cohen_kappa(pairs),
        }
    return {"targets": stats, "labels": sorted(latest.values(), key=lambda lb: lb["at"], reverse=True)}
