"""软帮手（OneGZUS）真实智能体 —— AgentLens 的主被测对象。

与 CampusCopilot 桩不同，这里的 trace 来自真实 LLM 的真实决策。接入方式见
`docs/GZUS-PRO-agent-接入设计.md`：

- **进程外调用**：通过 subprocess 运行软帮手的 `python -m app.agent.cli`，
  stdin 传用例输入，stdout 收一行 AgentOutput JSON。不 import 软帮手的任何包，
  两边只靠 JSON 契约连接（span 字段由 `Span` 再校验一次）。
- **录制 / 回放**：默认 replay，从 `recordings/onegzus/<case_id>.json` 回放 LLM
  回复，工具照常在软帮手侧执行，全程不联网；`AGENTLENS_RECORD=1` 时调用真实 LLM
  重新录制并覆盖。录制文件随仓库提交，是「结论可复现」的证据。

环境变量：
- `ONEGZUS_API_DIR`：软帮手 `services/api` 目录，默认同级的 `GZUS-PRO-agent/services/api`
- `AGENTLENS_RECORD=1`：录制模式（还需软帮手侧的 `AGENT_LLM_*` 变量）
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

from pydantic import TypeAdapter, ValidationError

from ..cases import Case
from ..schema import Span, TokenUsage
from .base import AgentOutput, BaseAdapter

ROOT = Path(__file__).resolve().parents[2]
RECORDINGS = ROOT / "recordings" / "onegzus"
DEFAULT_API_DIR = ROOT.parent / "GZUS-PRO-agent" / "services" / "api"
TIMEOUT_S = 180

_SPANS = TypeAdapter(list[Span])


class OneGzusAdapter(BaseAdapter):
    name = "onegzus"
    model = "unknown"

    def __init__(self, api_dir: Path | None = None, record: bool | None = None) -> None:
        self.api_dir = api_dir or Path(os.environ.get("ONEGZUS_API_DIR", DEFAULT_API_DIR))
        self.record = os.environ.get("AGENTLENS_RECORD") == "1" if record is None else record

    def invoke(self, case: Case, *, run_id: str) -> AgentOutput:
        payload = {"messages": [m.model_dump() for m in case.input.messages]}
        # today 固定日期；fixtures 是软帮手 FixtureSource 的测试注入点（如藏指令的通知）
        for key in ("today", "fixtures"):
            if key in case.input.options:
                payload[key] = case.input.options[key]

        mode = "record" if self.record else "replay"
        python = self.api_dir / ".venv" / "bin" / "python"
        cmd = [str(python), "-m", "app.agent.cli", "--mode", mode,
               "--replay-file", str(RECORDINGS / f"{case.id}.json")]
        try:
            proc = subprocess.run(
                cmd, input=json.dumps(payload, ensure_ascii=False), capture_output=True,
                text=True, cwd=self.api_dir, env={**os.environ, "PYTHONPATH": str(self.api_dir)},
                timeout=TIMEOUT_S,
            )
        except FileNotFoundError:
            return _blocked(f"找不到软帮手环境：{python}（设置 ONEGZUS_API_DIR）")
        except subprocess.TimeoutExpired:
            return AgentOutput(status="timeout", meta={"error": f"超过 {TIMEOUT_S}s 未返回"})

        if proc.returncode == 2:
            # 输入或录制文件的问题（没录、用例改过）：不是被测对象的缺陷，跳过而非判失败
            return _blocked(proc.stderr.strip())
        if proc.returncode != 0:
            return AgentOutput(status="error", meta={"error": "agent 进程异常退出",
                                                     "stderr": proc.stderr.strip()[-2000:]})

        try:
            raw = json.loads(proc.stdout.strip().splitlines()[-1])
            spans = _SPANS.validate_python(raw.get("spans", []))
        except (json.JSONDecodeError, IndexError, ValidationError) as exc:
            # 契约漂移：软帮手吐出的 trace 不符合 schema，记 error，不入统计
            return AgentOutput(status="error", meta={"error": f"trace 不符合 schema：{exc}"})

        self.model = raw.get("meta", {}).get("model", self.model)
        return AgentOutput(
            status=raw.get("status", "ok"),
            answer=raw.get("answer", ""),
            spans=spans,
            tokens=TokenUsage(**raw.get("tokens", {})),
            latency_ms=raw.get("latency_ms", 0.0),
            meta=raw.get("meta", {}),
        )


def _blocked(reason: str) -> AgentOutput:
    return AgentOutput(status="blocked", meta={"error": reason})
