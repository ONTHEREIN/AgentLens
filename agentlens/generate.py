"""用例生成器：用 LLM 对黄金用例做「保义改写」，期望原样沿用（蜕变测试）。

同一个问题换一种说法，正确的工具、参数、拒答与否都不该变——这是不需要人写
期望就能成立的测试预言。改写只动最后一条用户消息，历史与 options 保持不变。
四种风格对准真实用户输入里最常见、也最容易让 agent 走偏的情形：

- colloquial：口语、省略、聊天腔
- asr：语音输入转写，同音错别字、无标点
- verbose：先扯一段无关背景再提问
- indirect：不用原句关键词的间接问法

生成只在离线阶段联网（复用 .env.judge 的 OpenAI 兼容接口），产物是普通 YAML，
提交进仓库；之后录制一次、永远回放。生成用例失败时，先人工确认改写确实保义，
再算作被测对象缺陷（`note` 里写明了基准用例）。

    python -m agentlens generate cases/onegzus/ --out cases/generated/
"""

from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from typing import Any

from .cases import Case
from .judge.llm import JudgeConfig

STYLES: dict[str, str] = {
    "colloquial": "口语化、随意，像在微信里跟朋友说话，可以省略主语、加语气词",
    "asr": "像语音输入法转写出来的：没有标点，夹一两处同音错别字，但关键信息仍可辨认",
    "verbose": "先说一两句与问题无关的背景或闲聊，再把问题问出来",
    "indirect": "换一种间接问法，尽量不用原句里的关键词，但问的是同一件事",
}
PROMPT_VERSION = "rewrite-v1"
TIMEOUT_S = 60

SYSTEM = (
    "你在为一个校园助手智能体生成测试输入。给你一句学生的原始提问，按指定风格各改写一句。"
    "硬性要求：意思必须完全不变——查询对象、时间指代（如上学期、下周三、一月）、课程名、数字、"
    "以及「查自己还是查别人」都不能增删或改变；不要补充原句没有的信息，不要回答问题。"
    "只输出 JSON：{\"rewrites\": {\"<风格名>\": \"<改写>\"}}"
)


def _ask(config: JudgeConfig, text: str, history: list[dict[str, str]]) -> dict[str, str] | None:
    context = "".join(f"{m['role']}：{m['content']}\n" for m in history)
    user = (
        (f"【对话上文，仅供理解指代，不要改写】\n{context}\n" if context else "")
        + f"【原始提问】{text}\n\n【风格】\n"
        + "\n".join(f"- {k}：{v}" for k, v in STYLES.items())
    )
    body = json.dumps({
        "model": config.model,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
        "temperature": 0.7,
        "response_format": {"type": "json_object"},
    }).encode("utf-8")
    req = urllib.request.Request(
        f"{config.base_url}/chat/completions",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {config.api_key}"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        rewrites = json.loads(payload["choices"][0]["message"]["content"])["rewrites"]
    except (urllib.error.URLError, TimeoutError, KeyError, ValueError, TypeError, json.JSONDecodeError):
        return None
    return {k: v.strip() for k, v in rewrites.items() if k in STYLES and isinstance(v, str)}


def reject_reason(original: str, rewrite: str) -> str | None:
    """确定性的保义门槛：挡掉明显丢信息的改写，其余靠失败样本的人工复核兜底。"""
    if not rewrite:
        return "空改写"
    if rewrite == original:
        return "与原句相同"
    if len(rewrite) > max(200, len(original) * 6):
        return "过长"
    # 原句里的数字（学年、周次、分数）必须原样保留；asr 风格也不允许改数字
    lost = [d for d in re.findall(r"\d+", original) if d not in rewrite]
    if lost:
        return f"丢了数字 {lost}"
    return None


def generate(case: Case, config: JudgeConfig) -> tuple[list[dict[str, Any]], list[str]]:
    """返回 (新用例 dict 列表, 被拒原因列表)。"""
    messages = [m.model_dump() for m in case.input.messages]
    original = messages[-1]["content"]
    rewrites = _ask(config, original, messages[:-1])
    if rewrites is None:
        return [], [f"{case.id}: 生成接口无有效返回"]

    docs, rejected = [], []
    base = case.model_dump(mode="json", by_alias=True, exclude_none=True, exclude_defaults=True)
    for style, text in rewrites.items():
        why = reject_reason(original, text)
        if why:
            rejected.append(f"{case.id}/{style}: {why}（{text[:40]}）")
            continue
        doc = json.loads(json.dumps(base))
        doc["input"]["messages"][-1]["content"] = text
        doc.update(
            id=f"{case.id}__gen_{style}",
            title=f"[改写·{style}] {case.title}".strip(),
            source="llm",
            tags=[*case.tags, "generated", f"gen:{style}"],
            note=(
                f"由 {case.id} 经 LLM 保义改写（{style}，{config.model}，{PROMPT_VERSION}），期望沿用基准。"
                f"原句：{original}"
            ),
        )
        docs.append(doc)
    return docs, rejected
