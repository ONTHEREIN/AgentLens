# CODEBUDDY.md

This file provides guidance to CodeBuddy Code when working with code in this repository.

## What this project is

AgentLens 是一个给 AI 智能体做「分层归因体检」的测试平台：把一次执行录成分 span 的 trace，
对每个 span 下独立断言，再把失败样本归因到 L0–L6 中的某一层。
**产品主张：测链路，不是测答案。** 判定（pass/fail）只是入场券，归因才是价值所在。

赛道：2026 第九届传智杯 · AI赋能·智能测试创新挑战赛，走**路径二（测试工具/平台）**。
所有判断的底本是 `docs/赛题官方原文与评分标准.md`；本文档与之冲突时以官方原文为准。

接手前先读 `docs/接手必读.md`（30 秒版定位 + 五个已定死决策 + 十条不要做）。

## Commands

```bash
source .venv/bin/activate            # venv 内是 Python 3.10，已装 pydantic v2 / pyyaml / rich
# 等价写法：.venv/bin/python -m agentlens ...

python -m agentlens validate cases/           # 只校验用例，不执行；非法文件报 file:line
python -m agentlens run cases/                # 批量跑，落盘 results/<run_id>/
python -m agentlens run cases/ --trace        # 额外打印每条完整 span 树 + 判定表 + 归因面板
python -m agentlens run cases/ --repeat 3     # 同用例重跑，看判定稳定性（G4）
python -m agentlens run cases/ --strict       # 有 fail 则退出码 1（CI 门禁语义）
python -m agentlens run cases/ --filter tag:smoke --filter dimension:tool_use
python -m agentlens show <run_id>             # 回看某次运行（run_id 或目录路径）
python -m agentlens show <run_id> --case interpret_001   # 打印单条 trace 的完整 JSON
python -m agentlens schema                    # 重新导出 docs/trace.schema.json
```

**仓库里没有 pytest / ruff / mypy，不要假设存在测试框架或 lint 步骤。**
「跑单条用例」= 直接传单个 YAML 路径，或按 id 过滤：

```bash
python -m agentlens run cases/interpret_001.yaml --trace
python -m agentlens run cases/ --filter id:interpret_001 --trace
```

当前基线（5 条种子用例）：**3 PASS / 2 FAIL，可靠性分 60.0**，退出码 0；
`guard_false_001` 归 L6 护栏误伤，`interpret_001` 归 L2 工具选型。
这个基线是**刻意保持的红**——见下面的红线。

## Architecture

执行管线（`runner.run()` 是唯一的编排点）：

```
Adapter.invoke(case)      → AgentOutput(status/answer/spans/tokens)
  runner 封装            → Trace（补 run_id / adapter / seed）
  judge.rules.judge()    → Verdict（只做规则判定，全绿才 pass）
  attribute.attribute()  → 仅当 rule == "fail" 时跑，回填 layer / layer_reason / layer_evidence
  落盘                   → results/<run_id>/traces.jsonl（唯一真相源）+ summary.json
```

`traces.jsonl` 先落盘、再统计，顺序不可反：报告里每个数字都必须能顺着 run_id 找回原始 span。
报告类产物一律从 `traces.jsonl` 二次生成，不要另存一份真相。

### 三个概念不是一一对应（最容易搞混的地方）

| 概念 | 回答什么 | 定义在 |
|---|---|---|
| 七维度 `Dimension` | 我们在测什么（官方横轴，一字不能改） | `schema.py: DIMENSIONS` |
| 六类 span `SPAN_KINDS` | 从 trace 里能断言什么 | `schema.py` |
| 七层归因 `Layer` L0–L6 | 失败归到哪去（我们的纵轴） | `schema.py: LAYER_NAMES` |

- `functional_accuracy` / `boundary_exception` 两维**没有专属 span**，靠 span 组合判
- `multi_turn` 靠 `case.input.session` 预置 + `Trace.conversation_id` / `turn` 串多条 trace；`performance` 靠 span 上的 `latency_ms`
- 参数填充、答案忠实度**不是维度**，是归因层 L3 / L4；用例里用 tags 标注
- 一个失败样本可拆出多个根因；L6 单列是因为「该拒没拒」和「误拒」方向相反，混统计会抵消

### Schema 是地基，不可裁剪（`agentlens/schema.py`）

`_Strict` = `extra="forbid"`：schema 漂移必须在写入前炸掉，而不是等到归因阶段才发现缺少信息。
`Trace` 上的 `plan` / `tool_calls` / `observations` / `retrieves` / `guardrail` / `refused` /
`tool_names` 等 property 是裁判与归因的统一取数口——**不要在别处自己遍历 spans**。

### 归因决策顺序（`attribute.py`，越靠前越优先）

```
0. L0  超时/异常/不可达（status != ok）
6. L6  护栏两个方向（前置判定）：误拒 / 该拒没拒 / 被诱导调用 forbid_tools；否则误拒会被「没调工具」误判成 L2
1. L1  plan 缺失 / plan.steps 与实际调用序列脱节 / steps 为空
2. L2  期望的首个工具不在实际调用中
3. L3  tool_args 失败或 schema_ok=False
4. L4  工具返回全 ok，但 answer_text 断言不过
   ·   exact 模式期望工具都调了、答案无误、只多调了别的工具 → L1 规划冗余（插在 5 之前）
5. L5  有 retrieve（零召回 / 知识源本身错），或 observation 报错
   –   都不匹配 → 仍返回 L1 并标注「需人工复核」，不引入未定义层
```

v0 决策树**未经校准**，接口稳定、规则可迭代；M2 才用 100 条人工标注集出准确率。
调整顺序时必须同步更新 `attribute.py` 顶部 docstring 和 README 的判定顺序表。

### 裁判分层原则（`judge/rules.py`）

**能用规则判的，绝不交给 LLM。** 工具序列、参数约束、拒答与否有唯一正确答案，走确定性规则；
LLM 裁判（M2，尚未实现）只负责答案忠实度 / rubric 这类规则管不了的部分。
每条 `CheckResult` 必须带 `reason`，报告里要能直接读。`status == "blocked"` 直接判 skip。

### 被测对象（`adapters/`）

`base.py` 是对外契约：接一个新 Agent 只需实现 `invoke(case, *, run_id) -> AgentOutput`，
且保证同 seed 可复现。**吐不出分 span 的编排器（如 Dify）只能做消融对照组，当不了主版本**，
这是已定稿的技术决策。

`campus_copilot.py` 是当前的桩对象，**三处缺陷是刻意保留的**（文件头注释写明）：
单步规划→L1 样本、关键词首命中（`课` 优先于 `成绩`）→L2 样本、敏感词护栏误伤→L6 样本。
它只用来验证框架自洽；最终版 trace 必须来自真实 agent 的真实运行（record/replay，尚未实现）。

`tools.py` 把 5 个工具与 `FixtureStore` 单独抽出，是为了 M3 的故障注入以中间件形式挂在
`make_registry()` 外面，而不是去改 adapter 业务逻辑。`TOOL_SCHEMAS` 是参数白名单。

新增 adapter 的步骤：实现 `invoke()` → 在 `cli.py` 的 `ADAPTERS` 注册 → 用例 YAML 的
`expect.tools` 用新工具名。`--adapter` 的 choices 由该字典自动派生。

### 用例（`cases/*.yaml`）

声明式，非开发同学也能提交。任何一条非法就整体拒绝加载（不跑一半），`CaseError` 带 file:line，
行号由 `cases._line_of()` 从 pydantic 的 `loc` 路径反推（best effort）。id 全局唯一。

`expect.mode`：`exact` = 实际工具序列必须完全等于期望（`optional: true` 的工具可缺席）；
`contains` = 期望序列作为子序列出现。`expect.refusal` 三态：`True` 应拒 / `False` 不该拒 / `None` 不判。

**硬规则：没有 span 断言的用例不算用例。** 只写「期望回答得好」的用例一律打回。

## 红线（改动前必须确认）

1. **`schema.py` 是产品地基，改动需 rein 拍板。** 其它文件都依赖它。
2. **不要改 `campus_copilot.py` 的三处刻意缺陷**，也不要为了让用例变绿去改被测对象——那是作弊。
3. **不要把失败的用例改成期望通过。** 失败是资产，缺陷清单就是交付物。
4. **没有 pytest、没有 lint，也没有联网依赖**；任何新增依赖都不能在运行时需要网络或 LLM 额度
   （演示不能押在网络和 API 额度上）。
5. **不要自造第八个维度**，七维度是官方原文。
6. **不向学校真实系统发写请求**（请假、报修）；只读可以，写只用 `FixtureSource`。
7. **数据一律构造/脱敏**：`fixtures/` 里全是虚构数据，公开材料不得出现真实学号/姓名/成绩。
8. **一人一分支（`feat/agent-a` / `feat/agent-b`），每天合一次到 `feat/agent`；
   一次提交 = 一件事。** 官方明确会查 Git 历史粒度，一次性大提交会被判原创性存疑。

## 已知缺口（别在材料里当既有能力写）

截至 2026-11-08（细节见 `docs/用例扩充-2026-11-08.md`、`docs/故障注入校准-2026-11-07.md`、`docs/用例生成与缺陷-2026-11-07.md`、
`docs/性能断言与基线门禁-2026-11-07.md`）：

- **已有**：软帮手真实 agent 的 record/replay（`adapters/onegzus.py`）、LLM 忠实度裁判（结论按哈希缓存）、
  故障注入（`inject.py` 录制变异 + 软帮手 `FaultySource`）、LLM 保义改写生成器（`generate.py`）、审计台、
  性能预算断言（`expect.budget`）、基线门禁（`compare` / `run --baseline`，审计台运行对比页同一结论）、
  自包含 HTML 报告（`report.py`，由 traces.jsonl 二次生成，断网可开）
- 用例：测被测对象 354 条（人工 82 + 生成 272，自动生成 76.8%）+ 校准集 159 条（见 `docs/用例扩充-2026-11-08.md`）
- **归因在真实缺陷上的准确率未知**：校准集 100% 有循环论证成分（算子对着决策树分支设计），
  真实准确率只能靠人工复核 κ，目前标注仅 3 条
- L6 没有注入通道（护栏是规则，不经 LLM 回复）；性能预算只有 5 条用例 + 2 条变慢故障
- 门禁还没拿真实修复验证过（修被测对象要 rein 拍板）

```bash
python -m agentlens inject cases/onegzus/                       # 由真实录制生成校准用例 → cases/calibration/
python -m agentlens generate cases/onegzus/                     # LLM 保义改写 → cases/generated/（需 .env.judge，离线联网一次）
python -m agentlens run cases/calibration/ --adapter onegzus    # 输出「故障注入校准」表：检出率 / 归因准确率 / 95% CI
python -m agentlens compare <基线> <本次>                        # 基线门禁：新增失败或 p90 耗时涨超 20% → 退出码 1
python -m agentlens report <run_id> [--baseline <run_id>]       # HTML 报告 → results/<run_id>/report.html
```
