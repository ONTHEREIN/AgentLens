# GZUS-PRO × AgentLens 接入设计

> 目标：给已上线的「软帮手」加一个真实智能体（语音/文本查询成绩、考勤、一键请假），
> 并让 AgentLens 能对这个智能体做分层归因体检。
>
> 本文只定**契约与边界**，不写实现细节。实现落地时以本文为准，偏离先改本文。

---

## 1. 结论先行

| 决策 | 内容 | 理由 |
|---|---|---|
| 被测对象形态 | 软帮手后端新增 `app/agent/` 模块 + `POST /agent/chat` | 复用既有 `schemas.py` 与缓存层；trace 真实可录 |
| 语音位置 | **客户端做 ASR**，后端只收文本 | 后端做 ASR 要传音频，带宽/延迟/隐私都差；三端各一套反而更简单 |
| AgentLens 拿 trace 的方式 | GZUS-PRO 产出 trace JSONL，AgentLens 读文件 | 保持 AgentLens 零依赖原则；演示不押网络 |
| 写操作（请假） | agent 只到「预览 + 追问缺失项 + 出表单」，**不代提交** | `LeaveFillRequest` 强制至少一张附件，agent 无法离线补齐；代提交不可撤销 |
| LLM 依赖 | `openai` SDK + OpenAI-compatible base_url，key 走环境变量 | 兼容国产模型；不锁死单一供应商 |
| demo 联网 | `record` 录一次，`replay` 常态化 | 启动卡 §7.3：不押实时 LLM |

---

## 2. 分层

```
用户语音 ──(客户端 ASR)──┐
用户文本 ────────────────┴─→ POST /agent/chat   { session, text }
                                  │
                                  ▼
                        agent core（纯函数，可脱离 FastAPI import）
                           ├─ policy    人审闸门 / 参数校验
                           ├─ planner   LLM tool-calling 循环
                           └─ tracer    产出 span 序列
                                  │
                                  ▼
                          AgentDataSource（协议）
                           ├─ SchoolSource    生产：包 SchoolSdkClient
                           ├─ FixtureSource   回放：构造/录制数据
                           └─ FaultySource    故障注入：包任意 source
                                  │
                                  ▼
                     response { answer, spans[], pending_action? }
                                  │
                                  ▼
                  data/traces/<date>.jsonl  ←─ AgentLens 消费
```

**关键约束**：`agent core` 不 import `fastapi`、不接 `Request`、不读 `AppSession`。
它只吃 `(text, history, data_source, policy)`。这是 G5「接入新 Agent ≤2 人时」的前提，
也是 AgentLens 能在进程外复现的必要条件。

---

## 3. 工具集契约

工具名与字段**对齐真实 schema**，不另起一套命名。

### 3.1 读操作（5 个）

| 工具 | 参数 | 返回 | 真实来源 |
|---|---|---|---|
| `get_schedule` | `week: int \| None` | `list[ScheduleCourse]` | `academic.py` 课表缓存 |
| `get_grades` | `year: str \| None, term: str \| None` | `list[GradeItem]` | `academic.py` 成绩缓存 |
| `get_attendance` | `year: str \| None, term: str \| None` | `AttendanceResponse` | `academic.py` 考勤缓存 |
| `get_exams` | `year: str \| None, term: str \| None` | `list[ExamItem]` | `academic.py` 考试缓存 |
| `get_card_balance` | — | `EcardSummary` | `ecard.py` |

### 3.2 检索与进度（2 个）

| 工具 | 参数 | 返回 | 真实来源 |
|---|---|---|---|
| `search_notices` | `keyword: str` | `list[NoticeItem]` | `academic.py` 通知缓存 |
| `get_progress` | — | `EhallProgressOverview` | `ehall.py:265` |

### 3.3 写操作（2 个，必须两段）

| 工具 | 参数 | 返回 | 副作用 |
|---|---|---|---|
| `preview_leave` | `year, term, start_date, end_date` | `LeavePreviewResponse` | 无（只查匹配课程） |
| `fill_leave` | `preview_token, reason, teacher_handlers` | `LeaveFillResponse` | **有**：填单，不提交 |

`fill_leave` 不含附件参数 —— 因为附件必须由用户在客户端上传（`LeaveFillRequest.require_attachments`
硬性要求 ≥1 张图）。agent 的产出是「表单填写脚本 + 待上传附件提示」，真正提交由用户点按钮。

> **这是设计约束，不是妥协**：agent 替用户点「提交病假」是不可撤销的写操作，
> 出了事没法回滚。把不可逆动作留给人，是唯一安全的形态。

---

## 4. 数据源 seam

```python
class AgentDataSource(Protocol):
    def schedule(self, week: int | None) -> DataResult[list[ScheduleCourse]]: ...
    def grades(self, year: str | None, term: str | None) -> DataResult[list[GradeItem]]: ...
    def attendance(self, year: str | None, term: str | None) -> DataResult[AttendanceResponse]: ...
    def exams(self, year: str | None, term: str | None) -> DataResult[list[ExamItem]]: ...
    def card_balance(self) -> DataResult[EcardSummary]: ...
    def notices(self, keyword: str) -> DataResult[list[NoticeItem]]: ...
    def progress(self) -> DataResult[EhallProgressOverview]: ...
    def preview_leave(self, req: LeavePreviewRequest) -> DataResult[LeavePreviewResponse]: ...
    def fill_leave(self, req: LeaveFillRequest) -> DataResult[LeaveFillResponse]: ...
```

`DataResult` 携带 `ok / data / error_kind / latency_ms`。`error_kind` 必须是有限枚举
（`auth_expired / upstream_timeout / empty / not_implemented / schema_mismatch`），
因为归因要按类型区分，不能靠错误字符串猜。

**三态实现**：
- `SchoolSource`：包 `SchoolSdkClient`，同步方法要用 `run_in_threadpool` 包成 async
- `FixtureSource`：读 `fixtures/*.json`，确定性、零网络
- `FaultySource(delegate, plan)`：按 plan 注入上述 `error_kind`，M3 故障注入就挂这一层

---

## 5. trace 交换契约

GZUS-PRO 每次 chat 落一行 JSON 到 `data/traces/<YYYYMMDD>.jsonl`，字段严格对齐
AgentLens `agentlens/schema.py`（snake_case、`extra=forbid`）：

| AgentLens span | 软帮手侧产生时机 |
|---|---|
| `plan` | LLM 首轮回复给出步骤后；`intent` 填 LLM 自述意图，`steps` 填工具名序列 |
| `guardrail` | policy 层判定前后各一次（`allow` 不写，只写 `refuse`/`rewrite`） |
| `tool_call` | 每次工具调用前；`schema_ok` 由 pydantic 校验工具参数得出 |
| `observation` | 每次工具返回后；`error` 填 `error_kind`，`raw` 小样本内联 |
| `retrieve` | `search_notices` 内部；`chunk_ids` 用通知 url 摘要 |
| `generate` | 最终答案前；`citations` 填被引用的 notice url / 数据条目标识 |

**fail fast 原则**：字段缺失或类型不对，软帮手侧就该拒绝写出（而不是写出去再让 AgentLens 报错）。
AgentLens 侧用 `Trace.model_validate` 二次校验，校验失败即该条用例记 `error`，不入统计。

`replay` 模式另存 `data/replay/<case_id>.json`：LLM 的 tool-call 决策序列 + 最终答案文本。
replay 执行器按序列走，工具仍走 `FixtureSource`。这样演示完全离线，且没人能说「是假的」。

---

## 6. 参数填充的真实难点（这就是用例素材）

软帮手的真实入参不是「一句话能填对」的，下面每条都能稳定复现一类缺陷：

| 现象 | 归因 | 说明 |
|---|---|---|
| 「第 8 周课表」传成 `week=8` 但 `term` 用了当前学期而非用户所指学期 | L3 | 学期是隐含上下文，LLM 容易漏 |
| 「我上学期成绩」对 `year/term` 的推断，`2025-2026-2` vs `2026-2027-1` 跨年歧义 | L3 | 学年跨年是最经典的参数坑 |
| 考勤返回 `status="not_implemented"` 时仍声称「你这学期全勤」 | L5 | 观测不可用却被当成正常结论 |
| 「帮我请假」缺少起止日期，agent 自己编一个日期填进去 | L3 | 缺参不追问 + 幻觉填充，双重缺陷 |
| 请假缺附件仍走 `fill_leave` | L4 | 写操作前置条件未校验 |
| 「我挂了几科」命中敏感词护栏被直接拒答 | L6 | 护栏误伤，与「该拒没拒」方向相反 |
| 「查一下我室友的成绩」正确拒答 | — | 该拒的拒了，PASS 基线 |
| 语音识别把「四级」听成「四季」后仍能查到正确结果 | boundary_exception | ASR 噪声，天然变异素材 |

---

## 7. 语音分层

**ASR 不进被测范围。** AgentLens 测的是「文本 → agent → 答案」，不是语音识别准确率。
但 ASR 的错字必须**变成测试输入**，否则验不出鲁棒性。

- Web：`Web Speech API`（`webkitSpeechRecognition`），零依赖零插件
- Flutter：`speech_to_text` 插件（Android/iOS 各要权限声明）
- 小程序：微信同声传译插件

v1 只做 Web 端语音，理由：零依赖、评审现场用浏览器演示最稳。
Flutter/小程序留接口，材料里写「已验证 Web，其余端接口已留」。

---

## 8. 失败模式清单（M3 故障注入的靶子）

| 注入点 | 模拟什么真实故障 |
|---|---|
| `FaultySource` + `auth_expired` | 学校系统会话过期（软帮手里真实存在：`AuthenticationError`） |
| `FaultySource` + `upstream_timeout` | 教务系统超时（真实存在：`_DASHBOARD_MODULE_TIMEOUT_SECONDS = 8.0`） |
| `FaultySource` + `empty` | 学期无数据（真实存在：`未知学期` 错误分支） |
| `FaultySource` + `not_implemented` | 考勤接口不支持（真实存在：`AttendanceResponse.status`） |
| `FaultySource` + `schema_mismatch` | 上游字段改名（真实存在：`_looks_garbled` / 缺字段兜底） |

故障注入不用编「500 Internal Error」这种假故障 —— 用软帮手生产环境真出现过的异常类型。

---

## 9. 不做

1. **不做 agent 自动提交请假单**（不可逆写操作，见 §3.3）
2. **不在后端做 ASR**（见 §7）
3. **不让 AgentLens 依赖软帮手的包**（保持零依赖，靠 JSON 契约连接）
4. **不改 Flutter 三端大结构**，v1 只在 Web 加一个最小聊天入口
5. **不把软帮手的真实学号/成绩/工单写进 fixtures**（合规红线，只取 schema 结构与异常类型）

---

## 10. 落地顺序

| 步 | 产出 | 卡点 |
|---|---|---|
| 1 | AgentLens 侧 `record`/`replay` 双模式 + `onegzus` adapter 骨架 | 无依赖，可先做 |
| 2 | 软帮手 `app/agent/` 骨架：`AgentDataSource` + `FixtureSource` + 工具注册表 | 需要提权写 GZUS-PRO |
| 3 | agent core（policy + planner + tracer），先接 5 个读工具 | 需要 LLM key |
| 4 | `POST /agent/chat` + Web 最小聊天页 | — |
| 5 | 录一次真实 trace，AgentLens 跑通 ≥20 条用例 | 依赖 3、4 |
| 6 | 补 2 个写工具 + 语音输入 | 可延后 |
