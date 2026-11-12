"""馆藏助手（`examples/library_agent/`）—— 接入示例：一个不认识 AgentLens 的 agent 怎么变成被测对象。

接入只做三件事，都在这个文件里：

1. **调起来**：进程内 import 示例 agent，调用它的 `run()`；用例的 messages / today 原样传入。
2. **管住大模型**：agent 的大模型是一个可替换的 `chat` 函数。录制时包一层把每次回复记下，
   回放时按录制顺序吐回去；工具照常在 agent 里执行。录制存 `recordings/library/<case_id>.json`，
   随仓库提交，复跑不联网。`AGENTLENS_RECORD=1` 时调用真实模型重录（key 读 `.env.agent`）。
3. **翻成 span**：agent 只给事件日志（guard / llm / plan / tool / answer），这里映射成
   guardrail / plan / tool_call / retrieve / observation / generate。时间轴用录制里的模型耗时累加，
   回放结果与录制时一致。

agent 吐不出规划、工具参数这类中间步骤时，对应的断言和归因层就无从谈起——这是 adapter 能做到的上限。
"""

from __future__ import annotations

import hashlib
import json
import os
import sys
from datetime import date
from pathlib import Path
from typing import Any

from ..cases import Case
from ..schema import (
    GenerateSpan,
    GuardrailSpan,
    ObservationSpan,
    PlanSpan,
    RetrieveSpan,
    Span,
    TokenUsage,
    ToolCallSpan,
)
from .base import AgentOutput, BaseAdapter

ROOT = Path(__file__).resolve().parents[2]
RECORDINGS = ROOT / "recordings" / "library"
ENV_FILE = ROOT / ".env.agent"
DEFAULT_TODAY = "2026-09-21"
REPLAY_FORMAT = 1

sys.path.insert(0, str(ROOT / "examples"))
from library_agent import agent as library_agent  # noqa: E402


class ReplayExhausted(RuntimeError):
    """回放的回复用完了：agent 的调用序列与录制时不一致，需要重录。"""


class LibraryAdapter(BaseAdapter):
    name = "library"
    model = "unknown"

    def __init__(self, record: bool | None = None) -> None:
        self.record = os.environ.get("AGENTLENS_RECORD") == "1" if record is None else record

    def invoke(self, case: Case, *, run_id: str) -> AgentOutput:
        messages = [m.model_dump() for m in case.input.messages]
        today = case.input.options.get("today", DEFAULT_TODAY)
        sha = _input_sha(messages, today)
        rec_file = RECORDINGS / f"{case.id}.json"

        if self.record:
            _load_env_file()
            if "AGENT_LLM_API_KEY" not in os.environ:
                return _blocked(f"录制需要 AGENT_LLM_API_KEY / AGENT_LLM_MODEL（写在 {ENV_FILE.name}）")
            inner = library_agent.openai_chat()
            replies: list[dict[str, Any]] = []

            def chat(msgs, tools):
                reply = inner(msgs, tools)
                replies.append(reply)
                return reply

            model = inner.model  # type: ignore[attr-defined]
        else:
            if not rec_file.exists():
                return _blocked(f"没有录制：{rec_file.relative_to(ROOT)}（AGENTLENS_RECORD=1 录一次）")
            recording = json.loads(rec_file.read_text(encoding="utf-8"))
            if recording.get("format") != REPLAY_FORMAT or recording.get("input_sha") != sha:
                return _blocked("用例输入与录制时不一致，需要重录")
            queue = list(recording["replies"])
            model = recording["model"]

            def chat(msgs, tools):
                if not queue:
                    raise ReplayExhausted(f"录制只有 {len(recording['replies'])} 次回复，agent 还在请求")
                return queue.pop(0)

        result = library_agent.run(messages, chat=chat, today=date.fromisoformat(today))
        if self.record:
            RECORDINGS.mkdir(parents=True, exist_ok=True)
            rec_file.write_text(json.dumps(
                {"format": REPLAY_FORMAT, "model": model, "input_sha": sha, "replies": replies},
                ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

        self.model = model
        spans, elapsed = to_spans(result.events)
        meta: dict[str, Any] = {"model": model, "today": today}
        if result.error:
            meta["error"] = result.error
        return AgentOutput(
            status=result.status, answer=result.answer, spans=spans,
            tokens=TokenUsage(prompt=result.prompt_tokens, completion=result.completion_tokens),
            latency_ms=elapsed, meta=meta,
        )


def to_spans(events: list[dict[str, Any]]) -> tuple[list[Span], float]:
    """事件日志 → span。返回 (spans, 总耗时)；耗时是逻辑时钟，只累加录制里的模型耗时。"""
    spans: list[Span] = []
    clock = 0.0
    pending_ms = 0.0   # 一次模型调用的耗时：记到它产出的第一个 span 上
    plan_id: str | None = None

    def add(cls, *, latency_ms: float = 0.0, parent: str | None = None, **fields: Any) -> Span:
        nonlocal clock
        step = len(spans) + 1
        span = cls(span_id=f"s{step}", step=step, parent=parent, t_start_ms=round(clock, 1),
                   latency_ms=int(round(latency_ms)), **fields)
        clock += latency_ms
        spans.append(span)
        return span

    for ev in events:
        kind = ev["type"]
        if kind == "guard":
            add(GuardrailSpan, triggered=True, rule=ev["rule"], action=ev["action"])
        elif kind == "llm":
            pending_ms = ev["latency_ms"]
        elif kind == "plan":
            span = add(PlanSpan, latency_ms=pending_ms, intent=ev["intent"], steps=ev["steps"])
            pending_ms = 0.0
            plan_id = plan_id or span.span_id
        elif kind == "tool":
            clock += pending_ms
            pending_ms = 0.0
            call = add(ToolCallSpan, parent=plan_id, name=ev["name"], args=ev["args"],
                       schema_ok=not ev["arg_errors"], schema_errors=ev["arg_errors"])
            result = ev.get("result")
            if ev["name"] == "search_books" and ev["ok"]:
                add(RetrieveSpan, parent=call.span_id, query=ev["args"]["keyword"],
                    chunk_ids=[b["book_id"] for b in result])
            add(ObservationSpan, parent=call.span_id, ok=ev["ok"], error=ev.get("error"),
                row_count=len(result) if isinstance(result, list) else None, raw=result)
        elif kind == "answer":
            add(GenerateSpan, latency_ms=ev["latency_ms"], answer_ref="answer")
    return spans, round(clock, 1)


def _input_sha(messages: list[dict[str, Any]], today: str) -> str:
    canonical = json.dumps({"messages": messages, "today": today}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()[:16]


def _load_env_file() -> None:
    """把 .env.agent 里的 AGENT_LLM_* 补进环境变量；已存在的环境变量优先。key 只待在文件里。"""
    if not ENV_FILE.exists():
        return
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key.startswith("AGENT_LLM_") and key not in os.environ:
            os.environ[key] = value.strip().strip('"').strip("'")


def _blocked(reason: str) -> AgentOutput:
    return AgentOutput(status="blocked", meta={"error": reason})
