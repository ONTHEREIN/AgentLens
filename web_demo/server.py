"""AgentLens 审计台：记录并可视化智能体的思考—行动链路，辅助缺陷定位与人工复核。

只做一层薄 HTTP 封装：执行/判定/归因复用 agentlens 管线，数据统计在 agentlens.audit，
页面上的数字全部从 results/ 与 reviews/ 现算。

    .venv/bin/python web_demo/server.py
    → http://127.0.0.1:8765

绑本机回环地址。页面发起的运行一律走回放（不调用被测模型）；LLM 裁判优先命中
judgements/ 缓存，未命中且配置了 .env.judge 时才联网。线上对话日志位置见 ONEGZUS_TRACE_DIR。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agentlens import audit  # noqa: E402
from agentlens.adapters.base import BaseAdapter  # noqa: E402
from agentlens.adapters.campus_copilot import CampusCopilotAdapter  # noqa: E402
from agentlens.adapters.onegzus import OneGzusAdapter  # noqa: E402
from agentlens.cases import Case, CaseError, load_cases  # noqa: E402
from agentlens.judge.llm import JudgeConfig  # noqa: E402
from agentlens.runner import run  # noqa: E402
from agentlens.schema import LAYER_NAMES, SPAN_KINDS  # noqa: E402

WEB_DIR = Path(__file__).resolve().parent / "static"
RESULTS_DIR = ROOT / "results"
LABELS_FILE = ROOT / "reviews" / "labels.jsonl"
# 软帮手线上对话日志（聊天页每轮一行），审计台按天读成 chat-<日期> 运行
CHAT_DIR = Path(os.environ.get(
    "ONEGZUS_TRACE_DIR", ROOT.parent / "GZUS-PRO-agent" / "services" / "api" / "data" / "traces",
))
RUN_ID = re.compile(r"^[0-9A-Za-z_-]{1,64}$")

DIMENSIONS = [
    ("functional_accuracy", "功能准确性"),
    ("tool_use", "工具调用"),
    ("rag_retrieval", "RAG 检索质量"),
    ("multi_turn", "多轮对话"),
    ("adversarial_safety", "对抗性与安全"),
    ("boundary_exception", "边界与异常"),
    ("performance", "性能"),
]
SPAN_LABELS = {
    "plan": "规划",
    "tool_call": "工具调用",
    "observation": "工具观测",
    "retrieve": "知识检索",
    "generate": "生成",
    "guardrail": "护栏",
}

# 用例集：目录 + 被测对象。onegzus 在页面上只回放，绝不重新录制（录制会调用真实模型）
SUITES: dict[str, dict] = {
    "onegzus": {
        "label": "软帮手智能体（真实录制）",
        "dir": ROOT / "cases" / "onegzus",
        "adapter": lambda: OneGzusAdapter(record=False),
    },
    "faults": {
        "label": "软帮手 · 数据面故障注入",
        "dir": ROOT / "cases" / "faults",
        "adapter": lambda: OneGzusAdapter(record=False),
    },
    "calibration": {
        "label": "归因校准 · 录制变异（只回放）",
        "dir": ROOT / "cases" / "calibration",
        "adapter": lambda: OneGzusAdapter(record=False),
    },
    "seed": {
        "label": "CampusCopilot 桩对象（种子用例）",
        "dir": ROOT / "cases",
        "adapter": CampusCopilotAdapter,
    },
}

RUN_LOCK = threading.Lock()


def catalog_payload(suites: dict[str, list[Case]]) -> dict:
    return {
        "app": "AgentLens 审计台",
        "dimensions": [{"id": key, "label": label} for key, label in DIMENSIONS],
        "layers": LAYER_NAMES,
        "span_kinds": list(SPAN_KINDS),
        "span_labels": SPAN_LABELS,
        "review_targets": audit.REVIEW_TARGETS,
        "judge_configured": JudgeConfig.load() is not None,
        "suites": [
            {"id": sid, "label": SUITES[sid]["label"], "cases": len(cases)}
            for sid, cases in suites.items()
        ],
    }


def execute_run(suite_cases: list[Case], adapter: BaseAdapter, selected: list[str], llm_judge: bool) -> dict:
    chosen = suite_cases
    if selected:
        wanted = set(selected)
        unknown = wanted - {c.id for c in suite_cases}
        if unknown:
            raise ValueError(f"未知用例：{', '.join(sorted(unknown))}")
        chosen = [c for c in suite_cases if c.id in wanted]
    if not chosen:
        raise ValueError("筛完没有用例：拒绝生成 100% 通过的假报告")
    with RUN_LOCK:
        result = run(chosen, adapter, out_dir=RESULTS_DIR, seed=42, llm_judge=llm_judge)
    return {"run_id": result.run_id}


class AgentLensHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], suites: dict[str, list[Case]]) -> None:
        super().__init__(address, AgentLensHandler)
        self.suites = suites
        self.case_index = {c.id: c for cases in suites.values() for c in cases}


class AgentLensHandler(BaseHTTPRequestHandler):
    server: AgentLensHTTPServer

    def log_message(self, fmt: str, *args) -> None:  # 保持终端干净
        return

    # -- helpers -----------------------------------------------------
    def _send_json(self, payload: dict, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _send_error_json(self, message: str, status: int = 400) -> None:
        self._send_json({"error": message}, status=status)

    def _serve_static(self, path: str) -> None:
        rel = path.lstrip("/") or "index.html"
        target = (WEB_DIR / rel).resolve()
        if WEB_DIR.resolve() not in target.parents and target != WEB_DIR.resolve():
            self._send_error_json("非法路径", 403)
            return
        if not target.is_file():
            self._send_error_json("文件不存在", 404)
            return

        body = target.read_bytes()
        mime, _ = mimetypes.guess_type(target.name)
        self.send_response(200)
        self.send_header("Content-Type", f"{mime or 'application/octet-stream'}; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _run_dir(self, run_id: str) -> Path | None:
        if not RUN_ID.match(run_id):
            return None
        target = RESULTS_DIR / run_id
        return target if (target / "traces.jsonl").is_file() else None

    def _detail(self, run_id: str) -> dict | None:
        """用例运行读 results/；chat-<日期> 读线上对话日志并即时判定（裁判命中缓存则不联网）。"""
        if not RUN_ID.match(run_id):
            return None
        chat = audit.chat_file(CHAT_DIR, run_id)
        if chat is not None:
            return audit.chat_detail(chat, JudgeConfig.load())
        run_dir = self._run_dir(run_id)
        return None if run_dir is None else audit.run_detail(run_dir, self.server.case_index)

    def _read_json_body(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_error_json("Content-Length 非法")
            return None
        if length > 1_000_000:
            self._send_error_json("请求体过大", 413)
            return None
        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_error_json("请求体必须是合法 JSON")
            return None
        if not isinstance(payload, dict):
            self._send_error_json("请求体必须是 JSON 对象")
            return None
        return payload

    # -- routes ------------------------------------------------------
    def do_GET(self) -> None:
        url = urlparse(self.path)
        path = url.path
        if path == "/api/health":
            self._send_json({"ok": True})
        elif path == "/api/catalog":
            self._send_json(catalog_payload(self.server.suites))
        elif path == "/api/runs":
            self._send_json({"runs": audit.list_runs(RESULTS_DIR, CHAT_DIR)})
        elif path.startswith("/api/runs/"):
            detail = self._detail(path.removeprefix("/api/runs/"))
            if detail is None:
                self._send_error_json("运行不存在", 404)
                return
            detail["labels"] = {
                f"{key}|{target}": label
                for (key, target), label in audit.latest_labels(audit.load_labels(LABELS_FILE)).items()
            }
            self._send_json(detail)
        elif path == "/api/compare":
            query = parse_qs(url.query)
            details = [self._detail((query.get(k) or [""])[0]) for k in ("a", "b")]
            if None in details:
                self._send_error_json("对比需要两个存在的运行：?a=<run_id>&b=<run_id>", 404)
                return
            self._send_json(audit.compare_runs(*details))
        elif path == "/api/reviews":
            self._send_json(audit.agreement(audit.load_labels(LABELS_FILE)))
        else:
            self._serve_static(path)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path not in ("/api/run", "/api/reviews"):
            self._send_error_json("接口不存在", 404)
            return
        payload = self._read_json_body()
        if payload is None:
            return

        if path == "/api/reviews":
            try:
                record = audit.add_label(LABELS_FILE, payload)
            except ValueError as exc:
                self._send_error_json(str(exc))
                return
            self._send_json({"label": record})
            return

        suite = payload.get("suite", "onegzus")
        if suite not in self.server.suites:
            self._send_error_json(f"未知用例集：{suite}")
            return
        selected = payload.get("case_ids") or []
        if not isinstance(selected, list) or not all(isinstance(x, str) for x in selected):
            self._send_error_json("case_ids 必须是字符串数组")
            return
        try:
            result = execute_run(
                self.server.suites[suite], SUITES[suite]["adapter"](), selected,
                llm_judge=bool(payload.get("llm_judge", True)),
            )
        except ValueError as exc:
            self._send_error_json(str(exc))
            return
        except Exception as exc:  # 本地工具：把真实错误露出来，便于排障
            self._send_error_json(f"执行失败：{exc}", 500)
            return
        self._send_json(result)


def main() -> int:
    parser = argparse.ArgumentParser(description="AgentLens 审计台")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    try:
        suites = {sid: load_cases(spec["dir"]) for sid, spec in SUITES.items()}
    except CaseError as exc:
        print(f"用例校验失败：{exc}", file=sys.stderr)
        return 2

    try:
        server = AgentLensHTTPServer((args.host, args.port), suites)
    except OSError as exc:
        print(f"端口 {args.port} 启动失败：{exc}", file=sys.stderr)
        return 2

    url = f"http://{args.host}:{args.port}"
    print(f"AgentLens 审计台 → {url}")
    print("已载入用例：" + "，".join(f"{sid} {len(c)} 条" for sid, c in suites.items()) + "；Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
