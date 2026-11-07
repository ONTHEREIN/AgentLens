"""审计台的数据层：运行记录、维度 × 归因热力图、运行对比、人工复核与一致性。

只读三类文件，不保存任何派生结果，页面上的每个数字都从它们现算：
- `results/<run_id>/traces.jsonl`：用例运行（唯一真相源）
- 被测对象的线上对话日志（软帮手 `data/traces/<日期>.jsonl`）：每天一个 `chat-<日期>` 运行，
  没有预设期望，只判执行状态与 LLM 忠实度
- `reviews/labels.jsonl`：人工标注

人工复核按「trace 内容指纹」而不是 run_id 记账：回放是确定性的，同一条 trace
在任何一次复跑里指纹相同，标注自动沿用。
"""

from __future__ import annotations

import hashlib
import json
import math
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from typing import Any

from .cases import Case
from .judge.llm import JudgeConfig, applicable_to, evidence_for, judge_evidence
from .judge.rules import _check_status
from .runner import load_run
from .schema import DIMENSIONS, LAYER_NAMES, Trace, Verdict

REVIEW_TARGETS: dict[str, str] = {
    "verdict": "总判定",
    "layer": "归因层",
    "llm_faithfulness": "LLM 忠实度结论",
}
LAYER_VALUES = ["none", *LAYER_NAMES]

# 维度与 span 的中文名：审计台与 HTML 报告共用；schema.py 的维度若有变动需同步
DIMENSION_LABELS: dict[str, str] = {
    "functional_accuracy": "功能准确性",
    "tool_use": "工具调用",
    "rag_retrieval": "RAG 检索质量",
    "multi_turn": "多轮对话",
    "adversarial_safety": "对抗性与安全",
    "boundary_exception": "边界与异常",
    "performance": "性能",
}
SPAN_LABELS: dict[str, str] = {
    "plan": "规划",
    "tool_call": "工具调用",
    "observation": "工具观测",
    "retrieve": "知识检索",
    "generate": "生成",
    "guardrail": "护栏",
}
assert tuple(DIMENSION_LABELS) == DIMENSIONS, "维度中文名表与 schema.DIMENSIONS 不一致"


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
    summary_file = run_dir / "summary.json"
    generated = None
    if summary_file.is_file():
        generated = json.loads(summary_file.read_text(encoding="utf-8")).get("generated_at")
    return summarize(run_dir.name, generated or _mtime(file), traces, source="cases")


def _mtime(file: Path) -> str:
    return datetime.fromtimestamp(file.stat().st_mtime).isoformat(timespec="seconds")


def summarize(run_id: str, generated_at: str, traces: list[dict[str, Any]], *, source: str) -> dict[str, Any]:
    counts = Counter(t["verdict"]["rule"] for t in traces)
    total = len(traces)
    return {
        "run_id": run_id,
        "source": source,
        "generated_at": generated_at,
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


def list_runs(results_dir: Path, chat_dir: Path | None = None) -> list[dict[str, Any]]:
    runs = [run_summary(d) for d in results_dir.iterdir() if d.is_dir()] if results_dir.is_dir() else []
    if chat_dir is not None:
        # 列表只读裁判缓存、不联网；打开某天的对话时才对未判定的条目调用裁判
        runs += [chat_summary(f, judged_chat_traces(f, None)) for f in chat_files(chat_dir)]
    return sorted((r for r in runs if r), key=lambda r: r["generated_at"], reverse=True)


# ---------------------------------------------------------------- 线上对话


CHAT_PREFIX = "chat-"


def chat_files(chat_dir: Path) -> list[Path]:
    if not chat_dir.is_dir():
        return []
    return sorted(f for f in chat_dir.glob("*.jsonl") if f.stem.isdigit() and f.stat().st_size)


def chat_file(chat_dir: Path, run_id: str) -> Path | None:
    if not run_id.startswith(CHAT_PREFIX):
        return None
    file = chat_dir / f"{run_id.removeprefix(CHAT_PREFIX)}.jsonl"
    return file if file in chat_files(chat_dir) else None


def judge_chat_trace(raw: dict[str, Any], config: JudgeConfig | None) -> dict[str, Any]:
    """线上对话没有预设期望：规则轨只判执行状态，语义轨对照观测判忠实度。"""
    trace = Trace.model_validate(raw)
    checks = [_check_status(trace)]
    llm_score, degraded = None, False
    if applicable_to(trace, has_rubric=False):
        evidence = evidence_for(trace, trace.meta.get("input") or [], None)
        judged = judge_evidence(trace.case_id, evidence, config)
        if judged is None:
            degraded = True
        else:
            check, llm_score = judged
            checks.append(check)
    # 检查项收齐后再构造 Verdict：pydantic 会复制传入的列表，之后的 append 不会进到 verdict 里
    trace.verdict = Verdict(
        rule="pass" if all(c.passed for c in checks) else "fail",
        checks=checks, llm_score=llm_score, judge_degraded=degraded,
    )
    if trace.verdict.rule == "fail":
        if trace.status != "ok":
            trace.layer, trace.layer_reason = "L0", f"执行未正常完成（status={trace.status}）"
        else:
            failed = next(c for c in checks if not c.passed)
            obs_ok = all(o.ok for o in trace.observations)
            trace.layer = "L4" if obs_ok else "L5"
            trace.layer_reason = (
                f"工具返回正常，但答案未忠实反映观测：{failed.reason}"
                if obs_ok else f"工具/数据源返回异常，答案受其影响：{failed.reason}"
            )
            trace.layer_evidence = [e for e in failed.evidence if not e.startswith("judgement:")]
    return trace.dump()


def judged_chat_traces(file: Path, config: JudgeConfig | None, workers: int = 4) -> list[dict[str, Any]]:
    raws = [json.loads(line) for line in file.read_text(encoding="utf-8").splitlines() if line.strip()]
    with ThreadPoolExecutor(max_workers=workers) as pool:
        return list(pool.map(lambda raw: judge_chat_trace(raw, config), raws))


def chat_summary(file: Path, traces: list[dict[str, Any]]) -> dict[str, Any]:
    return summarize(f"{CHAT_PREFIX}{file.stem}", _mtime(file), traces, source="chat")


def chat_detail(file: Path, config: JudgeConfig | None) -> dict[str, Any]:
    traces = judged_chat_traces(file, config)
    rows = [
        {
            "case": None,
            "dimension": "chat",
            "input_messages": t["meta"].get("input") or [],
            "trace": t,
            "trace_key": trace_key(t),
        }
        for t in traces
    ]
    return {"summary": chat_summary(file, traces), "heatmap": heatmap(rows), "rows": rows}


def heatmap(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """维度 × 归因层的失败计数；维度取自用例定义（老运行里改过名的维度归入 other）。"""
    dims = [*DIMENSIONS, "chat", "other"]
    cells = {d: {layer: 0 for layer in LAYER_NAMES} for d in dims}
    for row in rows:
        layer = row["trace"].get("layer")
        if row["trace"]["verdict"]["rule"] != "fail" or not layer:
            continue
        dim = row["dimension"] if row["dimension"] in (*DIMENSIONS, "chat") else "other"
        cells[dim][layer] += 1
    used = [d for d in dims if d not in ("chat", "other") or any(cells[d].values())]
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
    calib = calibration([(r["case"]["inject"], r["trace"]) for r in rows if r["case"] and r["case"].get("inject")])
    return {"summary": summary, "heatmap": heatmap(rows), "rows": rows, "calibration": calib}


# ---------------------------------------------------------------- calibration


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float] | None:
    """二项比例的 Wilson 95% 置信区间（百分比）；小样本、比例贴近 0/100% 时比正态近似可靠。"""
    if n == 0:
        return None
    p = k / n
    centre = (p + z * z / (2 * n)) / (1 + z * z / n)
    half = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / (1 + z * z / n)
    return round(max(0.0, centre - half) * 100, 1), round(min(1.0, centre + half) * 100, 1)


def _rate(k: int, n: int) -> dict[str, Any]:
    return {"k": k, "n": n, "rate": round(k / n * 100, 1) if n else None, "ci": wilson(k, n)}


def calibration(pairs: list[tuple[dict[str, Any], dict[str, Any]]]) -> dict[str, Any] | None:
    """故障注入用例的两个分数：检出率 = 判定为 fail 的比例；归因准确率 = 检出样本中归因层 == 注入层。

    pairs 是 (case.inject, trace)。没有注入用例时返回 None。
    """
    if not pairs:
        return None
    groups: dict[tuple[str, str], list[tuple[bool, bool]]] = {}
    for inject, trace in pairs:
        killed = trace["verdict"]["rule"] == "fail"
        groups.setdefault((inject["layer"], inject["op"]), []).append(
            (killed, killed and trace.get("layer") == inject["layer"]),
        )
    by_op = []
    for (layer, op), marks in sorted(groups.items()):
        killed = sum(k for k, _ in marks)
        by_op.append({
            "layer": layer, "op": op,
            "detected": _rate(killed, len(marks)),
            "attributed": _rate(sum(a for _, a in marks), killed),
        })
    flat = [m for marks in groups.values() for m in marks]
    killed = sum(k for k, _ in flat)
    return {
        "detected": _rate(killed, len(flat)),
        "attributed": _rate(sum(a for _, a in flat), killed),
        "by_op": by_op,
    }


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
        "gate": gate([r["trace"] for r in a["rows"]], [r["trace"] for r in b["rows"]]),
        "items": items,
        "changed": len(changed),
        "counts": dict(Counter(c for i in changed for c in i["changes"])),
    }


GATE_STATES: dict[str, str] = {
    "regressed": "新增失败",
    "fixed": "已修复",
    "relayered": "仍失败·换层",
    "still_failing": "仍失败",
    "still_passing": "仍通过",
    "added": "新增用例",
    "removed": "移除用例",
}


def mcnemar(fixed: int, regressed: int) -> float:
    """配对样本的精确 McNemar 检验（双侧 p 值）：只看判定翻转的用例，检验「修好的」与「改坏的」是否对称。"""
    n = fixed + regressed
    if n == 0:
        return 1.0
    tail = sum(math.comb(n, i) for i in range(min(fixed, regressed) + 1)) / 2**n
    return round(min(1.0, 2 * tail), 4)


def percentile(values: list[float], q: float) -> float | None:
    """最近秩分位数：样本少时不插值，报出来的值一定是某条 trace 的真实耗时。"""
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(q * len(ordered)) - 1)]


def perf_stats(traces: list[dict[str, Any]]) -> dict[str, Any]:
    lat = [t["latency_ms"] for t in traces if t["status"] == "ok"]
    tok = [t["tokens"]["prompt"] + t["tokens"]["completion"] for t in traces if t["status"] == "ok"]
    return {
        "p50_ms": percentile(lat, 0.5),
        "p90_ms": percentile(lat, 0.9),
        "tokens_mean": round(sum(tok) / len(tok)) if tok else None,
    }


def gate(
    base: list[dict[str, Any]],
    cur: list[dict[str, Any]],
    *,
    max_regressions: int = 0,
    latency_tolerance: float = 0.2,
) -> dict[str, Any]:
    """基线门禁：按用例对齐（各取首条 trace），给每条用例一个修复状态，再判这次能不能放行。

    放行条件：新增失败不超过 max_regressions，且共同用例的 p90 耗时涨幅不超过 latency_tolerance。
    只比两侧都有的用例；新增 / 移除的用例单列，不进门禁结论，也不进 McNemar。
    """

    def index(traces: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        out: dict[str, dict[str, Any]] = {}
        for t in traces:
            out.setdefault(t["case_id"], t)
        return out

    left, right = index(base), index(cur)
    items = []
    for case_id in sorted(set(left) | set(right)):
        a, b = left.get(case_id), right.get(case_id)
        if a is None or b is None:
            state = "added" if a is None else "removed"
        else:
            va, vb = a["verdict"]["rule"], b["verdict"]["rule"]
            if va == "skip" or vb == "skip":
                continue
            if va == "pass":
                state = "still_passing" if vb == "pass" else "regressed"
            elif vb == "pass":
                state = "fixed"
            else:
                state = "still_failing" if a.get("layer") == b.get("layer") else "relayered"
        items.append({
            "case_id": case_id,
            "state": state,
            "base": None if a is None else {"verdict": a["verdict"]["rule"], "layer": a.get("layer")},
            "cur": None if b is None else {"verdict": b["verdict"]["rule"], "layer": b.get("layer")},
        })

    counts = Counter(i["state"] for i in items)
    common = [c for c in left if c in right]
    perf_a = perf_stats([left[c] for c in common])
    perf_b = perf_stats([right[c] for c in common])
    p90_ratio = (
        round(perf_b["p90_ms"] / perf_a["p90_ms"] - 1, 3) + 0.0  # + 0.0 把 -0.0 规整成 0.0
        if perf_a["p90_ms"] and perf_b["p90_ms"] is not None else None
    )

    reasons = []
    if counts["regressed"] > max_regressions:
        reasons.append(f"新增失败 {counts['regressed']} 条（允许 {max_regressions} 条）")
    if p90_ratio is not None and p90_ratio > latency_tolerance:
        reasons.append(f"p90 耗时上涨 {p90_ratio:.0%}（允许 {latency_tolerance:.0%}）")
    return {
        "passed": not reasons,
        "reasons": reasons,
        "counts": {k: counts.get(k, 0) for k in GATE_STATES},
        "common": len(common),
        "mcnemar_p": mcnemar(counts["fixed"], counts["regressed"]),
        "perf": {"base": perf_a, "cur": perf_b, "p90_change": p90_ratio},
        "items": items,
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
