"""LLM 忠实度裁判（双轨判定的第二轨）。

规则裁判管「有唯一正确答案」的部分（工具序列、参数、拒答）；回答是否忠实于工具
观测——事实有没有出处、计算对不对、空观测有没有被说成确定结论——规则管不了，
交给 LLM 裁判。

可复现性靠缓存而不是靠模型：
- 裁判输入（对话、观测、回答、rubric）连同 prompt 版本做哈希，结论写入
  `judgements/<hash>.json` 并随仓库提交；回放时命中缓存即直接复用，不联网。
- 未命中缓存又没有配置裁判模型时，不判、不算失败，只标记 `judge_degraded`。
- 只用标准库发请求（OpenAI 兼容接口），不新增依赖。

配置：环境变量或仓库根目录 `.env.judge`（已被 .gitignore 忽略）：
    AGENTLENS_JUDGE_API_KEY / AGENTLENS_JUDGE_MODEL / AGENTLENS_JUDGE_BASE_URL
"""

from __future__ import annotations

import hashlib
import json
import os
import http.client
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ..cases import Case
from ..schema import CheckResult, Trace

ROOT = Path(__file__).resolve().parents[2]
CACHE_DIR = ROOT / "judgements"
ENV_FILE = ROOT / ".env.judge"
PROMPT_VERSION = "faithfulness-v2"
TIMEOUT_S = 180

SYSTEM = (
    "你是智能体测试平台 AgentLens 的答案忠实度裁判。你只依据给定的工具观测数据判断助手的"
    "最终回答是否忠实，不使用任何外部知识，也不评价回答的文风。"
)

RULES = """判定规则：
1. 回答中的每个事实（课程、分数、学分、日期、地点、次数、余额等）都必须能在工具观测中找到，或能由观测数据正确推导；
2. 回答中的计算（平均分、加权平均、绩点、合计等）必须逐项复算，算错即为不忠实；
3. 时间上下文以材料中的 today / current_term（当前学年学期）/ week（今天所在教学周）为准，
   不要自行重新推断当前学期；其他日期与周次据此推算，教学周按周一至周日计；
4. 观测为空或报错时，回答不得给出确定性结论；
5. 对观测未覆盖的内容给出的一般性建议（如「建议咨询辅导员」）不算不忠实；
6. 若给了额外评判要求，也必须满足。

只输出一个 JSON 对象：
{"faithful": true 或 false, "score": 1 到 5 的整数（5 为完全忠实）,
 "issues": [{"claim": "回答中有问题的原话", "problem": "问题说明（含正确值）", "span": "对应观测的 span 编号，可空"}]}"""


@dataclass
class JudgeConfig:
    api_key: str
    model: str
    base_url: str

    @classmethod
    def load(cls) -> JudgeConfig | None:
        env = dict(os.environ)
        if ENV_FILE.exists():
            for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
                key, sep, value = line.strip().partition("=")
                if sep and key.startswith("AGENTLENS_JUDGE_") and key not in env:
                    env[key] = value.strip().strip('"').strip("'")
        key, model = env.get("AGENTLENS_JUDGE_API_KEY"), env.get("AGENTLENS_JUDGE_MODEL")
        if not key or not model:
            return None
        base = env.get("AGENTLENS_JUDGE_BASE_URL") or "https://api.openai.com/v1"
        return cls(api_key=key, model=model, base_url=base.rstrip("/"))


def applicable(case: Case, trace: Trace) -> bool:
    """有回答、且有可对照的观测或 rubric 时才判；拒答与未完成的执行不判。"""
    return applicable_to(trace, bool(case.expect.rubric))


def applicable_to(trace: Trace, has_rubric: bool) -> bool:
    """不依赖用例的版本：线上对话没有 rubric，只在有观测可对照时判。"""
    if trace.status != "ok" or trace.refused or not trace.answer.strip():
        return False
    return bool(trace.observations) or has_rubric


def evidence_of(case: Case, trace: Trace) -> dict[str, Any]:
    return evidence_for(trace, [m.model_dump() for m in case.input.messages], case.expect.rubric)


def evidence_for(
    trace: Trace, conversation: list[dict[str, Any]], rubric: str | None,
) -> dict[str, Any]:
    """裁判材料。conversation 为 [{role, content}]：用例取自定义，线上对话取自 trace 记录的输入。"""
    observations = []
    for call in trace.tool_calls:
        obs = trace.observation_of(call)
        observations.append({
            "span": obs.span_id if obs else call.span_id,
            "tool": call.name,
            "args": call.args,
            "ok": obs.ok if obs else None,
            "error": obs.error if obs else "无观测",
            "row_count": obs.row_count if obs else None,
            "data": obs.raw if obs else None,
        })
    return {
        "today": trace.meta.get("today"),
        "current_term": trace.meta.get("current_term"),
        "week": trace.meta.get("week"),
        "conversation": conversation,
        "observations": observations,
        "answer": trace.answer,
        "rubric": rubric,
    }


def cache_key(evidence: dict[str, Any]) -> str:
    blob = json.dumps({"prompt": PROMPT_VERSION, "evidence": evidence}, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:20]


def judge_faithfulness(
    case: Case, trace: Trace, config: JudgeConfig | None,
) -> tuple[CheckResult, int] | None:
    """返回 (llm_faithfulness 检查, 1~5 评分)；无法判定（无缓存且无配置、或调用失败）时返回 None。"""
    return judge_evidence(case.id, evidence_of(case, trace), config)


def judge_evidence(
    case_id: str, evidence: dict[str, Any], config: JudgeConfig | None,
) -> tuple[CheckResult, int] | None:
    """按裁判材料判定（命中缓存即复用）；用例与线上对话共用这一入口。"""
    key = cache_key(evidence)
    path = CACHE_DIR / f"{key}.json"

    if path.exists():
        record = json.loads(path.read_text(encoding="utf-8"))
    elif config is None:
        return None
    else:
        verdict = _ask(config, evidence)
        if verdict is None:
            return None
        record = {
            "prompt_version": PROMPT_VERSION,
            "model": config.model,
            "case_id": case_id,
            "verdict": verdict,
            "evidence": evidence,
        }
        CACHE_DIR.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    v = record["verdict"]
    issues = v.get("issues") or []
    if v["faithful"]:
        reason = f"回答忠实于观测（{record['model']} 评分 {v['score']}/5）"
    else:
        detail = "；".join(f"「{i.get('claim', '')}」{i.get('problem', '')}" for i in issues) or "未给出明细"
        reason = f"回答与观测不符（{record['model']} 评分 {v['score']}/5）：{detail}"
    check = CheckResult(
        check="llm_faithfulness",
        passed=bool(v["faithful"]),
        reason=reason,
        evidence=[i["span"] for i in issues if i.get("span")] + [f"judgement:{key}"],
    )
    return check, int(v["score"])


def _ask(config: JudgeConfig, evidence: dict[str, Any]) -> dict[str, Any] | None:
    user = (
        "【待评判材料】\n"
        + json.dumps(evidence, ensure_ascii=False, indent=2)
        + "\n\n"
        + RULES
    )
    body = json.dumps({
        "model": config.model,
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}],
        "temperature": 0,
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
        verdict = json.loads(payload["choices"][0]["message"]["content"])
        if not isinstance(verdict.get("faithful"), bool) or not 1 <= int(verdict.get("score", 0)) <= 5:
            return None
        return verdict
    # OSError 覆盖 URLError、超时与连接被重置；单条失败只降级，不能中断整批运行
    except (OSError, http.client.HTTPException, KeyError, ValueError, json.JSONDecodeError):
        return None
