"""CampusCopilot 的 5 个工具，全部打在构造数据上（合规：零真实学号/姓名/成绩）。

工具层单独抽出来，是为了 M3 的故障注入（P1-1）能以一个中间件的形式挂进来，
而不是去改 adapter 的业务逻辑。
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


@dataclass
class ToolResult:
    ok: bool
    data: Any = None
    error: str | None = None
    latency_ms: int = 0


class FixtureStore:
    """构造数据集。所有数据为虚构，见 fixtures/campus.json 的 _note。"""

    def __init__(self, path: Path | None = None) -> None:
        self.path = path or (Path(__file__).resolve().parents[1] / "fixtures" / "campus.json")
        self._data: dict[str, Any] = json.loads(self.path.read_text(encoding="utf-8"))

    @property
    def term(self) -> str:
        return self._data["term_current"]

    def timetable(self, week: int, term: str) -> ToolResult:
        terms = self._data["timetable"].get(term)
        if terms is None:
            return ToolResult(False, error=f"未知学期 {term}", latency_ms=41)
        rows = terms.get(str(week))
        if rows is None:
            return ToolResult(False, error=f"第 {week} 周无课表记录", latency_ms=38)
        return ToolResult(True, data=rows, latency_ms=63)

    def grades(self, term: str) -> ToolResult:
        rows = self._data["grades"].get(term)
        if rows is None:
            return ToolResult(False, error=f"未知学期 {term}", latency_ms=44)
        return ToolResult(True, data=rows, latency_ms=71)

    def card_balance(self) -> ToolResult:
        return ToolResult(True, data=self._data["card"], latency_ms=35)

    def search_regulations(self, query: str, top_k: int = 3) -> ToolResult:
        # v0 用字符重合度模拟检索（确定性、可复现）；M3 换成真向量库 + 召回质量注入
        chunks = []
        for c in self._data["regulations"]:
            body = c["title"] + c["text"]
            overlap = sum(1 for ch in set(query) if ch in body and not ch.isspace())
            chunks.append(
                {
                    "chunk_id": c["chunk_id"],
                    "title": c["title"],
                    "text": c["text"],
                    "score": round(min(0.99, 0.30 + 0.015 * overlap), 3),
                }
            )
        chunks.sort(key=lambda c: (-c["score"], c["chunk_id"]))
        return ToolResult(True, data=chunks[:top_k], latency_ms=52)

    def submit_repair(self, location: str, issue: str) -> ToolResult:
        ticket = f"R{20261025}{abs(hash((location, issue))) % 1000:03d}"
        return ToolResult(True, data={"ticket": ticket, "location": location, "issue": issue}, latency_ms=88)


def make_registry(store: FixtureStore) -> dict[str, Callable[..., ToolResult]]:
    """工具注册表。M3 的故障注入中间件就包在这一层外面。"""
    return {tool: getattr(store, method) for tool, method in TOOL_METHODS.items()}


TOOL_METHODS: dict[str, str] = {
    "get_timetable": "timetable",
    "get_grades": "grades",
    "get_card_balance": "card_balance",
    "search_regulations": "search_regulations",
    "submit_repair": "submit_repair",
}

# 工具参数 schema：规则裁判做参数校验时用它当白名单
TOOL_SCHEMAS: dict[str, dict[str, type]] = {
    "get_timetable": {"week": int, "term": str},
    "get_grades": {"term": str},
    "get_card_balance": {},
    "search_regulations": {"query": str, "top_k": int},
    "submit_repair": {"location": str, "issue": str},
}
