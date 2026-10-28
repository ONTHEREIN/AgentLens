# AgentLens · 智能体体检中心

> 不只告诉你哪里疼，还告诉你疼在哪个器官。

**AgentLens 是一个给 AI 智能体做「分层归因体检」的测试平台。**
传统测试只能给 pass/fail；智能体的失败可能来自意图解析、任务规划、工具选型、参数填充、
结果解读、知识召回中的任意一环 —— 不定位到环节，修复就只能靠猜。

AgentLens 把每一步执行录成可回溯的 trace，用规则裁判 + LLM 裁判双重判定，
再把每条失败样本**自动归因到五层之一**，产出「维度 × 根因」缺陷热力图。

> 当前状态：**M0 完成**（10/25）。一条用例可跑通并打印完整 trace，五层归因链路已闭合。
> 详见 [`docs/M0-验收记录.md`](docs/M0-验收记录.md)。

---

## 快速开始

```bash
# 依赖：Python 3.11+ / pydantic v2 / pyyaml / rich
pip install -r requirements.txt

python -m agentlens validate cases/        # 只校验用例（fail fast，报行号）
python -m agentlens run cases/ --trace     # 批量跑 + 打印每条完整 span 链路
python -m agentlens schema                 # 导出 trace JSON Schema -> docs/
python -m agentlens show <run_id>          # 回看某次运行
```

常用参数：

| 参数 | 用途 |
|---|---|
| `--filter tag:smoke` / `dimension:tool_use` / `id:schedule_*` | 按标签/维度/id 筛选用例（可叠加） |
| `--repeat N` | 同用例重跑 N 次，看判定是否稳定（G4 复现一致率） |
| `--strict` | 有失败即非零退出码，给 CI 门禁用 |
| `--adapter` | 切换被测对象（目前 `campus_copilot`） |

零外部依赖、零网络调用、零 LLM 调用 —— 演示不押在网络和额度上。

### 演示入口

```bash
.venv/bin/python demo.py                 # 终端版：四幕演示执行 → 归因 → 回溯
.venv/bin/python web_demo/server.py      # 网页版：打开 http://127.0.0.1:8765
```

网页版把 5 条种子用例渲染成可交互的体检控制台：总览分数、病例清单、span 时间线、
规则裁判与归因证据都在同一页。前端零构建、零 CDN，仍由现有 `run()` 管线产出结果。

---

## 为什么是「测链路」而不是「测答案」

```
判定层   pass / fail                      ← 人人都能做
归因层   L1 意图规划 · L2 工具选型 · L3 参数填充
         L4 结果解读 · L5 知识检索 · L6 护栏误伤   ← 我们的独占价值
```

归因能不能做，取决于 trace 里有没有足够的信息。所以 **trace schema 是产品地基，不可裁剪**：

| span | 独立断言什么 | 对应层 |
|---|---|---|
| `plan` | 意图对不对、计划了哪几步 | L1 |
| `tool_call` | 选了哪个工具、参数填了什么、schema 是否通过 | L2 / L3 |
| `observation` | 工具本身是成功、空返回还是报错 | L0 / L5 |
| `retrieve` | 召回了哪些 chunk、分数多少 | L5 |
| `generate` | 答案引用了哪些证据 | L4 |
| `guardrail` | 该拒的拒了吗、不该拒的误拒了吗 | L6 |

**没有分 span，归因就只能靠 LLM 猜；靠猜的归因不可信。**

L6 单列的原因：「该拒的拒了」和「不该拒的也拒了」是两个方向的问题，混在一起统计会互相抵消。

---

## 目录

```
agentlens/
├── agentlens/
│   ├── schema.py          # trace schema（产品地基，pydantic 强校验、拒绝未知字段）
│   ├── cases.py           # 声明式用例加载 + fail-fast（报文件+行号）
│   ├── runner.py          # 批量执行，落盘 results/<run_id>/
│   ├── judge/rules.py     # 规则裁判（工具序列 / 参数约束 / 拒答 / 关键词）
│   ├── attribute.py       # 五层归因决策树 v0（未校准，接口已稳定）
│   ├── render.py          # 终端 trace 树 / 判定表 / 归因面板
│   ├── cli.py             # validate / run / show / schema
│   ├── tools.py           # 5 个工具打桩在构造数据上（M3 故障注入挂载点）
│   └── adapters/
│       ├── base.py        # Adapter 契约：invoke(case) -> AgentOutput
│       └── campus_copilot.py  # 参考被测对象（确定性，刻意保留 3 类缺陷）
├── cases/                 # YAML 用例（声明式，非开发同学也能提交）
├── fixtures/campus.json   # 构造/脱敏数据（禁止替换为真实数据）
├── results/<run_id>/      # traces.jsonl（唯一真相源）+ summary.json
├── web_demo/              # 网页演示（本地 HTTP + 原生前端，复用 run() 管线）
└── docs/trace.schema.json # 导出的 JSON Schema
```

---

## 五层归因的判定顺序

按「越靠前越优先」判定，避免多个错误同时存在时归错层：

```
0. L0  超时 / 异常 / 不可达          —— 不是 Agent 的错，是环境的
6. L6  护栏误伤（提前判）            —— 否则会被「没调工具」误判成 L2
1. L1  plan 缺失，或计划与实际脱节
2. L2  期望的首个工具 != 实际首个工具
3. L3  工具对但参数 / schema 不符
4. L4  工具返回正常，答案却与观测矛盾
5. L5  答案忠实于观测，但观测 / 召回本身错
   -   都不匹配 → 未定层，进人工复核（不硬凑）
```

---

## 被测对象：CampusCopilot（参考实现，不是主角）

它存在的意义是证明「这套方法在真实业务 Agent 上跑得通」。
v0 是确定性实现，**刻意保留三类缺陷**作为归因演示素材（不许修）：

| 缺陷 | 制造什么样本 |
|---|---|
| 单步规划，不会串联「查课表 + 查规章」 | L1 规划缺失 |
| 关键词首命中，`课` 排在 `成绩` 之前 | L2 工具选型（课表/成绩歧义） |
| 护栏用敏感词表，`挂科` 直接拒答 | L6 护栏误伤 |

接一个新 Agent 只需要实现 `adapters/base.py` 的 `invoke()`（G5：≤2 人时）。

---

## 合规红线

- 数据一律构造/脱敏，**公开材料不得出现真实学号、姓名、成绩**（`fixtures/` 里全是虚构数据）
- 不对学校真实系统做高频请求，用录制样本回放
- 不做自动修复：只给定位与证据，**修复前后的分数差值**才是成果
- 所有自动判定必须标注方法与适用范围，不包装成人工结论

---

## 里程碑

| 阶段 | 时间 | 状态 |
|---|---|---|
| M0 立地基 | 10/24–10/26 | ✅ repo 骨架 · trace schema · 一条用例跑通 |
| M1 骨架通 | 10/27–10/31 | ⏳ 50 条用例批量跑通，规则裁判出结论 |
| M2 能归因 | 11/1–11/4 | ⏳ LLM 裁判 + 100 条人工标注，归因准确率出数 |
| M3 有火力 | 11/5–11/8 | ⏳ 用例 300 条，自动生成 ≥60% |
| M4 能交付 | 11/9–11/11 | ⏳ HTML 报告 · compare · gate |
| M5 材料化 | 11/12–11/14 | ⏳ 7 项文档 + 视频 |
| M6 封板 | 11/15–11/17 | ⏳ 复跑校验，**11/17 提前提交** |
