"""Adapter 契约：接入一个新 Agent 只需要实现 invoke()（PRD G5 / P1-4）。

被测对象对框架的唯一要求是：能吐出分 span 的 trace。
吐不出来的（比如 Dify 这种拿不到内部步骤的编排器）只能做消融对照组，
当不了主版本 —— 这是已定稿的技术决策。
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from ..cases import Case
from ..schema import Span, TokenUsage


class AgentOutput(BaseModel):
    """Adapter 的返回值。run_id / 判定 / 归因由 Runner 统一封装，adapter 不管这些。"""

    model_config = ConfigDict(extra="forbid")

    status: str = "ok"
    answer: str = ""
    spans: list[Span] = Field(default_factory=list)
    tokens: TokenUsage = Field(default_factory=TokenUsage)
    latency_ms: float = 0.0
    meta: dict[str, Any] = Field(default_factory=dict)


class BaseAdapter(ABC):
    name: str = "base"
    model: str = "unknown"

    @abstractmethod
    def invoke(self, case: Case, *, run_id: str) -> AgentOutput:
        """执行一条用例，返回带 span 的链路。实现方负责保证同 seed 下可复现。"""
