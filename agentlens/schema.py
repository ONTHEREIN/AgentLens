"""AgentLens Trace Schema v0.1 —— 产品地基（PRD §7.1）。

设计原则：**每个 span 都必须能被一个独立的子测试断言**。

    plan        -> 意图对不对         (L1)
    tool_call   -> 选型/参数对不对     (L2 / L3)
    observation -> 工具本身健不健康    (L0/L5)
    retrieve    -> 召回对不对         (L5)
    generate    -> 解读对不对         (L4)
    guardrail   -> 该拒的拒了吗/误拒   (L6)

没有分 span，归因就只能靠 LLM 猜；靠猜的归因不可信。
"""

from __future__ import annotations

from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field

SCHEMA_VERSION = "0.1"

# 7 个测试维度：逐条对应赛题官方原文 §2，措辞以原文为准，不自造、不合并。
# 参数填充 / 答案忠实度不是官方维度，它们是归因层（L3 / L4），用例里用 tags 表达。
Dimension = Literal[
    "functional_accuracy",  # 功能准确性测试
    "tool_use",             # 工具调用测试
    "rag_retrieval",        # RAG 检索质量测试
    "multi_turn",           # 多轮对话测试
    "adversarial_safety",   # 对抗性与安全测试
    "boundary_exception",   # 边界与异常测试
    "performance",          # 性能测试
]

DIMENSIONS: tuple[str, ...] = (
    "functional_accuracy",
    "tool_use",
    "rag_retrieval",
    "multi_turn",
    "adversarial_safety",
    "boundary_exception",
    "performance",
)

SPAN_KINDS: tuple[str, ...] = (
    "plan",
    "tool_call",
    "observation",
    "retrieve",
    "generate",
    "guardrail",
)

# 归因层：L0 不属于五层（环境层），L6 单列（护栏误伤）
Layer = Literal["L0", "L1", "L2", "L3", "L4", "L5", "L6"]

LAYER_NAMES: dict[str, str] = {
    "L0": "环境/超时",
    "L1": "意图与规划",
    "L2": "工具选型",
    "L3": "参数填充",
    "L4": "结果解读",
    "L5": "知识与检索",
    "L6": "护栏误伤",
}


class _Strict(BaseModel):
    """拒绝未知字段：schema 漂移必须在写入前就炸，而不是等到归因阶段才发现缺信息。"""

    model_config = ConfigDict(extra="forbid")


# ---------------------------------------------------------------- spans


class BaseSpan(_Strict):
    span_id: str
    step: int
    parent: str | None = None
    t_start_ms: float = 0.0
    latency_ms: int = 0


class PlanSpan(BaseSpan):
    span: Literal["plan"] = "plan"
    intent: str
    steps: list[str] = Field(default_factory=list)
    notes: str | None = None


class ToolCallSpan(BaseSpan):
    span: Literal["tool_call"] = "tool_call"
    name: str
    args: dict[str, Any] = Field(default_factory=dict)
    schema_ok: bool = True
    schema_errors: list[str] = Field(default_factory=list)


class ObservationSpan(BaseSpan):
    span: Literal["observation"] = "observation"
    ok: bool = True
    row_count: int | None = None
    raw: Any = None          # 小样本内联
    raw_ref: str | None = None  # 大样本落盘
    error: str | None = None


class RetrieveSpan(BaseSpan):
    span: Literal["retrieve"] = "retrieve"
    query: str
    chunk_ids: list[str] = Field(default_factory=list)
    scores: list[float] = Field(default_factory=list)


class GenerateSpan(BaseSpan):
    span: Literal["generate"] = "generate"
    answer_ref: str | None = None
    citations: list[str] = Field(default_factory=list)


class GuardrailSpan(BaseSpan):
    span: Literal["guardrail"] = "guardrail"
    triggered: bool = False
    rule: str | None = None
    action: Literal["allow", "refuse", "rewrite"] = "allow"
    reason: str | None = None


Span = Annotated[
    Union[
        PlanSpan,
        ToolCallSpan,
        ObservationSpan,
        RetrieveSpan,
        GenerateSpan,
        GuardrailSpan,
    ],
    Field(discriminator="span"),
]


# ---------------------------------------------------------------- verdict


class TokenUsage(_Strict):
    prompt: int = 0
    completion: int = 0

    @property
    def total(self) -> int:
        return self.prompt + self.completion


class CheckResult(_Strict):
    check: str
    passed: bool
    reason: str
    evidence: list[str] = Field(default_factory=list)


class Verdict(_Strict):
    rule: Literal["pass", "fail", "skip"] = "skip"
    checks: list[CheckResult] = Field(default_factory=list)
    llm_score: int | None = None       # M2 才有
    judge_degraded: bool = False       # 裁判返回结构化失败时的降级标记

    @property
    def failed(self) -> list[CheckResult]:
        return [c for c in self.checks if not c.passed]


# ---------------------------------------------------------------- trace


class Trace(_Strict):
    schema_version: str = SCHEMA_VERSION
    run_id: str
    case_id: str
    adapter: str
    # 多轮对话：同一 conversation_id 下按 turn 递增串起多条 trace；单轮用例保持默认
    conversation_id: str | None = None
    turn: int = 0
    seed: int = 42
    model: str = "rule-based@v0"
    status: Literal["ok", "error", "timeout", "blocked"] = "ok"
    answer: str = ""
    spans: list[Span] = Field(default_factory=list)
    tokens: TokenUsage = Field(default_factory=TokenUsage)
    latency_ms: float = 0.0
    verdict: Verdict = Field(default_factory=Verdict)
    # 归因结果由 attribute.py 回填，保证 trace 自身即"结论可复现"的载体
    layer: Layer | None = None
    layer_reason: str | None = None
    layer_evidence: list[str] = Field(default_factory=list)
    meta: dict[str, Any] = Field(default_factory=dict)

    # -- 便捷取数：归因与裁判都靠这些，而不是自己去翻 spans
    @property
    def plan(self) -> PlanSpan | None:
        return next((s for s in self.spans if isinstance(s, PlanSpan)), None)

    @property
    def tool_calls(self) -> list[ToolCallSpan]:
        return [s for s in self.spans if isinstance(s, ToolCallSpan)]

    @property
    def observations(self) -> list[ObservationSpan]:
        return [s for s in self.spans if isinstance(s, ObservationSpan)]

    @property
    def retrieves(self) -> list[RetrieveSpan]:
        return [s for s in self.spans if isinstance(s, RetrieveSpan)]

    @property
    def guardrail(self) -> GuardrailSpan | None:
        return next((s for s in self.spans if isinstance(s, GuardrailSpan)), None)

    @property
    def refused(self) -> bool:
        g = self.guardrail
        return bool(g and g.triggered and g.action == "refuse")

    @property
    def tool_names(self) -> list[str]:
        return [t.name for t in self.tool_calls]

    def tool_call(self, name: str) -> ToolCallSpan | None:
        return next((t for t in self.tool_calls if t.name == name), None)

    def observation_of(self, call: ToolCallSpan) -> ObservationSpan | None:
        return next((o for o in self.observations if o.parent == call.span_id), None)

    def dump(self) -> dict[str, Any]:
        return self.model_dump(mode="json")
