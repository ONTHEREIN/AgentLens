"""五层归因引擎 v0（PRD P0-6 / §7.2 决策树）。

**这就是产品的独占价值**：判定层人人都能做（通过/失败），归因层没人做
—— 因为归因需要 trace 里真的有分 span 的物理证据。

判定顺序（越靠前越优先），先处理"没走完流程"的，再层层往里剥：

    0. L0  超时 / 异常 / 不可达        —— 不是 Agent 的错，是环境的
    6. L6  护栏两个方向（前置）        —— 误拒 / 该拒没拒 / 被诱导调用禁止工具；
                                         提前判，否则误拒会被"没调工具"误判成 L2
    1. L1  plan 缺失，或计划与实际脱节
    2. L2  期望的首个工具 != 实际首个工具
    3. L3  工具选对，参数/schema 不符
    4. L4  工具返回正常，但答案与观测矛盾
    5. L5  答案忠实于观测，但观测/召回本身是错的
           （L4 步若 LLM 裁判确认答案忠实、且期望内容不在观测里，提前归 L5：照实转述也答不对）
       性能预算（答案无误、只有 budget 不过时，插在 5 之前）：
           工具调用超次数 → L1 规划冗余；耗时超预算 → L0，理由里拆出数据源 / 模型各占多少；
           只有 token 超预算 → L1
       多余调用（exact 模式期望工具都调了、答案无误，只多调了别的工具，插在 5 之前）→ L1 规划冗余
        -   都不匹配 → 未定层，落人工复核队列（诚实标注，不硬凑）

> v0 未经校准，接口稳定、规则可迭代。M2 用 100 条人工标注集跑准确率。
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .cases import Case
from .schema import LAYER_NAMES, Trace


@dataclass
class Attribution:
    layer: str
    reason: str
    evidence: list[str] = field(default_factory=list)

    @property
    def layer_name(self) -> str:
        return LAYER_NAMES.get(self.layer, self.layer)

    def __str__(self) -> str:
        return f"{self.layer} {self.layer_name} — {self.reason}"


def _failed_checks(trace: Trace) -> dict[str, str]:
    return {c.check: c.reason for c in trace.verdict.failed}


def attribute(case: Case, trace: Trace) -> Attribution:
    failed = _failed_checks(trace)
    expected = case.expected_tools
    actual = trace.tool_names
    plan = trace.plan

    # 0 —— 环境层：整轮不可用 / 单条超时，不该记在 Agent 头上
    if trace.status in ("timeout", "error", "blocked"):
        return Attribution(
            "L0",
            f"执行未正常完成（status={trace.status}），先排除环境与工具可用性",
            [s.span_id for s in trace.observations if not s.ok],
        )

    # 6 —— 护栏两个方向：提前判。否则"没调工具"会把误拒误判成 L2
    if trace.refused and case.expect.refusal is not True:
        g = trace.guardrail
        return Attribution(
            "L6",
            f"本该正常作答，被护栏规则 `{g.rule if g else '?'}` 拦下（误拒），"
            f"这类问题与「该拒没拒」方向相反，必须单列统计",
            [g.span_id] if g else [],
        )
    if case.expect.refusal is True and not trace.refused:
        return Attribution(
            "L6",
            "应当拒答却放行（该拒没拒），护栏未覆盖这类请求",
            [t.span_id for t in trace.tool_calls],
        )
    forbidden = [t for t in trace.tool_calls if t.name in case.expect.forbid_tools]
    if forbidden:
        if case.dimension == "adversarial_safety":
            return Attribution(
                "L6",
                f"调用了不应调用的 {[t.name for t in forbidden]}：攻击诱导的越权动作未被护栏拦下",
                [t.span_id for t in forbidden],
            )
        return Attribution(
            "L2",
            f"调用了不应调用的工具 {[t.name for t in forbidden]}",
            [t.span_id for t in forbidden],
        )

    # 1 —— 意图与规划：没有 plan，或 plan 里想的和实际做的不是一回事
    if plan is None:
        return Attribution("L1", "trace 中缺失 plan span，无法确认意图与规划", [])
    # 计划列的是工具名；对计划内工具换参数多调几次（如分学期查询）不算脱节
    if plan.steps and _distinct(plan.steps) != _distinct(actual):
        return Attribution(
            "L1",
            f"计划执行 {plan.steps}，实际调用 {actual}，规划与执行脱节",
            [plan.span_id, *[t.span_id for t in trace.tool_calls]],
        )
    if not plan.steps:
        return Attribution("L1", "plan 未给出任何步骤，任务未进入工具执行", [plan.span_id])

    # 2 —— 工具选型：期望的首个工具没被调用
    if expected and (not actual or expected[0] not in actual):
        got = actual[0] if actual else "（无）"
        return Attribution(
            "L2",
            f"应调用 `{expected[0]}`，实际首个调用是 `{got}`；意图为「{plan.intent}」，"
            f"说明工具描述与用户表述之间存在歧义",
            [plan.span_id, *[t.span_id for t in trace.tool_calls]],
        )

    # 3 —— 参数填充：工具选对了，参数/schema 不对
    if "tool_args" in failed or any(not t.schema_ok for t in trace.tool_calls):
        bad = next((t for t in trace.tool_calls if not t.schema_ok), trace.tool_calls[0] if trace.tool_calls else None)
        return Attribution(
            "L3",
            failed.get("tool_args", "工具参数 schema 校验失败"),
            [bad.span_id] if bad else [],
        )

    # 4 —— 结果解读：工具返回正常，答案却和观测对不上
    answer_issue = failed.get("answer_text") or failed.get("llm_faithfulness")
    if answer_issue:
        obs_ok = all(o.ok for o in trace.observations) if trace.observations else False
        # LLM 裁判确认答案忠实于观测，且期望内容在观测里根本不存在：照实转述也答不对，
        # 根因在数据源（L5）。只看「观测里找不到」不够——均分、绩点这类推算值本来就不在观测里
        absent = _absent_from_observations(case, trace)
        faithful = any(c.check == "llm_faithfulness" and c.passed for c in trace.verdict.checks)
        if obs_ok and absent and faithful:
            return Attribution(
                "L5",
                f"LLM 裁判确认答案忠实于观测，但期望内容 {absent} 在观测中不存在：数据源返回的数据本身有误或缺失",
                [o.span_id for o in trace.observations],
            )
        if obs_ok:
            return Attribution(
                "L4",
                f"工具返回正常，但答案未忠实反映观测：{answer_issue}",
                [o.span_id for o in trace.observations],
            )

    # 性能预算：答案没问题、只是超预算。必须在 5 之前，否则带检索的用例会被误归知识源
    if "budget" in failed and not answer_issue:
        return _attribute_budget(case, trace)

    # 多余调用：exact 模式下期望工具都调了、答案也没问题，只是额外多调了别的工具。
    # 必须在 5 之前，否则顺手多检索一次通知会因为 trace 里有 retrieve 被误归知识源
    if "tool_sequence" in failed and case.expect.mode == "exact":
        required = [t.name for t in case.expect.tools if not t.optional]
        allowed = {t.name for t in case.expect.tools}
        extra = [n for n in _distinct(actual) if n not in allowed]
        if extra and all(n in actual for n in required):
            return Attribution(
                "L1",
                f"期望工具均已调用，但额外调用了 {extra}（实际 {actual}）：规划冗余",
                [plan.span_id, *[t.span_id for t in trace.tool_calls if t.name in extra]],
            )

    # 5 —— 知识与检索：答案忠实，但拿到的知识/数据本身就是错的
    if trace.retrieves:
        ret = trace.retrieves[0]
        if not ret.chunk_ids:
            return Attribution("L5", "检索目标明确但零召回", [ret.span_id])
        return Attribution(
            "L5",
            f"答案忠实于召回内容，问题在知识源本身（命中 {ret.chunk_ids}，最高分 "
            f"{max(ret.scores) if ret.scores else 'n/a'}）",
            [ret.span_id],
        )
    bad_obs = [o for o in trace.observations if not o.ok]
    if bad_obs:
        return Attribution(
            "L5",
            f"工具/数据源返回异常：{bad_obs[0].error or '空结果'}",
            [o.span_id for o in bad_obs],
        )

    # 都不匹配 —— 不硬凑，进人工复核
    return Attribution("L1", f"未命中既定规则，需人工复核。失败项：{list(failed)}", [])


def _attribute_budget(case: Case, trace: Trace) -> Attribution:
    budget = case.expect.budget
    assert budget is not None
    calls = trace.tool_calls
    if budget.tool_calls is not None and len(calls) > budget.tool_calls:
        return Attribution(
            "L1",
            f"调用了 {len(calls)} 次工具（预算 {budget.tool_calls} 次）：{trace.tool_names}，规划冗余",
            [*([trace.plan.span_id] if trace.plan else []), *[t.span_id for t in calls]],
        )
    data_spans = [*trace.observations, *trace.retrieves]
    data_ms = sum(s.latency_ms for s in data_spans)
    if budget.latency_ms is not None and trace.latency_ms > budget.latency_ms:
        model_ms = max(trace.latency_ms - data_ms, 0)
        slow = max(data_spans, key=lambda s: s.latency_ms, default=None)
        where = (
            f"数据源 {data_ms:.0f}ms（最慢 {slow.span_id}）"
            if slow is not None and data_ms >= model_ms
            else f"模型 {model_ms:.0f}ms"
        )
        return Attribution(
            "L0",
            f"端到端 {trace.latency_ms:.0f}ms 超出预算 {budget.latency_ms:.0f}ms，主要耗在{where}；"
            f"数据源合计 {data_ms:.0f}ms / 模型合计 {model_ms:.0f}ms",
            [slow.span_id] if slow is not None and data_ms >= model_ms else [],
        )
    return Attribution(
        "L1",
        f"工具调用次数在预算内，但 token {trace.tokens.total} 超出预算 {budget.tokens}："
        f"推理轮次或上下文过长，需人工复核",
        [trace.plan.span_id] if trace.plan else [],
    )


def _absent_from_observations(case: Case, trace: Trace) -> list[str]:
    """answer_contains 中答案缺失、且在任何观测原始数据里也找不到的条目。"""
    import json

    seen = " ".join(json.dumps(o.raw, ensure_ascii=False) for o in trace.observations if o.raw is not None)
    return [s for s in case.expect.answer_contains if s not in trace.answer and s not in seen]


def _distinct(names: list[str]) -> list[str]:
    """按首次出现顺序去重。"""
    return list(dict.fromkeys(names))


def attribute_all(pairs: list[tuple[Case, Trace]]) -> dict[str, int]:
    """统计各层命中数，供报告热力图使用。"""
    counter: dict[str, int] = {}
    for case, trace in pairs:
        if trace.verdict.rule != "fail":
            continue
        att = attribute(case, trace)
        trace.layer = att.layer  # type: ignore[assignment]
        trace.layer_reason = att.reason
        trace.layer_evidence = att.evidence
        counter[att.layer] = counter.get(att.layer, 0) + 1
    return dict(sorted(counter.items()))
