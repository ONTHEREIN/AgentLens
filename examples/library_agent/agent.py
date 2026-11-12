"""馆藏助手：一个极简的图书馆借阅问答智能体，AgentLens 接入示例里的「别人家的 agent」。

它不知道 AgentLens 的存在：没有 span、没有断言，运行时只顺手记一份事件日志（events），
这是多数 agent 框架都有的东西（回调、运行日志）。把事件日志翻成 span 是 AgentLens 一侧
adapter 的事，见 `agentlens/adapters/library.py`。

流程：护栏（查他人借阅记录直接拒绝）→ 先调用 make_plan 伪工具写计划 → tool-calling 循环（最多 6 轮）
→ 最终回答。大模型走 OpenAI 兼容接口，只用标准库；数据全部虚构（books.json）。

    AGENT_LLM_API_KEY=... AGENT_LLM_MODEL=... python examples/library_agent/agent.py "有没有讲机器学习的书"
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any, Callable

DATA = json.loads((Path(__file__).with_name("books.json")).read_text(encoding="utf-8"))
MAX_ROUNDS = 6
REFUSAL = "抱歉，借阅记录属于个人隐私，我只能查询你本人的借阅情况。"

# 工具名 → (说明, 参数 {名字: (类型, 是否必填, 说明)})
TOOLS: dict[str, tuple[str, dict[str, tuple[type, bool, str]]]] = {
    "search_books": ("按书名、作者或主题关键词检索馆藏，返回匹配的书目",
                     {"keyword": (str, True, "检索关键词，如「机器学习」「林知远」")}),
    "get_availability": ("查询某本书各复本的馆藏位置与借阅状态",
                         {"book_id": (str, True, "书目编号，形如 B001，来自 search_books 的结果")}),
    "get_my_loans": ("查询当前读者本人在借的书、应还日期与剩余续借次数", {}),
}

PLAN_TOOL = {
    "type": "function",
    "function": {
        "name": "make_plan",
        "description": "在调用任何工具之前，写下你对用户意图的理解和打算调用的工具顺序",
        "parameters": {
            "type": "object",
            "properties": {
                "intent": {"type": "string", "description": "一句话概括用户想要什么"},
                "steps": {"type": "array", "items": {"type": "string", "enum": list(TOOLS)},
                          "description": "按顺序列出要调用的工具名；不需要工具时为空数组"},
            },
            "required": ["intent", "steps"],
        },
    },
}

# 护栏：只拦「查别人的借阅记录」这一类，规则写得很窄
_OTHERS = re.compile(r"(室友|同学|别人|他人|学号\s*\d+|[他她]的).{0,12}(借|还|借阅)")

# chat(messages, tools) -> 回复 dict：content / tool_calls[{id,name,arguments}] / reasoning /
#                           prompt_tokens / completion_tokens / latency_ms
Chat = Callable[[list[dict[str, Any]], list[dict[str, Any]]], dict[str, Any]]


@dataclass
class AgentRun:
    status: str                      # ok / error
    answer: str = ""
    events: list[dict[str, Any]] = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    error: str | None = None


def openai_chat(model: str | None = None) -> Chat:
    """OpenAI 兼容的 /chat/completions，配置读环境变量 AGENT_LLM_*。"""
    model = model or os.environ["AGENT_LLM_MODEL"]
    base = (os.environ.get("AGENT_LLM_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    key = os.environ["AGENT_LLM_API_KEY"]

    def chat(messages: list[dict[str, Any]], tools: list[dict[str, Any]]) -> dict[str, Any]:
        body = json.dumps({"model": model, "messages": messages, "tools": tools,
                           "tool_choice": "auto", "temperature": 0}).encode("utf-8")
        req = urllib.request.Request(f"{base}/chat/completions", data=body, headers={
            "Authorization": f"Bearer {key}", "Content-Type": "application/json"})
        start = time.perf_counter()
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        msg = data["choices"][0]["message"]
        usage = data.get("usage") or {}
        return {
            "content": msg.get("content"),
            "tool_calls": [{"id": c["id"], "name": c["function"]["name"],
                            "arguments": c["function"].get("arguments") or "{}"}
                           for c in msg.get("tool_calls") or []],
            "reasoning": msg.get("reasoning_content"),
            "prompt_tokens": usage.get("prompt_tokens", 0),
            "completion_tokens": usage.get("completion_tokens", 0),
            "latency_ms": round((time.perf_counter() - start) * 1000, 1),
        }

    chat.model = model  # type: ignore[attr-defined]
    return chat


def run(messages: list[dict[str, str]], *, chat: Chat, today: date) -> AgentRun:
    """执行一轮对话。messages 为历史 + 本轮用户消息（最后一条必须是 user）。"""
    out = AgentRun(status="ok")
    if _OTHERS.search(messages[-1]["content"]):
        out.events.append({"type": "guard", "rule": "others_loans", "action": "refuse"})
        out.answer = REFUSAL
        return out

    convo: list[dict[str, Any]] = [{"role": "system", "content": _system_prompt(today)}, *messages]
    tools = [PLAN_TOOL, *_tool_defs()]
    try:
        for _ in range(MAX_ROUNDS):
            reply = chat(convo, tools)
            out.prompt_tokens += reply["prompt_tokens"]
            out.completion_tokens += reply["completion_tokens"]
            convo.append(_as_message(reply))
            if not reply["tool_calls"]:
                out.events.append({"type": "answer", "latency_ms": reply["latency_ms"]})
                out.answer = reply["content"] or ""
                return out
            out.events.append({"type": "llm", "latency_ms": reply["latency_ms"]})
            for call in reply["tool_calls"]:
                args = _loads(call["arguments"])
                if call["name"] == "make_plan":
                    out.events.append({"type": "plan", "intent": str(args.get("intent", "")),
                                       "steps": [str(s) for s in args.get("steps") or []]})
                    content: Any = "计划已记录，请开始执行。"
                else:
                    content = _call_tool(call["name"], args, today, out.events)
                convo.append({"role": "tool", "tool_call_id": call["id"],
                              "content": json.dumps(content, ensure_ascii=False)})
        out.status, out.error = "error", f"{MAX_ROUNDS} 轮内未给出最终回答"
    except Exception as exc:  # noqa: BLE001 —— 大模型调用失败也要交回已有的事件日志
        out.status, out.error = "error", f"{type(exc).__name__}: {exc}"
    return out


def _system_prompt(today: date) -> str:
    return (
        "你是「馆藏助手」，帮读者检索图书馆馆藏、查询复本借阅状态、查询本人的借阅记录。\n"
        f"今天是 {today.isoformat()}。\n"
        "1. 先调用 make_plan 写下意图和打算调用的工具顺序；\n"
        "2. 回答必须以工具返回的数据为依据，不要编造馆藏、位置或日期；\n"
        "3. 你只能查询，不能替读者办理借书、续借、预约等业务，遇到这类请求请说明并引导去服务台或自助机；\n"
        "4. 用简洁的中文回答。"
    )


def _tool_defs() -> list[dict[str, Any]]:
    defs = []
    for name, (desc, params) in TOOLS.items():
        props = {p: {"type": "string", "description": d} for p, (_, _, d) in params.items()}
        required = [p for p, (_, req, _) in params.items() if req]
        defs.append({"type": "function", "function": {
            "name": name, "description": desc,
            "parameters": {"type": "object", "properties": props, "required": required}}})
    return defs


def _call_tool(name: str, args: dict[str, Any], today: date, events: list[dict[str, Any]]) -> Any:
    event: dict[str, Any] = {"type": "tool", "name": name, "args": args, "arg_errors": _check_args(name, args)}
    events.append(event)
    if event["arg_errors"]:
        event.update(ok=False, error="invalid_args")
        return {"error": "参数不合法", "details": event["arg_errors"]}
    if name == "search_books":
        kw = args["keyword"].strip().lower()
        result: Any = [{k: b[k] for k in ("book_id", "title", "author", "year")} for b in DATA["books"]
                       if kw in b["title"].lower() or kw in b["author"].lower()
                       or any(kw in t.lower() for t in b["tags"])]
    elif name == "get_availability":
        book = next((b for b in DATA["books"] if b["book_id"] == args["book_id"]), None)
        if book is None:
            event.update(ok=False, error="not_found")
            return {"error": "没有这个书目编号"}
        result = {"book_id": book["book_id"], "title": book["title"], "copies": DATA["copies"][book["book_id"]]}
    else:
        result = [{**loan, "overdue": date.fromisoformat(loan["due"]) < today} for loan in DATA["my_loans"]]
    event.update(ok=True, result=result)
    return result


def _check_args(name: str, args: dict[str, Any]) -> list[str]:
    if name not in TOOLS:
        return [f"没有这个工具：{name}"]
    params = TOOLS[name][1]
    errors = [f"未知参数：{k}" for k in args if k not in params]
    for p, (typ, required, _) in params.items():
        if p not in args:
            if required:
                errors.append(f"缺少必填参数：{p}")
        elif not isinstance(args[p], typ) or (typ is str and not args[p].strip()):
            errors.append(f"参数 {p} 应为非空{typ.__name__}")
    return errors


def _as_message(reply: dict[str, Any]) -> dict[str, Any]:
    msg: dict[str, Any] = {"role": "assistant", "content": reply["content"]}
    if reply.get("reasoning") is not None:
        msg["reasoning_content"] = reply["reasoning"]  # 思考模式模型要求同一轮原样回传
    if reply["tool_calls"]:
        msg["tool_calls"] = [{"id": c["id"], "type": "function",
                              "function": {"name": c["name"], "arguments": c["arguments"]}}
                             for c in reply["tool_calls"]]
    return msg


def _loads(raw: str) -> dict[str, Any]:
    try:
        value = json.loads(raw or "{}")
    except json.JSONDecodeError:
        return {}
    return value if isinstance(value, dict) else {}


if __name__ == "__main__":
    result = run([{"role": "user", "content": " ".join(sys.argv[1:]) or "有没有讲机器学习的书"}],
                 chat=openai_chat(), today=date.today())
    print(result.answer or result.error)
