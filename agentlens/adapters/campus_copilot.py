"""CampusCopilot 参考实现 —— AgentLens 的第一个被测对象。

它不是主角，是**靶子**：存在意义是证明"这套方法在真实业务 Agent 上跑得通"。
所以它是 v0 的确定性实现（零 LLM 调用、零网络依赖），同 seed 必然同结果 ——
这直接满足 G4（复跑差异 <=1pp），也让演示不押在网络和额度上（PRD §7 风险表）。

**已知且刻意保留的缺陷**（不许修，它们是归因演示的素材）：

1. 单步规划：只会挑一个工具，不会串联「查课表 + 查规章」这类组合任务 → 制造 L1 样本
2. 关键词首命中：`课` 排在 `成绩` 之前，"那几门课最后都过了吗" 会被判成查课表 → 制造 L2 样本
3. 护栏用敏感词表：`挂科` 直接拒答，哪怕问的是"怎么办" → 制造 L6（护栏误伤）样本

真实 Agent 的缺陷多种多样，这三条只是最小可复现的一组。
"""

from __future__ import annotations

import re
import time
from typing import Any

from ..cases import Case
from ..schema import (
    GenerateSpan,
    GuardrailSpan,
    ObservationSpan,
    PlanSpan,
    RetrieveSpan,
    TokenUsage,
    ToolCallSpan,
)
from .base import AgentOutput, BaseAdapter
from ..tools import FixtureStore, make_registry

# 关键词首命中表。顺序即优先级 —— 顺序本身就是缺陷来源之一。
KEYWORD_RULES: list[tuple[tuple[str, ...], str]] = [
    (("课表", "课程", "上课", "几节课", "课"), "get_timetable"),
    (("成绩", "绩点", "分数", "过了", "学分"), "get_grades"),
    (("余额", "饭卡", "校园卡", "消费", "刷卡"), "get_card_balance"),
    (("规定", "办法", "制度", "流程", "怎么办", "怎么弄"), "search_regulations"),
    (("报修", "坏了", "维修", "漏水", "灯不亮"), "submit_repair"),
]

# 前置护栏：v0 只有两条规则，都故意做得粗糙
GUARDRAIL_CROSS_USER = ("同学", "室友", "别人的", "其他人", "他的", "她的")
GUARDRAIL_SENSITIVE = ("挂科", "退学", "处分")

REFUSAL_CROSS_USER = "抱歉，我只能查询你本人的信息，无法查询他人的成绩与校园卡数据。"
REFUSAL_SENSITIVE = "这个话题我不方便回答，建议你联系辅导员或教务处。"


class CampusCopilotAdapter(BaseAdapter):
    name = "campus_copilot"
    model = "rule-based@v0"

    def __init__(self, store: FixtureStore | None = None, faults: dict[str, str] | None = None) -> None:
        self.store = store or FixtureStore()
        self.tools = make_registry(self.store)
        self.faults = faults or {}   # M3 故障注入挂载点：{tool_name: 500|timeout|empty|dirty}

    # -- 护栏 --------------------------------------------------------
    def _guardrail(self, text: str) -> tuple[bool, str | None, str | None]:
        if any(k in text for k in GUARDRAIL_CROSS_USER):
            return True, "cross_user_access", REFUSAL_CROSS_USER
        if any(k in text for k in GUARDRAIL_SENSITIVE):
            return True, "sensitive_topic", REFUSAL_SENSITIVE
        return False, None, None

    # -- 规划 --------------------------------------------------------
    def _plan(self, text: str) -> tuple[str, str, dict[str, Any]]:
        for keys, tool in KEYWORD_RULES:
            if any(k in text for k in keys):
                return tool, f"用户想通过 {tool} 获取信息", self._build_args(tool, text)
        return "search_regulations", "没听懂，兜底走规章检索", {"query": text, "top_k": 3}

    def _build_args(self, tool: str, text: str) -> dict[str, Any]:
        term = self.store.term
        if tool == "get_timetable":
            m = re.search(r"第\s*(\d+)\s*周", text)
            return {"week": int(m.group(1)) if m else 8, "term": term}
        if tool == "get_grades":
            m = re.search(r"(20\d{2}\s*-\s*20\d{2}\s*-\s*[12])", text)
            return {"term": m.group(1).replace(" ", "") if m else "2025-2026-2"}
        if tool == "search_regulations":
            return {"query": text, "top_k": 3}
        if tool == "submit_repair":
            return {"location": "未指明地点", "issue": text}
        return {}

    # -- 执行 --------------------------------------------------------
    def invoke(self, case: Case, *, run_id: str) -> AgentOutput:
        t0 = time.perf_counter()
        text = case.input.text
        spans: list[Any] = []
        step = 0
        elapsed = 0

        def tick() -> float:
            nonlocal elapsed
            elapsed = round((time.perf_counter() - t0) * 1000, 1)
            return elapsed

        tool, intent, args = self._plan(text)
        step += 1
        spans.append(PlanSpan(span_id=f"s{step}", step=step, intent=intent, steps=[tool], t_start_ms=tick()))

        refused, rule, refusal_text = self._guardrail(text)
        step += 1
        spans.append(
            GuardrailSpan(
                span_id=f"s{step}",
                step=step,
                triggered=refused,
                rule=rule,
                action="refuse" if refused else "allow",
                reason=refusal_text,
                t_start_ms=tick(),
            )
        )

        if refused:
            step += 1
            spans.append(
                GenerateSpan(
                    span_id=f"s{step}",
                    step=step,
                    answer_ref="ans/inline",
                    citations=[],
                    t_start_ms=tick(),
                )
            )
            return AgentOutput(
                status="ok",
                answer=refusal_text or "",
                spans=spans,
                latency_ms=tick(),
                meta={"run_id": run_id, "planned_tool": tool, "guardrail_blocked": True},
            )

        # 工具调用
        step += 1
        call_id = f"s{step}"
        schema_errors = [f"未知工具 {tool}"] if tool not in self.tools else []
        spans.append(
            ToolCallSpan(
                span_id=call_id,
                step=step,
                name=tool,
                args=args,
                schema_ok=not schema_errors,
                schema_errors=schema_errors,
                t_start_ms=tick(),
            )
        )

        result = self.tools[tool](**args) if not schema_errors else None
        latency = getattr(result, "latency_ms", 0)
        ok = bool(result and result.ok)

        if tool == "search_regulations" and ok:
            chunks = result.data
            step += 1
            spans.append(
                RetrieveSpan(
                    span_id=f"s{step}",
                    step=step,
                    parent=call_id,
                    query=args["query"],
                    chunk_ids=[c["chunk_id"] for c in chunks],
                    scores=[c["score"] for c in chunks],
                    t_start_ms=tick(),
                    latency_ms=latency,
                )
            )

        step += 1
        spans.append(
            ObservationSpan(
                span_id=f"s{step}",
                step=step,
                parent=call_id,
                ok=ok,
                row_count=len(result.data) if ok and isinstance(result.data, list) else (1 if ok else None),
                raw=result.data if ok else None,
                error=None if ok else getattr(result, "error", "未知错误"),
                t_start_ms=tick(),
                latency_ms=latency,
            )
        )

        answer, citations = self._generate(tool, args, result)
        step += 1
        spans.append(
            GenerateSpan(
                span_id=f"s{step}",
                step=step,
                parent=call_id,
                answer_ref="ans/inline",
                citations=citations,
                t_start_ms=tick(),
            )
        )

        return AgentOutput(
            status="ok" if ok else "error",
            answer=answer,
            spans=spans,
            tokens=TokenUsage(),
            latency_ms=tick(),
            meta={"run_id": run_id, "planned_tool": tool},
        )

    # -- 生成 --------------------------------------------------------
    def _generate(self, tool: str, args: dict[str, Any], result: Any) -> tuple[str, list[str]]:
        if result is None or not result.ok:
            return (f"查询失败了：{getattr(result, 'error', '工具不可用')}，稍后再试。", [])

        data = result.data
        if tool == "get_timetable":
            head = "；".join(f"{r['day']} {r['period']} 节《{r['course']}》@{r['room']}" for r in data[:3])
            return (f"第 {args['week']} 周（{args['term']}）共 {len(data)} 次课：{head}。", [])
        if tool == "get_grades":
            credits = sum(r["credit"] for r in data)
            gpa = sum(r["gp"] * r["credit"] for r in data) / credits if credits else 0.0
            passed = all(r["score"] >= 60 for r in data)
            tail = "全部及格" if passed else "有不及格科目"
            return (f"{args['term']} 共 {len(data)} 门课、{credits:.1f} 学分，加权平均绩点 {gpa:.2f}，{tail}。", [])
        if tool == "get_card_balance":
            return (f"校园卡余额 ¥{data['balance']:.2f}，今日已消费 ¥{data['today_spend']:.2f}。", [])
        if tool == "search_regulations":
            top = data[0]
            return (f"根据《{top['title']}》：{top['text']}", [top["chunk_id"]])
        if tool == "submit_repair":
            return (f"已提交报修，工单号 {data['ticket']}，地点 {data['location']}。", [])
        return (str(data), [])
