# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

项目定位、命令、架构、红线的唯一来源是 `CODEBUDDY.md`（与 CodeBuddy 共用，改规则只改那一份）：

@CODEBUDDY.md

接手前先读 `docs/接手必读.md`；与 `docs/赛题官方原文与评分标准.md` 冲突时以官方原文为准。

## 补充：审计台与终端演示（CODEBUDDY.md 未列）

```bash
.venv/bin/python web_demo/server.py    # 审计台 → http://127.0.0.1:8765（仅绑回环地址）
.venv/bin/python demo.py               # 终端一键演示：测链路 → 归因 → 回溯，复用 5 条种子用例
```

审计台是产品主界面，左侧导航五页：最新审计（各用例集最近一次运行 + 待办）/ 线上对话（按会话聚合）/
审计结果（运行列表、单次运行、运行对比）/ 待人工复核（跨运行的复核队列）/ 复核一致性（κ）。
- 统计逻辑全部在 `agentlens/audit.py`（`overview` / `conversations` / `review_queue` 等），
  `web_demo/server.py` 只做 HTTP 封装，不要在页面层补逻辑。
- 复核队列：每条用例只看最近一次运行；注入样本（`case.inject`）不进队列；入队原因见 `audit.QUEUE_REASONS`。
  复核工作台按基准用例把改写归组（`audit.family_of`），先定「复核结论」（`audit.DISPOSITIONS`：智能体缺陷 / 用例过严 /
  裁判误判 / 用例无效 / 拿不准），再由它推出总判定、归因层、LLM 忠实度三项标注；「复核结论」不进 κ。
  同组批量沿用的标注带 `batch_of`，`audit.agreement` 计算 κ 时剔除。试用复核流程用 `server.py --labels <临时文件>`，
  别往 `reviews/labels.jsonl` 写测试数据。
- 线上对话：直接读软帮手聊天页的 trace 日志（`ONEGZUS_TRACE_DIR`，默认同级 `GZUS-PRO-agent/services/api/data/traces`），
  每天一个 `chat-<日期>` 运行；没有预设期望，只判执行状态 + LLM 忠实度，列表只读裁判缓存、打开详情才联网判定。
- 软帮手对真实账号开放后，线上对话里 `meta.account == "real"` 的轮次含本人真实数据：
  裁判缓存写 `judgements/local/`（已 gitignore），这类 trace 与缓存只留本地，不得提交、截图外传或写进材料。
- 只读 `results/` 与 `reviews/labels.jsonl`。人工标注按 trace 内容指纹（不含计时字段）记账，回放复跑自动沿用；
  `reviews/` 是标注集（M2 的 Kappa 数据），要提交，不要当运行产物清理。
- 页面发起的运行：`onegzus` 固定 `record=False`，永远不从页面调用被测模型。
- 维度 / span 的中文名表在 `agentlens/audit.py`（`DIMENSION_LABELS`，审计台与 HTML 报告共用），`schema.py` 的维度若有变动需同步；导入时有断言兜底。

## 注意

- 每次 `run` 都会在 `results/` 下新建一个 `<run_id>/` 目录；只为验证而跑的结果不要提交。
