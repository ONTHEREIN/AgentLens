"""声明式用例：YAML -> Case 模型，非法文件启动即报错并给出行号（PRD P0-1）。

一条用例 = 输入 + 期望工具序列 + 期望参数约束 + 判定规则 + 标签。
写用例不需要写代码（US-01）。
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .schema import Dimension, DIMENSIONS


class CaseError(Exception):
    """用例文件非法。带 file/line，让 fail-fast 真的能定位。"""

    def __init__(self, path: Path, line: int | None, message: str) -> None:
        self.path = path
        self.line = line
        super().__init__(f"{path}:{line or '?'}: {message}")


class ArgConstraint(BaseModel):
    """期望参数约束。只要写了的规则都必须满足（AND）。"""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    equals: Any = None
    in_: list[Any] | None = Field(default=None, alias="in")
    regex: str | None = None
    gte: float | None = None
    lte: float | None = None

    def check(self, value: Any) -> tuple[bool, str]:
        if value is _MISSING:
            return False, "参数缺失"
        if self.equals is not None and value != self.equals:
            return False, f"期望等于 {self.equals!r}，实际 {value!r}"
        if self.in_ is not None and value not in self.in_:
            return False, f"期望属于 {self.in_!r}，实际 {value!r}"
        if self.regex is not None and not re.search(self.regex, str(value)):
            return False, f"期望匹配 /{self.regex}/，实际 {value!r}"
        if self.gte is not None and not (isinstance(value, (int, float)) and value >= self.gte):
            return False, f"期望 >= {self.gte}，实际 {value!r}"
        if self.lte is not None and not (isinstance(value, (int, float)) and value <= self.lte):
            return False, f"期望 <= {self.lte}，实际 {value!r}"
        return True, "ok"


class _Missing:
    def __repr__(self) -> str:
        return "<MISSING>"


_MISSING = _Missing()


class ToolExpectation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    args: dict[str, ArgConstraint] = Field(default_factory=dict)
    optional: bool = False   # optional 的工具缺失不算失败（用于"允许顺手多查一步"）


class Message(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["user", "assistant", "system"] = "user"
    content: str


class CaseInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    messages: list[Message]
    session: dict[str, Any] = Field(default_factory=dict)   # 多轮记忆预置
    options: dict[str, Any] = Field(default_factory=dict)

    @property
    def text(self) -> str:
        return "\n".join(m.content for m in self.messages if m.role == "user")


class Expect(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # exact    = 实际工具序列必须完全等于期望（多调少调都算错）
    # contains = 期望序列作为子序列出现即可（允许合法的额外步骤）
    mode: Literal["exact", "contains"] = "exact"
    tools: list[ToolExpectation] = Field(default_factory=list)
    # 不应被调用的工具（如间接注入诱导的越权查询）；与 mode 无关，单独断言
    forbid_tools: list[str] = Field(default_factory=list)
    refusal: bool | None = None            # 是否应当拒答
    answer_contains: list[str] = Field(default_factory=list)
    answer_not_contains: list[str] = Field(default_factory=list)
    rubric: str | None = None              # 留给 LLM 裁判（M2）


class Case(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    title: str = ""
    dimension: Dimension
    difficulty: Literal["easy", "medium", "hard"] = "easy"
    source: Literal["golden", "mutated", "llm"] = "golden"
    tags: list[str] = Field(default_factory=list)
    input: CaseInput
    expect: Expect
    note: str | None = None

    @property
    def expected_tools(self) -> list[str]:
        return [t.name for t in self.expect.tools if not t.optional]


# ---------------------------------------------------------------- loading


def _line_of(text: str, loc: tuple[Any, ...]) -> int | None:
    """把 pydantic 的 loc 路径粗暴映射回 YAML 行号（best effort，够定位就好）。"""
    line = 1
    cursor = 0
    for part in loc:
        if isinstance(part, int):
            # 列表元素：跳过同级的 "- " 行
            pattern = re.compile(r"^\s*-\s")
            for i, ln in enumerate(text.splitlines()[cursor:], start=cursor + 1):
                if pattern.match(ln):
                    if part == 0:
                        line, cursor = i, i
                        break
                    part -= 1
            else:
                return None
        else:
            pattern = re.compile(rf"^\s*{re.escape(str(part))}\s*:")
            found = False
            for i, ln in enumerate(text.splitlines()[cursor:], start=cursor + 1):
                if pattern.match(ln):
                    line, cursor = i, i
                    found = True
                    break
            if not found:
                return None
    return line


def load_case(path: Path) -> Case:
    text = path.read_text(encoding="utf-8")
    try:
        doc = yaml.safe_load(text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, "problem_mark", None)
        line = mark.line + 1 if mark is not None else None
        raise CaseError(path, line, f"YAML 语法错误：{getattr(exc, 'problem', exc)}") from exc

    if not isinstance(doc, dict):
        raise CaseError(path, 1, "用例文件顶层必须是映射（key: value）")

    try:
        return Case.model_validate(doc)
    except ValidationError as exc:
        err = exc.errors()[0]
        loc = tuple(err["loc"])
        line = _line_of(text, loc)
        where = ".".join(str(p) for p in loc) or "<root>"
        raise CaseError(path, line, f"字段 `{where}` 非法：{err['msg']}") from exc


def load_cases(root: Path) -> list[Case]:
    """加载目录下全部 .yaml/.yml；任一非法就整体拒绝（不跑一半）。"""
    files = sorted([*root.glob("*.yaml"), *root.glob("*.yml")]) if root.is_dir() else [root]
    if not files:
        raise CaseError(root, None, "空用例集：不产出 100% 通过的假报告（PRD §5.3）")

    cases: list[Case] = []
    seen: dict[str, Path] = {}
    for f in files:
        case = load_case(f)
        if case.id in seen:
            raise CaseError(f, 1, f"用例 id 重复：{case.id}（已在 {seen[case.id]} 出现）")
        seen[case.id] = f
        cases.append(case)

    for case in cases:
        if case.dimension not in DIMENSIONS:  # 理论上 pydantic 已挡，双保险
            raise CaseError(seen[case.id], 1, f"未知维度：{case.dimension}")
    return cases
