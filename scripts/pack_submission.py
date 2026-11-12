"""组装比赛提交包：dist/AgentLens-提交包/ + 同名 .zip。

全程离线：各用例集按录制回放、LLM 裁判只读缓存，结果现跑现装，不复用 results/ 里的旧运行。
被测智能体只打包回放所需的最小子集（agent 核心 + 演示数据 + 数据模型），不含真实教务系统的接入代码。

    .venv/bin/python scripts/pack_submission.py [--gzus-dir ../GZUS-PRO-agent]
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

from markdown_it import MarkdownIt

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
NAME = "AgentLens-提交包"

# 用例集 → 期望（通过, 失败）；与 07-复现指南.md 的表一致，对不上就中止，不打包一份和文档矛盾的结果
SUITES = {
    "onegzus": (56, 13),
    "generated": (201, 71),
    "faults": (8, 5),
    "calibration": None,  # 校准集看检出率 / 归因准确率，不看通过数
    "library": (9, 2),    # 接入示例（馆藏助手），adapter 不同
}
ADAPTER_OF = {"library": "library"}

GZUS_FILES = [
    "services/api/pyproject.toml",
    "services/api/app/__init__.py",
    "services/api/app/agent/",
    "services/api/app/academic_period.py",
    "services/api/app/demo_data.py",
    "services/api/app/notice_utils.py",
    "services/api/app/schemas.py",
    "services/api/app/schedule_adjustment_models.py",
    "services/api/app/schedule_adjustment_batch_models.py",
    "services/api/tests/test_agent_core.py",
]

CASE_DOCS = ["用例扩充-2026-11-08.md", "用例生成与缺陷-2026-11-07.md", "故障注入校准-2026-11-07.md"]

PDF_CSS = """
@page { size: A4; margin: 18mm 16mm; }
body { font: 10.5pt/1.65 "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; color: #1d2421; }
h1 { font-size: 20pt; color: #1c6145; margin: 0 0 8pt; }
h2 { font-size: 14.5pt; color: #1c6145; border-bottom: 1.5px solid #cfe0d6; padding-bottom: 3pt; margin-top: 20pt; break-after: avoid; }
h3 { font-size: 12pt; margin-top: 14pt; break-after: avoid; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0; font-size: 9.5pt; break-inside: avoid; }
th, td { border: 1px solid #d5ddd8; padding: 3pt 6pt; text-align: left; vertical-align: top; }
th { background: #eef4f0; }
code { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 8.8pt; background: #f2f4f3; padding: 0 2pt; border-radius: 2pt; }
pre { background: #f5f7f6; border: 1px solid #e1e6e3; padding: 6pt 8pt; border-radius: 4pt; white-space: pre-wrap; break-inside: avoid; }
pre code { background: none; padding: 0; }
blockquote { margin: 6pt 0; padding: 2pt 10pt; border-left: 3px solid #9cc5ae; color: #47534d; }
img { max-width: 100%; border: 1px solid #e1e6e3; border-radius: 4pt; break-inside: avoid; }
hr { border: none; border-top: 1px solid #e1e6e3; }
"""


def sh(cmd: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, check=True, text=True, **kw)


def run_suite(suite: str) -> Path:
    """回放跑一个用例集，返回新建的 results/<run_id>/。"""
    before = set((ROOT / "results").iterdir()) if (ROOT / "results").exists() else set()
    env = {**os.environ, "AGENTLENS_RECORD": "0"}
    proc = sh([sys.executable, "-m", "agentlens", "run", f"cases/{suite}/", "--adapter", ADAPTER_OF.get(suite, "onegzus"),
               "--llm-judge", "--html"], cwd=ROOT, env=env, capture_output=True)
    new = sorted(set((ROOT / "results").iterdir()) - before)
    if len(new) != 1:
        sys.exit(f"{suite}: 期望新建 1 个运行目录，实际 {len(new)}\n{proc.stdout[-2000:]}")
    run_dir = new[0]
    summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
    want = SUITES[suite]
    if want is not None:
        got = (summary["metrics"]["pass"], summary["metrics"]["fail"])
        if got != want:
            sys.exit(f"{suite}: 结果 {got} 与复现指南 {want} 不一致，不打包")
    if suite == "calibration" and "158/159" not in proc.stdout:
        sys.exit(f"calibration: 归因准确率不是 158/159\n{proc.stdout[-2000:]}")
    print(f"  {suite:<12} {run_dir.name}")
    return run_dir


def _softbreak(self, tokens, idx, options, env) -> str:
    """中文段落的源码折行不该变成空格；两侧都是西文字符时才保留。"""
    prev = tokens[idx - 1].content[-1:] if idx > 0 else ""
    nxt = tokens[idx + 1].content[:1] if idx + 1 < len(tokens) else ""
    return " " if prev.isascii() and nxt.isascii() and prev.strip() and nxt.strip() else ""


def md_to_pdf(md_file: Path, pdf: Path) -> None:
    md = MarkdownIt("commonmark").enable("table")
    md.add_render_rule("softbreak", _softbreak)
    html_body = md.render(md_file.read_text(encoding="utf-8"))
    html = (f'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
            f'<base href="{md_file.parent.as_uri()}/"><style>{PDF_CSS}</style></head><body>{html_body}</body></html>')
    tmp = DIST / "_intro.html"
    tmp.write_text(html, encoding="utf-8")
    chrome = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    sh([chrome, "--headless", "--disable-gpu", "--no-pdf-header-footer", "--allow-file-access-from-files",
        f"--print-to-pdf={pdf}", tmp.as_uri()], capture_output=True)
    tmp.unlink()
    if not pdf.exists() or pdf.stat().st_size < 50_000:
        sys.exit(f"PDF 生成失败：{pdf}")


def git_archive(repo: Path, ref: str, dest: Path, paths: list[str] | None = None) -> None:
    dest.mkdir(parents=True)
    archive = subprocess.run(["git", "-C", str(repo), "archive", ref, *(paths or [])],
                             check=True, capture_output=True)
    subprocess.run(["tar", "-x", "-C", str(dest)], input=archive.stdout, check=True)


def check_public(pkg: Path) -> None:
    """公开材料红线：不能带 .env、本地裁判缓存、真实账号的线上对话。"""
    bad = [p for p in pkg.rglob("*") if p.name.startswith(".env") or "judgements/local" in p.as_posix()]
    for traces in pkg.rglob("traces.jsonl"):
        if re.search(r'"account":\s*"real"', traces.read_text(encoding="utf-8")):
            bad.append(traces)
    if bad:
        sys.exit("提交包里有不该公开的文件：\n" + "\n".join(map(str, bad)))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gzus-dir", type=Path, default=Path(os.environ.get("ONEGZUS_DIR", ROOT.parent / "GZUS-PRO-agent")))
    ap.add_argument("--gzus-ref", default="feat/agent")
    args = ap.parse_args()

    if subprocess.run(["git", "-C", str(ROOT), "status", "--porcelain"], capture_output=True, text=True).stdout.strip():
        sys.exit("AgentLens 工作区有未提交改动：提交包的源码取自 HEAD，先提交再打包")

    pkg = DIST / NAME
    shutil.rmtree(pkg, ignore_errors=True)
    pkg.mkdir(parents=True)

    print("回放各用例集…")
    runs = {suite: run_suite(suite) for suite in SUITES}

    print("组装目录…")
    sub = ROOT / "docs" / "提交包"
    shutil.copy(sub / "00-先看这个.md", pkg)
    shutil.copy(sub / "07-复现指南.md", pkg)
    md_to_pdf(ROOT / "docs" / "作品介绍文档.md", pkg / "01-作品介绍文档.pdf")

    (pkg / "02-缺陷清单").mkdir()
    shutil.copy(ROOT / "docs" / "缺陷清单.md", pkg / "02-缺陷清单")

    cases = pkg / "03-测试用例"
    for suite in SUITES:
        shutil.copytree(ROOT / "cases" / suite, cases / suite)
    for doc in CASE_DOCS:
        shutil.copy(ROOT / "docs" / doc, cases)

    for suite, run_dir in runs.items():
        rec = pkg / "04-执行记录" / f"{suite}-{run_dir.name}"
        rec.mkdir(parents=True)
        for f in ("traces.jsonl", "summary.json"):
            shutil.copy(run_dir / f, rec)
        if (run_dir / "report.html").exists():
            (pkg / "05-报告").mkdir(exist_ok=True)
            shutil.copy(run_dir / "report.html", pkg / "05-报告" / f"{suite}-report.html")

    head = subprocess.run(["git", "-C", str(ROOT), "rev-parse", "--short", "HEAD"],
                          capture_output=True, text=True, check=True).stdout.strip()
    git_archive(ROOT, "HEAD", pkg / "06-源码" / "AgentLens")
    git_archive(args.gzus_dir, args.gzus_ref, pkg / "06-源码" / "GZUS-PRO-agent", GZUS_FILES)
    gzus_head = subprocess.run(["git", "-C", str(args.gzus_dir), "rev-parse", "--short", args.gzus_ref],
                               capture_output=True, text=True, check=True).stdout.strip()
    (pkg / "06-源码" / "版本.txt").write_text(
        f"AgentLens  {head}\nGZUS-PRO-agent  {args.gzus_ref} @ {gzus_head}（只含回放所需子集）\n", encoding="utf-8")

    check_public(pkg)

    zip_path = DIST / f"{NAME}.zip"
    zip_path.unlink(missing_ok=True)
    sh(["zip", "-qr", "-X", zip_path.name, NAME], cwd=DIST)
    print(f"完成：{pkg}\n      {zip_path}（{zip_path.stat().st_size / 1e6:.1f} MB）")


if __name__ == "__main__":
    main()
