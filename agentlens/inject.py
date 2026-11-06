"""故障注入（录制变异）：给裁判和归因器出「已知答案」的考题。

真实缺陷的根因要靠人复核才知道，样本又少，量不出归因准不准。这里反过来做：
取一条**基准用例已通过**的真实录制，对其中的 LLM 回复做一处定点改动，回放后
工具照常执行，于是得到一条根因层事先确定的失败 trace。拿它去跑判定与归因：

- 判定没报失败 → 变异「存活」，说明裁判在这类错误上有盲区（变异检出率）
- 判定报了失败 → 看归因层是否等于注入层（归因准确率）

变异 trace 不是被测对象的真实行为，只用来给 AgentLens 自己打分，
不计入软帮手的缺陷统计。算子只改 LLM 回复，不碰工具与数据，所以 L5（数据源错）、
L6（护栏）不在这里注入。

    python -m agentlens inject cases/onegzus/ --out cases/calibration/
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable

from .cases import Case

PLAN_TOOL = "make_plan"
# 换工具时的目标：业务上相邻、最容易被模型混淆的那个；不换进 search_notices（参数不同）
SWAP_TO = {
    "get_grades": "get_exams",
    "get_exams": "get_grades",
    "get_attendance": "get_grades",
    "get_schedule": "get_exams",
    "get_card_balance": "get_schedule",
    "search_notices": "get_exams",
}
TOOL_ORDER = list(SWAP_TO)


@dataclass
class Mutant:
    op: str
    layer: str
    detail: str
    recording: dict[str, Any]


Operator = Callable[[Case, dict[str, Any]], Mutant | None]


# ---------------------------------------------------------------- 录制里的定位


def _calls(rec: dict[str, Any]) -> list[dict[str, Any]]:
    return [c for r in rec["replies"] for c in r["tool_calls"]]


def _business_calls(rec: dict[str, Any]) -> list[dict[str, Any]]:
    return [c for c in _calls(rec) if c["name"] != PLAN_TOOL]


def _plan_call(rec: dict[str, Any]) -> dict[str, Any] | None:
    return next((c for c in _calls(rec) if c["name"] == PLAN_TOOL), None)


def _final(rec: dict[str, Any]) -> dict[str, Any] | None:
    last = rec["replies"][-1] if rec["replies"] else None
    return last if last is not None and not last["tool_calls"] else None


def _args(call: dict[str, Any]) -> dict[str, Any]:
    try:
        value = json.loads(call["arguments"] or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


def _set_args(call: dict[str, Any], args: dict[str, Any]) -> None:
    call["arguments"] = json.dumps(args, ensure_ascii=False)


# ---------------------------------------------------------------- 算子


def drop_plan(case: Case, rec: dict[str, Any]) -> Mutant | None:
    """删掉 make_plan 调用：trace 里没有 plan span → L1。"""
    if _plan_call(rec) is None:
        return None
    out = copy.deepcopy(rec)
    replies = []
    for reply in out["replies"]:
        kept = [c for c in reply["tool_calls"] if c["name"] != PLAN_TOOL]
        # 只剩规划的那一轮整轮删掉；否则空 tool_calls 会被当成最终回答
        if reply["tool_calls"] and not kept and not reply["content"]:
            continue
        reply["tool_calls"] = kept
        replies.append(reply)
    out["replies"] = replies
    return Mutant("drop_plan", "L1", "删除 make_plan 调用，执行照旧", out)


def plan_drift(case: Case, rec: dict[str, Any]) -> Mutant | None:
    """把计划步骤换成实际没调用的工具：规划与执行脱节 → L1。"""
    plan = _plan_call(rec)
    actual = {c["name"] for c in _business_calls(rec)}
    other = next((t for t in TOOL_ORDER if t not in actual), None)
    if plan is None or not actual or other is None:
        return None
    out = copy.deepcopy(rec)
    target = _plan_call(out)
    args = _args(target)
    before = args.get("steps")
    args["steps"] = [other]
    _set_args(target, args)
    return Mutant("plan_drift", "L1", f"计划步骤 {before} → {[other]}，实际调用不变", out)


def swap_tool(case: Case, rec: dict[str, Any]) -> Mutant | None:
    """把期望的首个工具整体换成相邻工具（计划同步改，避免先撞上 L1）→ L2。"""
    expected = case.expected_tools
    if not expected or expected[0] not in {c["name"] for c in _business_calls(rec)}:
        return None
    src, dst = expected[0], SWAP_TO.get(expected[0])
    if dst is None:
        return None
    out = copy.deepcopy(rec)
    for call in _calls(out):
        if call["name"] == src:
            call["name"] = dst
            _set_args(call, {})  # 目标工具的参数签名可能不同，用缺省参数，免得先撞上 L3
        elif call["name"] == PLAN_TOOL:
            args = _args(call)
            args["steps"] = [dst if s == src else s for s in args.get("steps") or []]
            _set_args(call, args)
    return Mutant("swap_tool", "L2", f"{src} → {dst}（计划同步替换）", out)


def _shift(key: str, value: Any) -> Any:
    """给一个合法但错误的取值。"""
    if key == "term":
        return "1" if str(value) == "2" else "2"
    if key == "year" and str(value).isdigit():
        return str(int(value) - 1)
    if key == "week" and isinstance(value, int):
        return value + 1 if value < 30 else value - 1
    return None


def wrong_arg(case: Case, rec: dict[str, Any]) -> Mutant | None:
    """用例有 equals 约束的参数改成另一个合法值（学期、学年、周次）→ L3。"""
    for spec in case.expect.tools:
        for key, constraint in spec.args.items():
            if constraint.equals is None:
                continue
            out = copy.deepcopy(rec)
            call = next((c for c in _calls(out) if c["name"] == spec.name), None)
            if call is None:
                continue
            args = _args(call)
            new = _shift(key, args.get(key))
            if new is None:
                continue
            old = args.get(key)
            args[key] = new
            _set_args(call, args)
            return Mutant("wrong_arg", "L3", f"{spec.name}.{key}: {old!r} → {new!r}", out)
    return None


def bad_arg(case: Case, rec: dict[str, Any]) -> Mutant | None:
    """学年参数写成「2025-2026」格式：参数 schema 校验失败 → L3。"""
    out = copy.deepcopy(rec)
    call = next(
        (c for c in _business_calls(out) if c["name"] in ("get_grades", "get_attendance", "get_exams")),
        None,
    )
    if call is None:
        return None
    args = _args(call)
    year = str(args.get("year") or "2026")
    if not year.isdigit():
        return None
    args["year"] = f"{year}-{int(year) + 1}"
    _set_args(call, args)
    return Mutant("bad_arg", "L3", f"{call['name']}.year → {args['year']!r}（不符合 schema）", out)


def _tamper(text: str) -> str:
    """数字逐位 +1；不含数字的关键词换成省略号——答案与观测从此对不上。"""
    if re.search(r"\d", text):
        return re.sub(r"\d", lambda m: str((int(m.group()) + 1) % 10), text)
    return "……"


def answer_tamper(case: Case, rec: dict[str, Any]) -> Mutant | None:
    """篡改最终回答里用例要求出现的关键内容：工具返回正常、答案与观测矛盾 → L4。"""
    final = _final(rec)
    must = [s for s in case.expect.answer_contains if final and s in (final["content"] or "")]
    if not must:
        return None
    out = copy.deepcopy(rec)
    content = _final(out)["content"]
    for s in must:
        content = content.replace(s, _tamper(s))
    _final(out)["content"] = content
    return Mutant("answer_tamper", "L4", f"最终回答中 {must} 被改写", out)


def truncate(case: Case, rec: dict[str, Any]) -> Mutant | None:
    """去掉最终回答那一轮：回放耗尽、执行异常 → L0。"""
    if _final(rec) is None or len(rec["replies"]) < 2:
        return None
    out = copy.deepcopy(rec)
    out["replies"] = out["replies"][:-1]
    return Mutant("truncate", "L0", "删除最终回答，回放在最后一轮耗尽", out)


OPERATORS: list[Operator] = [drop_plan, plan_drift, swap_tool, wrong_arg, bad_arg, answer_tamper, truncate]


# ---------------------------------------------------------------- 生成


def mutate(case: Case, rec: dict[str, Any]) -> list[Mutant]:
    if case.inject is not None or not rec.get("replies"):
        return []
    return [m for op in OPERATORS if (m := op(case, rec)) is not None]


def mutant_case(case: Case, mutant: Mutant) -> dict[str, Any]:
    """变异用例 = 基准用例的输入与期望原样保留 + 注入来历。期望不改：要考的就是能不能发现。"""
    doc = case.model_dump(mode="json", by_alias=True, exclude_none=True, exclude_defaults=True)
    doc.update(
        id=f"{case.id}__{mutant.op}",
        title=f"[注入 {mutant.layer}·{mutant.op}] {case.title}".strip(),
        dimension=case.dimension,
        source="mutated",
        tags=[*case.tags, "calibration", f"op:{mutant.op}"],
        inject={"base": case.id, "op": mutant.op, "layer": mutant.layer, "detail": mutant.detail},
    )
    doc.pop("note", None)
    return doc
