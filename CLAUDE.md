# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

项目定位、命令、架构、红线的唯一来源是 `CODEBUDDY.md`（与 CodeBuddy 共用，改规则只改那一份）：

@CODEBUDDY.md

接手前先读 `docs/接手必读.md`；与 `docs/赛题官方原文与评分标准.md` 冲突时以官方原文为准。

## 补充：两个演示入口（CODEBUDDY.md 未列）

```bash
.venv/bin/python demo.py               # 终端一键演示：测链路 → 归因 → 回溯，复用 5 条种子用例
.venv/bin/python web_demo/server.py    # 浏览器控制台 → http://127.0.0.1:8765（仅绑回环地址）
```

两者都只是薄封装，直接 import `runner.run()` / `load_cases()` / `CampusCopilotAdapter`，
不含任何执行、判定、归因逻辑——改管线行为去 `agentlens/` 改，不要在演示层补逻辑。
`web_demo/server.py` 里另有一份维度中文名表 `DIMENSIONS`，`schema.py` 的维度若有变动需同步。

## 注意

- 每次 `run` 都会在 `results/` 下新建一个 `<run_id>/` 目录；只为验证而跑的结果不要提交。
