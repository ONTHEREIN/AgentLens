"""AgentLens Web Demo：把终端体检报告渲染成浏览器控制台。

只做一层薄 HTTP 封装，执行/判定/归因全部复用 agentlens 现有管线：

    .venv/bin/python web_demo/server.py
    → http://127.0.0.1:8765

零网络依赖、零 LLM 调用，绑本机回环地址。
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from agentlens.adapters.campus_copilot import CampusCopilotAdapter  # noqa: E402
from agentlens.cases import Case, CaseError, load_cases  # noqa: E402
from agentlens.runner import run  # noqa: E402
from agentlens.schema import LAYER_NAMES, SPAN_KINDS  # noqa: E402

WEB_DIR = Path(__file__).resolve().parent / "static"
CASES_DIR = ROOT / "cases"
RESULTS_DIR = ROOT / "results"

DIMENSIONS = [
    ("task_completion", "任务完成"),
    ("tool_use", "工具调用"),
    ("param_filling", "参数填充"),
    ("answer_faithfulness", "答案忠实"),
    ("retrieval_quality", "知识检索"),
    ("safety_guardrail", "安全护栏"),
    ("robustness", "边界与异常"),
]
DIMENSION_LABELS = dict(DIMENSIONS)
SPAN_LABELS = {
    "plan": "规划",
    "tool_call": "工具调用",
    "observation": "工具观测",
    "retrieve": "知识检索",
    "generate": "生成",
    "guardrail": "护栏",
}

RUN_LOCK = threading.Lock()


def case_payload(case: Case) -> dict:
    """浏览器需要的用例视图：原始 YAML 结构 + 两个计算字段。"""
    data = case.model_dump(mode="json")
    data["input_text"] = case.input.text
    data["expected_tools"] = case.expected_tools
    return data


def catalog_payload(cases: list[Case]) -> dict:
    return {
        "app": "AgentLens",
        "tagline": "测链路，不是测答案",
        "adapter": CampusCopilotAdapter.name,
        "model": CampusCopilotAdapter.model,
        "seed": 42,
        "dimensions": [{"id": key, "label": label} for key, label in DIMENSIONS],
        "layers": LAYER_NAMES,
        "span_kinds": list(SPAN_KINDS),
        "span_labels": SPAN_LABELS,
        "cases": [case_payload(c) for c in cases],
    }


def execute_run(cases: list[Case], selected_ids: list[str] | None) -> dict:
    chosen = cases
    if selected_ids:
        wanted = set(selected_ids)
        unknown = wanted - {c.id for c in cases}
        if unknown:
            raise ValueError(f"未知用例：{', '.join(sorted(unknown))}")
        chosen = [c for c in cases if c.id in wanted]

    if not chosen:
        raise ValueError("筛完没有用例：拒绝生成 100% 通过的假报告")

    adapter = CampusCopilotAdapter()
    with RUN_LOCK:
        result = run(chosen, adapter, out_dir=RESULTS_DIR, seed=42)

    return {
        "run_id": result.run_id,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "out_dir": str(result.out_dir),
        "metrics": result.metrics(),
        "cases": [
            {"case": case_payload(case), "trace": trace.dump()}
            for case, trace in result.pairs
        ],
    }


class AgentLensHTTPServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address: tuple[str, int], cases: list[Case]) -> None:
        super().__init__(address, AgentLensHandler)
        self.cases = cases


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

    # -- routes ------------------------------------------------------
    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/health":
            self._send_json({"ok": True})
            return
        if path == "/api/catalog":
            self._send_json(catalog_payload(self.server.cases))
            return
        self._serve_static(path)

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path != "/api/run":
            self._send_error_json("接口不存在", 404)
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self._send_error_json("Content-Length 非法")
            return
        if length > 1_000_000:
            self._send_error_json("请求体过大", 413)
            return

        raw = self.rfile.read(length) if length else b"{}"
        try:
            payload = json.loads(raw.decode("utf-8") or "{}")
        except (UnicodeDecodeError, json.JSONDecodeError):
            self._send_error_json("请求体必须是合法 JSON")
            return

        selected = payload.get("case_ids") or []
        if not isinstance(selected, list) or not all(isinstance(x, str) for x in selected):
            self._send_error_json("case_ids 必须是字符串数组")
            return

        try:
            result = execute_run(self.server.cases, selected)
        except ValueError as exc:
            self._send_error_json(str(exc))
            return
        except Exception as exc:  # 本地演示：把真实错误露出来，便于排障
            self._send_error_json(f"执行失败：{exc}", 500)
            return

        self._send_json({"run": result})


def main() -> int:
    parser = argparse.ArgumentParser(description="AgentLens 网页演示")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    try:
        cases = load_cases(CASES_DIR)
    except CaseError as exc:
        print(f"用例校验失败：{exc}", file=sys.stderr)
        return 2

    try:
        server = AgentLensHTTPServer((args.host, args.port), cases)
    except OSError as exc:
        print(f"端口 {args.port} 启动失败：{exc}", file=sys.stderr)
        return 2

    url = f"http://{args.host}:{args.port}"
    print(f"AgentLens Web Demo → {url}")
    print(f"已载入 {len(cases)} 条用例；Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
