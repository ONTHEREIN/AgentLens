(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);

  const state = {
    catalog: null,
    overview: null,
    runs: [],
    runsSuite: "", // 审计结果页的用例集筛选；空 = 全部用例运行（不含线上对话）
    detail: null, // 当前打开的运行
    selectedCase: null,
    filter: { verdict: "all", dimension: "", layer: "" },
    compareSel: [],
    compare: null,
    compareOnlyChanged: true,
    chats: null,
    chatFilter: "all",
    chat: null, // 当前打开的会话
    selectedTurn: 0,
    queue: null,
    queueTab: "pending",
    queueReason: "",
    queueSel: null, // `${run_id}/${case_id}`
    queueRow: null,
    reviews: null,
    busy: false,
    toastTimer: null,
  };

  const ICONS = {
    plan: `<svg viewBox="0 0 20 20" fill="none"><circle cx="5" cy="5" r="2.2" stroke="currentColor" stroke-width="1.5"/><circle cx="15" cy="15" r="2.2" stroke="currentColor" stroke-width="1.5"/><path d="M7.2 5H10c2.8 0 2.8 3.4 0 3.4H8.6c-2.8 0-2.8 3.4 0 3.4h1" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    tool_call: `<svg viewBox="0 0 20 20" fill="none"><path d="M12.3 3.2a4.2 4.2 0 0 0-4.9 5.4l-4 4a1.7 1.7 0 0 0 2.4 2.4l4-4a4.2 4.2 0 0 0 5.4-4.9l-2.4 2.4-2.1-.5-.5-2.1 2.1-2.7Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
    observation: `<svg viewBox="0 0 20 20" fill="none"><path d="M2.5 10s2.6-4.4 7.5-4.4 7.5 4.4 7.5 4.4-2.6 4.4-7.5 4.4S2.5 10 2.5 10Z" stroke="currentColor" stroke-width="1.4"/><circle cx="10" cy="10" r="2.1" stroke="currentColor" stroke-width="1.4"/></svg>`,
    retrieve: `<svg viewBox="0 0 20 20" fill="none"><path d="M3.2 4.4c2.7-.8 4.7-.3 6.8 1v10.2c-2.1-1.3-4.1-1.8-6.8-1V4.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M16.8 4.4c-2.7-.8-4.7-.3-6.8 1v10.2c2.1-1.3 4.1-1.8 6.8-1V4.4Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>`,
    generate: `<svg viewBox="0 0 20 20" fill="none"><path d="m12.8 3.5 3.7 3.7-7.4 7.4-4.4 1.2 1.2-4.4 6.9-7.9Z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="m11.1 5.2 3.7 3.7M4.7 14.9l-1 1" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
    guardrail: `<svg viewBox="0 0 20 20" fill="none"><path d="M10 2.7 16 5v4.6c0 3.3-2.3 5.7-6 7.7-3.7-2-6-4.4-6-7.7V5l6-2.3Z" stroke="currentColor" stroke-width="1.4"/><path d="m7.2 10 1.8 1.8 3.8-3.9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  };

  const CHECK_LABELS = {
    status: "执行状态",
    refusal: "拒答",
    tool_sequence: "工具序列",
    forbidden_tools: "禁止工具",
    tool_args: "工具参数",
    tool_schema: "参数合法性",
    plan: "规划一致性",
    answer_text: "答案关键词",
    budget: "性能预算",
    llm_faithfulness: "LLM 忠实度",
  };

  const ADAPTER_LABELS = {
    onegzus: "软帮手智能体",
    campus_copilot: "CampusCopilot 桩",
  };

  const REVIEW_TARGETS = ["verdict", "layer", "llm_faithfulness"];

  const view = $("#view");
  const toast = $("#toast");
  const reviewerInput = $("#reviewerInput");
  const queueBadge = $("#queueBadge");

  // ------------------------------------------------------------ helpers

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    }[char]));
  }

  function formatValue(value) {
    return typeof value === "string" ? value : JSON.stringify(value);
  }

  function prettyJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function dimensionLabel(id) {
    if (id === "other") return "其他（旧维度）";
    if (id === "chat") return "线上对话";
    return state.catalog?.dimensions?.find((d) => d.id === id)?.label || id || "未知维度";
  }

  function layerName(code) {
    if (!code || code === "none") return "无缺陷";
    return state.catalog?.layers?.[code] || code;
  }

  function spanLabel(kind) {
    return state.catalog?.span_labels?.[kind] || kind;
  }

  function suiteInfo(id) {
    return state.catalog?.suites?.find((s) => s.id === id) || null;
  }

  function suiteLabel(id) {
    if (id === "chat") return "线上对话";
    return suiteInfo(id)?.label || "未归属用例集";
  }

  function isInjected(id) {
    return Boolean(suiteInfo(id)?.injected);
  }

  function statusLabel(rule) {
    return { pass: "PASS", fail: "FAIL", skip: "SKIP" }[rule] || "SKIP";
  }

  function verdictClass(rule) {
    return ["pass", "fail", "skip"].includes(rule) ? rule : "skip";
  }

  function latencyLabel(value) {
    if (value === null || value === undefined) return "";
    if (value <= 0) return "<1ms";
    if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
    return `${Math.round(value)}ms`;
  }

  function formatTime(iso) {
    return String(iso || "").replace("T", " ").slice(0, 16);
  }

  function formatDay(stem) {
    const s = String(stem || "");
    return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : formatTime(s);
  }

  function clip(text, n) {
    const s = String(text || "");
    return s.length > n ? `${s.slice(0, n)}…` : s;
  }

  function adapterLabel(id) {
    return ADAPTER_LABELS[id] || id;
  }

  function runLabel(summary) {
    return summary.source === "chat" ? "软帮手线上对话" : adapterLabel(summary.adapter);
  }

  // 用例运行的输入来自用例定义；线上对话的输入来自 trace 记录的对话
  function rowMessages(row) {
    return row.case?.input?.messages || row.input_messages || [];
  }

  function lastUser(row) {
    const users = rowMessages(row).filter((m) => m.role === "user");
    return users[users.length - 1]?.content || "";
  }

  function rowTitle(row) {
    if (row.case?.title) return row.case.title;
    const last = lastUser(row);
    if (last) return clip(last, 40);
    return row.case === null && row.dimension === "chat" ? "（未记录用户输入）" : "（用例定义已不存在）";
  }

  function scoreText(summary) {
    // 注入集的失败是造出来的：看检出了多少，不看可靠性分
    if (isInjected(summary.suite)) return `检出 ${summary.fail}/${summary.total}`;
    return summary.score.toFixed(1);
  }

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("is-visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => toast.classList.remove("is-visible"), 4200);
  }

  function reviewer() {
    return reviewerInput.value.trim();
  }

  async function api(path, options = {}) {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`);
    }
    if (!response.ok) throw new Error(payload.error || `请求失败（HTTP ${response.status}）`);
    return payload;
  }

  function setBusy(busy) {
    state.busy = busy;
    document.body.classList.toggle("is-running", busy);
    document.querySelectorAll("[data-busy-disable]").forEach((el) => {
      el.disabled = busy;
    });
  }

  function placeholder(text, sub = "") {
    return `<div class="detail-placeholder"><p>${escapeHtml(text)}</p>${sub ? `<p class="muted">${escapeHtml(sub)}</p>` : ""}</div>`;
  }

  function pageHead(title, desc, { crumbs = "", actions = "" } = {}) {
    return `
      <section class="page-head">
        <div>
          ${crumbs ? `<p class="crumbs">${crumbs}</p>` : ""}
          <h1 class="page-title">${title}</h1>
          ${desc ? `<p class="page-desc">${desc}</p>` : ""}
        </div>
        ${actions ? `<div class="page-actions">${actions}</div>` : ""}
      </section>`;
  }

  function setQueueBadge(pending) {
    queueBadge.hidden = !pending;
    queueBadge.textContent = pending > 99 ? "99+" : String(pending);
  }

  async function refreshQueueBadge() {
    try {
      const q = await api("/api/queue");
      setQueueBadge(q.pending);
      return q;
    } catch {
      return null;
    }
  }

  // ------------------------------------------------------------ span rendering

  function spanSummary(span) {
    switch (span.span) {
      case "plan":
        return `意图：${escapeHtml(span.intent || "未记录")}`;
      case "tool_call":
        return `<span class="accent">${escapeHtml(span.name)}</span> 调用 <span class="${span.schema_ok ? "" : "schema-bad"}">${span.schema_ok ? "· 参数合法" : "· 参数不合法"}</span>`;
      case "observation":
        return span.ok
          ? `返回正常${span.row_count !== null && span.row_count !== undefined ? ` · ${escapeHtml(span.row_count)} 行` : ""}`
          : `<span class="span-error">工具报错：${escapeHtml(span.error || "未知错误")}</span>`;
      case "retrieve": {
        const hits = (span.chunk_ids || []).length;
        return `查询「${escapeHtml(span.query)}」→ ${hits ? `${hits} 条命中` : `<span class="span-error">零召回</span>`}`;
      }
      case "generate":
        return `生成回答 · 引用 ${(span.citations || []).length} 条`;
      case "guardrail":
        return span.triggered
          ? `<span class="span-error">${escapeHtml(span.action)}</span> · 规则 ${escapeHtml(span.rule || "unknown")}`
          : `放行`;
      default:
        return escapeHtml(span.span || "");
    }
  }

  function spanDetails(span) {
    if (span.span === "plan") {
      const steps = (span.steps || [])
        .map((step) => `<span class="arg-chip"><b>step</b> ${escapeHtml(step)}</span>`)
        .join("") || '<span class="arg-chip">无计划步骤</span>';
      const notes = span.notes
        ? `<details class="raw-details"><summary>模型推理过程</summary><pre>${escapeHtml(span.notes)}</pre></details>`
        : "";
      return steps + notes;
    }
    if (span.span === "tool_call") {
      const chips = Object.entries(span.args || {})
        .map(([key, value]) => `<span class="arg-chip"><b>${escapeHtml(key)}</b> ${escapeHtml(formatValue(value))}</span>`)
        .join("") || '<span class="arg-chip">无参数</span>';
      const errors = (span.schema_errors || []).length
        ? `<span class="arg-chip span-error">${escapeHtml(span.schema_errors.join("; "))}</span>`
        : "";
      return chips + errors;
    }
    if (span.span === "observation") {
      const detail = span.error ? `<span class="arg-chip span-error">${escapeHtml(span.error)}</span>` : "";
      const raw = span.raw === null || span.raw === undefined
        ? ""
        : `<details class="raw-details"><summary>查看原始返回</summary><pre>${escapeHtml(prettyJson(span.raw))}</pre></details>`;
      return detail + raw;
    }
    if (span.span === "retrieve") {
      return (span.chunk_ids || [])
        .map((chunk, index) => `<span class="chunk-chip">${escapeHtml(chunk)} <i>${Number(span.scores?.[index] ?? 0).toFixed(2)}</i></span>`)
        .join("");
    }
    if (span.span === "generate") {
      return (span.citations || []).map((c) => `<span class="citation-chip">${escapeHtml(c)}</span>`).join("");
    }
    if (span.span === "guardrail") {
      return span.reason ? `<span class="arg-chip">${escapeHtml(span.reason)}</span>` : "";
    }
    return "";
  }

  function renderSpan(span, evidenceSet, index) {
    const isEvidence = evidenceSet.has(span.span_id);
    const latency = span.latency_ms ? `<span class="span-latency">${latencyLabel(span.latency_ms)}</span>` : "";
    return `
      <li class="span-node ${isEvidence ? "is-evidence" : ""}" data-span-id="${escapeHtml(span.span_id)}" style="--i:${index}">
        <span class="span-icon" aria-hidden="true">${ICONS[span.span] || ICONS.plan}</span>
        <div class="span-body">
          <div class="span-line">
            <span class="span-kind">${escapeHtml(spanLabel(span.span))}</span>
            <span class="span-step">${escapeHtml(span.span_id)}</span>
            ${isEvidence ? '<span class="evidence-tag">证据</span>' : ""}
            ${latency}
          </div>
          <div class="span-summary">${spanSummary(span)}</div>
          <div class="span-detail">${spanDetails(span)}</div>
        </div>
      </li>
    `;
  }

  function evidenceLinks(ids) {
    return [...new Set(ids || [])]
      .filter((id) => !String(id).startsWith("judgement:"))
      .map((id) => `<button type="button" class="evidence-link" data-jump="${escapeHtml(id)}">${escapeHtml(id)}</button>`)
      .join("");
  }

  function renderChecks(trace) {
    const checks = trace.verdict?.checks || [];
    const degraded = trace.verdict?.judge_degraded
      ? '<p class="muted small">LLM 裁判降级：无缓存且未配置，只有规则轨结论。</p>'
      : "";
    if (!checks.length) return `<div class="side-head"><h3>判定</h3></div><p class="muted">没有检查记录（跳过）。</p>${degraded}`;
    const passed = checks.filter((c) => c.passed).length;
    const rows = checks.map((check) => {
      const isLlm = check.check === "llm_faithfulness";
      const links = evidenceLinks(check.evidence);
      return `
        <div class="check-row ${check.passed ? "" : "is-bad"}">
          <span class="check-mark" aria-hidden="true">${check.passed ? "✓" : "×"}</span>
          <div>
            <div class="check-name">${escapeHtml(CHECK_LABELS[check.check] || check.check)}${isLlm ? ' <span class="track-tag">语义轨</span>' : ' <span class="track-tag rule">规则轨</span>'}</div>
            <div class="check-reason">${escapeHtml(check.reason)}</div>
            ${links ? `<div class="check-evidence">${links}</div>` : ""}
          </div>
        </div>
      `;
    }).join("");
    return `<div class="side-head"><h3>判定明细</h3><span>${passed}/${checks.length} 项通过</span></div><div class="check-list">${rows}</div>${degraded}`;
  }

  function renderAttribution(trace) {
    const healthy = !trace.layer;
    const links = evidenceLinks(trace.layer_evidence);
    return `
      <section class="attribution-card ${healthy ? "is-healthy" : ""}">
        <div class="attr-top">
          <span class="attr-code">${escapeHtml(trace.layer || "OK")}</span>
          <span class="attr-title">
            <small>${healthy ? "无缺陷" : "根因归因"}</small>
            <strong>${healthy ? (trace.verdict.rule === "skip" ? "已跳过，未判定" : "未触发失败归因") : `${escapeHtml(trace.layer)} · ${escapeHtml(layerName(trace.layer))}`}</strong>
          </span>
        </div>
        <p class="attr-reason">${escapeHtml(healthy ? (trace.meta?.error || "全部检查通过，没有失败需要归因。") : trace.layer_reason || "归因引擎未返回原因。")}</p>
        ${links ? `<div class="attr-evidence"><span>证据步骤</span>${links}</div>` : ""}
      </section>
    `;
  }

  // ------------------------------------------------------------ 审计详情（运行 / 会话 / 复核队列共用）

  const REVIEW_OPTIONS = {
    verdict: [["pass", "PASS"], ["fail", "FAIL"]],
    layer: [["none", "无缺陷"], ["L0", "L0 环境/超时"], ["L1", "L1 意图与规划"], ["L2", "L2 工具选型"], ["L3", "L3 参数填充"], ["L4", "L4 结果解读"], ["L5", "L5 知识与检索"], ["L6", "L6 护栏"]],
    llm_faithfulness: [["faithful", "忠实"], ["unfaithful", "不忠实"]],
  };

  function valueLabel(target, value) {
    return (REVIEW_OPTIONS[target].find(([v]) => v === value) || [value, value])[1];
  }

  function machineValue(trace, target) {
    const rule = trace.verdict.rule;
    if (rule === "skip") return null;
    if (target === "verdict") return rule;
    if (target === "layer") return trace.layer || "none";
    const check = (trace.verdict.checks || []).find((c) => c.check === "llm_faithfulness");
    if (!check) return null;
    return check.passed ? "faithful" : "unfaithful";
  }

  function labelFor(labels, row, target) {
    return labels?.[`${row.trace_key}|${target}`] || null;
  }

  function reviewHtml(row, labels, { next = false } = {}) {
    const targets = REVIEW_TARGETS.filter((t) => machineValue(row.trace, t) !== null);
    if (!targets.length) return `<section class="side-card review-card"><div class="side-head"><h3>人工复核</h3></div><p class="muted">跳过的用例不参与复核。</p></section>`;
    const items = targets.map((target) => {
      const machine = machineValue(row.trace, target);
      const label = labelFor(labels, row, target);
      const current = label ? label.human : "";
      const options = REVIEW_OPTIONS[target]
        .map(([v, text]) => `<option value="${v}" ${v === current ? "selected" : ""}>${escapeHtml(text)}${v === machine ? "（同机器）" : ""}</option>`)
        .join("");
      const status = label
        ? `<span class="review-status ${label.agree ? "agree" : "disagree"}">${label.agree ? "同意机器" : "不同意"} · ${escapeHtml(label.reviewer || "匿名")} · ${escapeHtml(formatTime(label.at))}</span>`
        : '<span class="review-status">未复核</span>';
      return `
        <div class="review-row">
          <div class="review-target">
            <b>${escapeHtml(state.catalog.review_targets[target])}</b>
            <span>机器：${escapeHtml(valueLabel(target, machine))}</span>
          </div>
          <div class="review-quick" role="group" aria-label="${escapeHtml(state.catalog.review_targets[target])}">
            <button type="button" class="chip-btn ${current && current === machine ? "is-on" : ""}" data-agree="${target}">同意机器</button>
            <select data-target="${target}" data-machine="${escapeHtml(machine)}" aria-label="${escapeHtml(state.catalog.review_targets[target])} 的人工结论">
              <option value="">改判为…</option>${options}
            </select>
          </div>
          ${status}
          ${label?.note ? `<p class="review-note">${escapeHtml(label.note)}</p>` : ""}
        </div>`;
    }).join("");
    return `
      <section class="side-card review-card" id="reviewCard">
        <div class="side-head"><h3>人工复核</h3><span>标注按 trace 指纹沿用到所有复跑</span></div>
        <div class="review-list">${items}</div>
        <textarea id="reviewNote" rows="2" maxlength="500" placeholder="备注（可选）：例如「88.7 应为 88.64」"></textarea>
        <button type="button" class="run-button" id="reviewSubmit">${next ? "提交并看下一条" : "提交复核"}</button>
      </section>`;
  }

  function messagesHtml(row) {
    const recorded = rowMessages(row);
    if (!recorded.length) return '<p class="case-note">这条对话产生于记录用户输入之前，原始问题已无法还原；回答与执行链路仍可审计。</p>';
    return recorded.map((m) => `
      <div class="question ${m.role === "assistant" ? "is-assistant" : ""}">
        <span class="question-label">${m.role === "assistant" ? "智能体（历史）" : "用户"}</span>
        <p>${escapeHtml(m.content)}</p>
      </div>`).join("");
  }

  function expectedTools(item) {
    return (item?.expect?.tools || []).filter((t) => !t.optional).map((t) => t.name);
  }

  // opts.hero：是否显示问题与元信息（会话视图左侧已经有对话，不重复）；opts.banner：复核队列的入队原因
  function inspectorHtml(row, labels, opts = {}) {
    const { hero = true, banner = "", next = false } = opts;
    const item = row.case || {};
    const t = row.trace;
    const rule = verdictClass(t.verdict.rule);
    const expected = expectedTools(item);
    const actual = (t.spans || []).filter((s) => s.span === "tool_call").map((s) => s.name);
    const evidence = new Set(t.layer_evidence || []);
    (t.verdict?.checks || []).forEach((c) => {
      if (!c.passed) (c.evidence || []).forEach((id) => evidence.add(id));
    });
    const meta = t.meta || {};
    const chips = `
      <div class="meta-row">
        <span class="meta-chip">${escapeHtml(t.model)}</span>
        ${meta.today ? `<span class="meta-chip">今天 ${escapeHtml(meta.today)}</span>` : ""}
        ${meta.current_term ? `<span class="meta-chip">${escapeHtml(meta.current_term)} 第 ${escapeHtml(meta.week)} 周</span>` : ""}
        <span class="meta-chip">耗时 ${escapeHtml(latencyLabel(t.latency_ms) || "0ms")}</span>
        <span class="meta-chip">tokens ${escapeHtml((t.tokens?.prompt || 0) + (t.tokens?.completion || 0))}</span>
        <span class="meta-chip mono" title="trace 内容指纹：人工标注按它沿用">#${escapeHtml(row.trace_key)}</span>
        ${(item.tags || []).map((tag) => `<span class="meta-chip">#${escapeHtml(tag)}</span>`).join("")}
      </div>`;
    const head = hero ? `
      <header class="case-hero">
        <div class="case-headline">
          <span class="status-badge ${rule}"><i></i>${statusLabel(t.verdict.rule)}</span>
          <div>
            <div class="case-kicker"><b>${escapeHtml(t.case_id)}</b> · ${escapeHtml(dimensionLabel(row.dimension))}${item.difficulty ? ` · ${escapeHtml(item.difficulty)}` : ""}</div>
            <h2 class="case-h2">${escapeHtml(rowTitle(row))}</h2>
          </div>
        </div>
        ${messagesHtml(row)}
        ${chips}
        ${item.note ? `<p class="case-note">${escapeHtml(item.note)}</p>` : ""}
      </header>` : `<header class="case-hero is-compact">
        <div class="case-headline">
          <span class="status-badge ${rule}"><i></i>${statusLabel(t.verdict.rule)}</span>
          <div class="case-kicker"><b>第 ${escapeHtml(t.turn || 1)} 轮</b> · ${escapeHtml(t.case_id)}</div>
        </div>
        ${chips}
      </header>`;
    const toolCompare = row.case ? `
      <div class="tool-compare">
        <div class="compare-cell"><small>期望工具</small><code>${escapeHtml(expected.join(", ") || "无")}</code>${(item.expect?.forbid_tools || []).length ? `<small class="forbid">禁止：${escapeHtml(item.expect.forbid_tools.join(", "))}</small>` : ""}</div>
        <div class="compare-cell ${rule === "fail" && JSON.stringify(expected) !== JSON.stringify(actual) ? "is-bad" : ""}"><small>实际工具</small><code>${escapeHtml(actual.join(", ") || "无")}</code></div>
      </div>` : "";
    return `
      <article class="detail">
        ${banner}
        ${head}
        <div class="detail-grid">
          <div class="trace-column">
            <div class="block-title">
              <span>思考—行动链路</span>
              <span>${(t.spans || []).length} 步 · 点证据可定位</span>
            </div>
            ${toolCompare}
            <ol class="trace-list">${(t.spans || []).map((s, i) => renderSpan(s, evidence, i)).join("")}</ol>
            <section class="answer-card">
              <div class="answer-label"><span>智能体回答</span><span>${escapeHtml(latencyLabel(t.latency_ms))}</span></div>
              <p class="answer-text">${escapeHtml(t.answer || "（无回答）")}</p>
            </section>
          </div>
          <aside class="evidence-column">
            ${next ? reviewHtml(row, labels, { next }) : ""}
            ${renderAttribution(t)}
            <section class="side-card">${renderChecks(t)}</section>
            ${next ? "" : reviewHtml(row, labels)}
          </aside>
        </div>
      </article>`;
  }

  // 证据跳转 + 复核提交；onSaved(labels) 由调用方决定之后怎么刷新
  function bindInspector(root, row, labels, onSaved) {
    root.addEventListener("click", (e) => {
      const link = e.target.closest("[data-jump]");
      if (link) {
        const target = $(`[data-span-id="${CSS.escape(link.dataset.jump)}"]`, root);
        if (!target) return;
        target.classList.add("is-evidence");
        target.scrollIntoView({ behavior: "smooth", block: "center" });
        target.animate(
          [{ boxShadow: "0 0 0 0 rgba(220,236,155,.75)" }, { boxShadow: "0 0 0 7px rgba(220,236,155,0)" }],
          { duration: 900, easing: "ease-out" },
        );
        return;
      }
      const agree = e.target.closest("[data-agree]");
      if (agree) {
        const select = $(`select[data-target="${agree.dataset.agree}"]`, root);
        select.value = select.dataset.machine;
        root.querySelectorAll(`[data-agree="${agree.dataset.agree}"]`).forEach((b) => b.classList.add("is-on"));
      }
    });
    root.querySelectorAll(".review-row select").forEach((select) => select.addEventListener("change", () => {
      $(`[data-agree="${select.dataset.target}"]`, root)?.classList.toggle("is-on", select.value === select.dataset.machine);
    }));
    $("#reviewSubmit", root)?.addEventListener("click", () => submitReview(root, row, labels, onSaved));
  }

  async function submitReview(root, row, labels, onSaved) {
    const picks = [...root.querySelectorAll(".review-row select")].filter((s) => s.value);
    if (!picks.length) {
      showToast("至少给一项选择人工结论（可以直接点「同意机器」）");
      return;
    }
    if (!reviewer()) {
      showToast("请先在左下角填写复核人");
      reviewerInput.focus();
      return;
    }
    const note = $("#reviewNote", root).value.trim();
    try {
      for (const select of picks) {
        const { label } = await api("/api/reviews", {
          method: "POST",
          body: JSON.stringify({
            trace_key: row.trace_key,
            case_id: row.trace.case_id,
            run_id: row.run_id,
            target: select.dataset.target,
            machine: select.dataset.machine,
            human: select.value,
            note,
            reviewer: reviewer(),
          }),
        });
        labels[`${row.trace_key}|${label.target}`] = label;
      }
      showToast(`已保存 ${picks.length} 项复核`);
      refreshQueueBadge();
      onSaved();
    } catch (error) {
      showToast(`保存失败：${error.message}`);
    }
  }

  // ------------------------------------------------------------ 最新审计（概览）

  function sparkline(values, { invert = false } = {}) {
    if (values.length < 2) return '<span class="spark-empty">只有 1 次运行</span>';
    const w = 132;
    const h = 36;
    const pts = values.map((v, i) => {
      const y = invert ? 100 - v : v;
      return [4 + (i * (w - 8)) / (values.length - 1), h - 4 - (y / 100) * (h - 8), y];
    });
    const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    const dots = pts.map(([x, y, v], i) => `
      <circle class="spark-hit" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="7"><title>第 ${i + 1} 次：${v.toFixed(1)}</title></circle>`).join("");
    const [lx, ly] = pts[pts.length - 1];
    return `
      <svg class="spark" viewBox="0 0 ${w} ${h}" role="img" aria-label="最近 ${values.length} 次运行的走势">
        <line class="spark-base" x1="4" x2="${w - 4}" y1="${h - 4}" y2="${h - 4}"/>
        <polyline class="spark-line" points="${line}"/>
        <circle class="spark-dot" cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="4"/>
        ${dots}
      </svg>`;
  }

  function deltaHtml(entry) {
    if (entry.delta === null) return '<span class="delta muted">首次运行</span>';
    if (isInjected(entry.suite)) return "";
    const d = entry.delta;
    const cls = d > 0 ? "up" : d < 0 ? "down" : "flat";
    const text = d === 0 ? "与上次持平" : `${d > 0 ? "↑ +" : "↓ "}${d.toFixed(1)} 较上次`;
    const href = `#/compare/${encodeURIComponent(entry.prev_run_id)}/${encodeURIComponent(entry.run.run_id)}`;
    return `<a class="delta ${cls}" href="${href}" title="与上一次运行做门禁对比">${text}</a>`;
  }

  function suiteCard(entry) {
    const r = entry.run;
    const injected = isInjected(entry.suite);
    const href = entry.suite === "chat" ? "#/chats" : `#/run/${encodeURIComponent(r.run_id)}`;
    const big = injected
      ? `${r.fail}<small> / ${r.total} 检出</small>`
      : `${r.score.toFixed(1)}<small> 分</small>`;
    return `
      <article class="suite-card ${injected ? "is-injected" : ""}">
        <header>
          <a class="suite-name" href="${href}">${escapeHtml(suiteLabel(entry.suite))}</a>
          ${injected ? '<span class="tag">注入集 · 不计分</span>' : ""}
        </header>
        <div class="suite-score">
          <strong>${big}</strong>
          ${sparkline(entry.trend, { invert: injected })}
        </div>
        <div class="suite-meta">
          <span><span class="pass-text">通过 ${r.pass}</span> · <span class="fail-text">失败 ${r.fail}</span>${r.skip ? ` · 跳过 ${r.skip}` : ""}</span>
          ${deltaHtml(entry)}
        </div>
        <footer>
          <a class="mono" href="${href}">${escapeHtml(r.run_id)}</a>
          <span>${escapeHtml(formatTime(r.generated_at))} · 共 ${entry.runs} 次</span>
        </footer>
      </article>`;
  }

  function reasonTag(reason) {
    const cls = { conflict: "bad", llm_only: "warn", uncertain: "warn", failure: "", unjudged: "" }[reason] ?? "";
    return `<span class="tag ${cls}">${escapeHtml(state.queue?.reasons?.[reason] || state.overview?.queue?.reasons?.[reason] || reason)}</span>`;
  }

  function queueHref(item) {
    return `#/queue/${encodeURIComponent(item.run_id)}/${encodeURIComponent(item.case_id)}`;
  }

  function renderOverview() {
    const o = state.overview;
    const q = o.queue;
    const kappa = o.agreement.verdict;
    const newest = o.recent[0];
    const caseSuites = o.latest.filter((e) => e.suite !== "chat");
    const chat = o.latest.find((e) => e.suite === "chat");
    const reasonRows = Object.entries(q.by_reason).filter(([, n]) => n)
      .map(([r, n]) => `<li><span>${escapeHtml(q.reasons[r])}</span><b>${n}</b></li>`).join("");
    const top = o.queue_top.map((i) => `
      <a class="list-row" href="${queueHref(i)}">
        <span class="verdict-pill ${verdictClass(i.verdict)}">${statusLabel(i.verdict)}</span>
        <span class="list-main">
          <b>${escapeHtml(clip(i.title, 46))}</b>
          <small>${escapeHtml(suiteLabel(i.suite))} · ${escapeHtml(i.case_id)}${i.layer ? ` · ${escapeHtml(i.layer)} ${escapeHtml(layerName(i.layer))}` : ""}</small>
        </span>
        ${reasonTag(i.reasons[0])}
      </a>`).join("");
    const recent = o.recent.map((r) => `
      <a class="list-row" href="${r.source === "chat" ? "#/chats" : `#/run/${encodeURIComponent(r.run_id)}`}">
        <span class="list-main">
          <b>${escapeHtml(suiteLabel(r.suite))}</b>
          <small class="mono">${escapeHtml(r.run_id)} · ${escapeHtml(formatTime(r.generated_at))}</small>
        </span>
        <span class="list-num"><span class="pass-text">${r.pass}</span> / <span class="fail-text">${r.fail}</span></span>
        <span class="list-score">${escapeHtml(scoreText(r))}</span>
      </a>`).join("");

    view.innerHTML = `
      ${pageHead("最新审计", "每个用例集最近一次运行的结论，和等你处理的事。点卡片进入那次运行，点「较上次」看两次运行的门禁对比。")}

      <section class="stat-tiles">
        <a class="stat-tile ${q.pending ? "is-attention" : ""}" href="#/queue">
          <span>待人工复核</span>
          <strong>${q.pending}</strong>
          <small>已复核 ${q.reviewed} 条 · 点击开始复核</small>
        </a>
        <a class="stat-tile" href="#/chats">
          <span>线上会话</span>
          <strong>${o.conversations}</strong>
          <small>${chat ? `最近 ${escapeHtml(formatTime(chat.run.generated_at))}` : "聊天页还没有对话"}</small>
        </a>
        <a class="stat-tile" href="#/runs">
          <span>最近一次运行</span>
          <strong class="is-text">${newest ? escapeHtml(formatTime(newest.generated_at).slice(5)) : "—"}</strong>
          <small>${newest ? escapeHtml(suiteLabel(newest.suite)) : "还没有运行记录"}</small>
        </a>
        <a class="stat-tile" href="#/reviews">
          <span>人机一致性（总判定 κ）</span>
          <strong>${kappa.kappa === null ? "—" : kappa.kappa.toFixed(2)}</strong>
          <small>${kappa.n} 条标注${kappa.n < 30 ? " · 少于 30 条，仅供参考" : ""}</small>
        </a>
      </section>

      <section class="section">
        <div class="section-bar"><h2>各用例集最新结论</h2><a class="text-link" href="#/runs">全部运行 →</a></div>
        <div class="suite-grid">${caseSuites.map(suiteCard).join("") || placeholder("还没有用例运行", "在「审计结果」发起一次运行")}</div>
      </section>

      <section class="overview-split">
        <div class="panel">
          <div class="panel-bar">
            <h2>优先复核 <span class="muted small">${q.pending} 条待处理</span></h2>
            <a class="text-link" href="#/queue">进入复核队列 →</a>
          </div>
          ${reasonRows ? `<ul class="reason-list">${reasonRows}</ul>` : ""}
          <div class="list">${top || '<p class="muted">队列已清空。</p>'}</div>
        </div>
        <div class="panel">
          <div class="panel-bar"><h2>最近运行</h2><a class="text-link" href="#/runs">审计结果 →</a></div>
          <div class="list">${recent || '<p class="muted">还没有运行记录。</p>'}</div>
        </div>
      </section>`;
  }

  // ------------------------------------------------------------ 线上对话

  function convStatus(c) {
    if (c.fail) return `<span class="tag bad">${c.fail} 轮失败</span>`;
    if (c.unjudged) return `<span class="tag warn">${c.unjudged} 轮未判定</span>`;
    return '<span class="tag ok">全部通过</span>';
  }

  function renderChats() {
    const all = state.chats;
    const f = state.chatFilter;
    const list = all.filter((c) => (f === "fail" ? c.fail : f === "unjudged" ? c.unjudged : true));
    const turns = all.reduce((s, c) => s + c.turns, 0);
    const failed = all.filter((c) => c.fail).length;
    const unjudged = all.filter((c) => c.unjudged).length;
    const chip = (key, text, n) => `<button class="filter ${f === key ? "is-active" : ""}" type="button" data-cf="${key}">${text} <b>${n}</b></button>`;
    const rows = list.map((c) => `
      <a class="conv-row" href="#/chat/${encodeURIComponent(c.conversation_id)}">
        <span class="conv-main">
          <b>${escapeHtml(c.title ? clip(c.title, 60) : "（未记录用户输入）")}</b>
          <small>${escapeHtml(clip(c.last_answer.replace(/\s+/g, " "), 90))}</small>
        </span>
        <span class="conv-cell">${c.turns} 轮</span>
        <span class="conv-cell">${convStatus(c)}${c.layers.map((l) => ` <span class="tag">${escapeHtml(l)}</span>`).join("")}</span>
        <span class="conv-cell muted">${escapeHtml(formatDay(c.updated))}</span>
        <span class="conv-cell mono muted">${escapeHtml(c.conversation_id)}</span>
      </a>`).join("");
    view.innerHTML = `
      ${pageHead("线上对话", "软帮手聊天页里的真实对话，按会话聚合。线上对话没有预设期望，只判执行状态和 LLM 忠实度；未判定的轮次在打开会话时才调用裁判。")}
      <section class="panel">
        <div class="panel-bar">
          <div class="filters" role="group" aria-label="筛选会话">
            ${chip("all", "全部会话", all.length)}${chip("fail", "有失败", failed)}${chip("unjudged", "有未判定", unjudged)}
          </div>
          <span class="muted small">共 ${turns} 轮</span>
        </div>
        ${all.length ? `
          <div class="conv-head"><span>会话</span><span>轮次</span><span>审计结论</span><span>日期</span><span>会话 ID</span></div>
          <div class="conv-list">${rows || '<p class="muted">这个筛选下没有会话。</p>'}</div>`
          : placeholder("还没有线上对话", "在软帮手聊天页里问一句，这里就会出现")}
      </section>`;
    view.querySelectorAll("[data-cf]").forEach((b) => b.addEventListener("click", () => {
      state.chatFilter = b.dataset.cf;
      renderChats();
    }));
  }

  function renderChat() {
    const c = state.chat;
    const rows = c.rows;
    const sel = Math.min(state.selectedTurn, rows.length - 1);
    const failed = rows.filter((r) => r.trace.verdict.rule === "fail").length;
    const first = rows[0];
    const title = lastUser(first) || "（未记录用户输入）";
    const turns = rows.map((row, i) => {
      const t = row.trace;
      const rule = verdictClass(t.verdict.rule);
      const question = lastUser(row);
      return `
        <button type="button" class="turn ${i === sel ? "is-selected" : ""} is-${rule}" data-turn="${i}" aria-pressed="${i === sel}">
          <span class="turn-no">第 ${escapeHtml(t.turn || i + 1)} 轮</span>
          ${question ? `<span class="bubble user">${escapeHtml(question)}</span>` : '<span class="bubble user is-missing">（未记录用户输入）</span>'}
          <span class="bubble agent">${escapeHtml(clip(t.answer, 140))}</span>
          <span class="turn-foot">
            <span class="verdict-pill ${rule}">${statusLabel(t.verdict.rule)}</span>
            ${t.layer ? `<span class="layer-mini">${escapeHtml(t.layer)} ${escapeHtml(layerName(t.layer))}</span>` : ""}
            ${t.verdict.judge_degraded ? '<span class="layer-mini is-empty">未判定</span>' : ""}
            <span class="muted small">${escapeHtml(latencyLabel(t.latency_ms))}</span>
          </span>
        </button>`;
    }).join("");
    view.innerHTML = `
      ${pageHead(escapeHtml(clip(title, 40)), `${rows.length} 轮 · ${failed ? `<span class="fail-text">${failed} 轮失败</span>` : "全部通过"} · 模型 ${escapeHtml(first.trace.model)} · ${escapeHtml(formatDay(c.date))}`, {
        crumbs: `<a href="#/chats">线上对话</a> / <span class="mono">${escapeHtml(c.conversation_id)}</span>`,
      })}
      <section class="chat-layout">
        <aside class="transcript" aria-label="对话记录">
          <div class="transcript-head">对话记录 <span class="muted small">点一轮查看它的审计</span></div>
          ${turns}
        </aside>
        <section class="detail-panel" id="detailPanel">${inspectorHtml(rows[sel], c.labels, { hero: false })}</section>
      </section>`;
    view.querySelectorAll("[data-turn]").forEach((b) => b.addEventListener("click", () => {
      state.selectedTurn = Number(b.dataset.turn);
      history.replaceState(null, "", `#/chat/${encodeURIComponent(c.conversation_id)}/${state.selectedTurn + 1}`);
      renderChat();
    }));
    bindInspector($("#detailPanel"), rows[sel], c.labels, renderChat);
  }

  // ------------------------------------------------------------ 待人工复核

  function queueItems() {
    const q = state.queue;
    return q.items.filter((i) => (state.queueTab === "pending" ? !i.reviewed : i.reviewed)
      && (!state.queueReason || i.reasons.includes(state.queueReason)));
  }

  function itemKey(item) {
    return `${item.run_id}/${item.case_id}`;
  }

  function queueBanner(item) {
    if (!item) return "";
    return `
      <div class="queue-banner">
        <span>为什么要人看</span>
        <div>${item.reasons.map(reasonTag).join(" ")}</div>
        <a class="text-link" href="${item.source === "chat" ? `#/chat/${encodeURIComponent(item.conversation_id || "")}` : `#/run/${encodeURIComponent(item.run_id)}/${encodeURIComponent(item.case_id)}`}">在${item.source === "chat" ? "会话" : "所属运行"}里打开 →</a>
      </div>`;
  }

  function renderQueue() {
    const q = state.queue;
    const items = queueItems();
    const current = q.items.find((i) => itemKey(i) === state.queueSel) || null;
    const tab = (key, text, n) => `<button class="filter ${state.queueTab === key ? "is-active" : ""}" type="button" data-qtab="${key}">${text} <b>${n}</b></button>`;
    const reasons = Object.entries(q.reasons).map(([r, text]) => {
      const n = q.items.filter((i) => (state.queueTab === "pending" ? !i.reviewed : i.reviewed) && i.reasons.includes(r)).length;
      return n ? `<option value="${r}" ${state.queueReason === r ? "selected" : ""}>${escapeHtml(text)}（${n}）</option>` : "";
    }).join("");
    const list = items.map((i) => {
      const key = itemKey(i);
      return `
        <button type="button" class="case-item is-${verdictClass(i.verdict)} ${key === state.queueSel ? "is-selected" : ""}" data-qkey="${escapeHtml(key)}">
          <span class="case-item-top">
            <span class="case-id">${escapeHtml(suiteLabel(i.suite))}</span>
            <span class="verdict-pill ${verdictClass(i.verdict)}">${statusLabel(i.verdict)}</span>
          </span>
          <span class="case-title">${escapeHtml(i.title)}</span>
          <span class="case-bottom">
            ${reasonTag(i.reasons[0])}
            ${i.layer ? `<span class="layer-mini">${escapeHtml(i.layer)} ${escapeHtml(layerName(i.layer))}</span>` : ""}
          </span>
        </button>`;
    }).join("");
    let detail;
    if (!current) detail = placeholder(items.length ? "从左侧选一条开始复核" : "这里没有条目", state.queueTab === "pending" ? "队列清空后，新的失败与分歧会在下次运行后自动出现" : "");
    else if (!state.queueRow) detail = placeholder("正在读取 trace…");
    else detail = inspectorHtml(state.queueRow, state.queueRow.labels, { banner: queueBanner(current), next: state.queueTab === "pending" });

    view.innerHTML = `
      ${pageHead("待人工复核", "机器拿不准、或两条判定轨结论打架的样本。逐条确认「总判定」和「归因层」，结论写入 reviews/labels.jsonl，用来算人机一致性 κ。每条用例只看最近一次运行；注入样本根因已知，不进队列。")}
      <section class="workspace-grid queue-grid">
        <aside class="case-panel" aria-label="复核队列">
          <div class="filters" role="group" aria-label="复核状态">
            ${tab("pending", "待复核", q.pending)}${tab("reviewed", "已复核", q.reviewed)}
          </div>
          <select id="reasonSelect" class="dim-select" aria-label="按入队原因筛选"><option value="">全部原因</option>${reasons}</select>
          <div class="case-list">${list || '<div class="is-empty-state">没有条目。</div>'}</div>
        </aside>
        <section class="detail-panel" id="detailPanel">${detail}</section>
      </section>`;

    view.querySelectorAll("[data-qtab]").forEach((b) => b.addEventListener("click", () => {
      state.queueTab = b.dataset.qtab;
      state.queueReason = "";
      selectQueueItem(queueItems()[0] || null);
    }));
    $("#reasonSelect").addEventListener("change", (e) => {
      state.queueReason = e.target.value;
      selectQueueItem(queueItems()[0] || null);
    });
    view.querySelectorAll("[data-qkey]").forEach((b) => b.addEventListener("click", () => {
      selectQueueItem(q.items.find((i) => itemKey(i) === b.dataset.qkey));
    }));
    if (current && state.queueRow) {
      bindInspector($("#detailPanel"), state.queueRow, state.queueRow.labels, async () => {
        const before = queueItems();
        const at = before.findIndex((i) => itemKey(i) === state.queueSel);
        state.queue = await api("/api/queue");
        setQueueBadge(state.queue.pending);
        const after = queueItems();
        selectQueueItem(state.queueTab === "pending" ? (after[at] || after[after.length - 1] || null) : current);
      });
    }
  }

  async function selectQueueItem(item) {
    state.queueSel = item ? itemKey(item) : null;
    state.queueRow = null;
    history.replaceState(null, "", item ? queueHref(item) : "#/queue");
    renderQueue();
    if (!item) return;
    try {
      const row = await api(`/api/trace?run=${encodeURIComponent(item.run_id)}&case=${encodeURIComponent(item.case_id)}`);
      if (state.queueSel !== itemKey(item)) return; // 读取期间已切到别的条目
      state.queueRow = row;
      renderQueue();
    } catch (error) {
      showToast(error.message);
    }
  }

  // ------------------------------------------------------------ 审计结果（运行列表）

  function suiteOptions() {
    return (state.catalog?.suites || [])
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)} · ${s.cases} 条</option>`)
      .join("");
  }

  function renderRuns() {
    const sel = new Set(state.compareSel);
    const suite = state.runsSuite;
    const runs = state.runs.filter((r) => (suite ? r.suite === suite : r.source !== "chat"));
    const count = (id) => state.runs.filter((r) => r.suite === id).length;
    const chips = [
      `<button class="filter ${!suite ? "is-active" : ""}" type="button" data-suite="">全部用例运行 <b>${state.runs.filter((r) => r.source !== "chat").length}</b></button>`,
      ...(state.catalog?.suites || []).filter((s) => count(s.id)).map((s) => `<button class="filter ${suite === s.id ? "is-active" : ""}" type="button" data-suite="${escapeHtml(s.id)}">${escapeHtml(s.label)} <b>${count(s.id)}</b></button>`),
      count("chat") ? `<button class="filter ${suite === "chat" ? "is-active" : ""}" type="button" data-suite="chat">线上对话（按天） <b>${count("chat")}</b></button>` : "",
    ].join("");
    const rows = runs.map((r) => {
      const judge = r.llm_judge
        ? (r.judge_degraded ? `<span class="tag warn">降级 ${r.judge_degraded}</span>` : '<span class="tag ok">双轨</span>')
        : '<span class="tag">仅规则轨</span>';
      return `
        <tr>
          <td><input type="checkbox" class="cmp-box" data-run="${escapeHtml(r.run_id)}" ${sel.has(r.run_id) ? "checked" : ""} aria-label="选择 ${escapeHtml(r.run_id)} 用于对比"></td>
          <td><a class="run-link" href="#/run/${encodeURIComponent(r.run_id)}"><b>${escapeHtml(suiteLabel(r.suite))}</b><span class="mono">${escapeHtml(r.run_id)}</span></a></td>
          <td>${escapeHtml(formatTime(r.generated_at))}</td>
          <td>${escapeHtml(runLabel(r))}<div class="muted small">${escapeHtml(r.models.join(", "))}</div></td>
          <td class="num">${r.total}</td>
          <td class="num"><span class="pass-text">${r.pass}</span> / <span class="fail-text">${r.fail}</span>${r.skip ? ` / <span class="muted">${r.skip}</span>` : ""}</td>
          <td class="num"><b>${escapeHtml(scoreText(r))}</b></td>
          <td>${judge}</td>
        </tr>`;
    }).join("");

    view.innerHTML = `
      ${pageHead("审计结果", "每次运行把用例集跑一遍，落盘到 results/&lt;run_id&gt;/traces.jsonl。点运行看逐条判定与归因；勾选两次运行做门禁对比（先勾的当基线）。", {
        actions: `<button type="button" class="ghost-button" id="compareBtn" ${sel.size === 2 ? "" : "disabled"}>对比所选（${sel.size}/2）</button>`,
      })}

      <details class="panel launch-panel" ${state.runs.length ? "" : "open"}>
        <summary><b>发起一次运行</b><span class="muted small">只回放已录制的模型回复，不调用被测模型</span></summary>
        <div class="launch-form">
          <label><span>用例集</span><select id="suiteSelect">${suiteOptions()}</select></label>
          <label class="check-inline"><input type="checkbox" id="judgeToggle" checked> LLM 忠实度裁判${state.catalog?.judge_configured ? "" : "（未配置，只读缓存）"}</label>
          <button class="run-button" id="launchBtn" type="button" data-busy-disable>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 4.5v11l9-5.5-9-5.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
            <span>运行</span>
          </button>
        </div>
      </details>

      <section class="panel">
        <div class="filters suite-chips" role="group" aria-label="按用例集筛选">${chips}</div>
        ${runs.length ? `
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th></th><th>运行</th><th>时间</th><th>被测对象</th><th class="num">用例</th><th class="num">通过 / 失败</th><th class="num">可靠性分</th><th>判定方式</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : placeholder("还没有运行记录", "展开上方「发起一次运行」，或在命令行执行 python -m agentlens run")}
      </section>
    `;

    $("#launchBtn").addEventListener("click", launchRun);
    $("#compareBtn").addEventListener("click", () => {
      const [a, b] = state.compareSel;
      location.hash = `#/compare/${encodeURIComponent(a)}/${encodeURIComponent(b)}`;
    });
    view.querySelectorAll("[data-suite]").forEach((b) => b.addEventListener("click", () => {
      state.runsSuite = b.dataset.suite;
      renderRuns();
    }));
    view.querySelectorAll(".cmp-box").forEach((box) => box.addEventListener("change", () => {
      const id = box.dataset.run;
      state.compareSel = state.compareSel.filter((x) => x !== id);
      if (box.checked) state.compareSel = [...state.compareSel, id].slice(-2);
      renderRuns();
    }));
    setBusy(state.busy);
  }

  async function launchRun() {
    if (state.busy) return;
    setBusy(true);
    try {
      const result = await api("/api/run", {
        method: "POST",
        body: JSON.stringify({ suite: $("#suiteSelect").value, llm_judge: $("#judgeToggle").checked }),
      });
      showToast(`运行完成：${result.run_id}`);
      refreshQueueBadge();
      location.hash = `#/run/${encodeURIComponent(result.run_id)}`;
    } catch (error) {
      showToast(`运行失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------ 单次运行

  function rowsFiltered() {
    const { verdict, dimension, layer } = state.filter;
    return state.detail.rows.filter((row) => {
      if (verdict !== "all" && row.trace.verdict.rule !== verdict) return false;
      if (dimension && row.dimension !== dimension) return false;
      if (layer && row.trace.layer !== layer) return false;
      return true;
    });
  }

  function rowKey(row, index) {
    return `${row.trace.case_id}#${index}`;
  }

  function reviewProgress() {
    let need = 0;
    let done = 0;
    state.detail.rows.forEach((row) => {
      REVIEW_TARGETS.forEach((target) => {
        if (machineValue(row.trace, target) === null) return;
        need += 1;
        if (labelFor(state.detail.labels, row, target)) done += 1;
      });
    });
    return { need, done };
  }

  function heatmapHtml() {
    const hm = state.detail.heatmap;
    const max = Math.max(1, ...hm.dimensions.flatMap((d) => hm.layers.map((l) => hm.cells[d][l])));
    const colTotals = hm.layers.map((l) => hm.dimensions.reduce((s, d) => s + hm.cells[d][l], 0));
    const head = hm.layers.map((l) => `<th title="${escapeHtml(layerName(l))}">${escapeHtml(l)}<small>${escapeHtml(layerName(l))}</small></th>`).join("");
    const body = hm.dimensions.map((d) => {
      const total = hm.layers.reduce((s, l) => s + hm.cells[d][l], 0);
      const cells = hm.layers.map((l) => {
        const n = hm.cells[d][l];
        const active = state.filter.dimension === d && state.filter.layer === l;
        return n
          ? `<td><button type="button" class="hm-cell ${active ? "is-active" : ""}" data-dim="${escapeHtml(d)}" data-layer="${escapeHtml(l)}" style="--a:${(0.18 + 0.82 * n / max).toFixed(2)}" aria-label="${escapeHtml(dimensionLabel(d))} × ${escapeHtml(l)}：${n} 条" title="${escapeHtml(dimensionLabel(d))} × ${escapeHtml(l)}：${n} 条">${n}</button></td>`
          : `<td><span class="hm-zero">·</span></td>`;
      }).join("");
      return `<tr><th scope="row">${escapeHtml(dimensionLabel(d))}</th>${cells}<td class="num muted">${total || ""}</td></tr>`;
    }).join("");
    const foot = colTotals.map((n) => `<td class="num muted">${n || ""}</td>`).join("");
    return `
      <div class="heatmap-wrap">
        <table class="heatmap">
          <thead><tr><th></th>${head}<th class="num">合计</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><th scope="row">合计</th>${foot}<td></td></tr></tfoot>
        </table>
      </div>`;
  }

  function caseListHtml() {
    const rows = rowsFiltered();
    if (!rows.length) return `<div class="is-empty-state">这个筛选下没有用例。</div>`;
    return rows.map((row) => {
      const index = state.detail.rows.indexOf(row);
      const key = rowKey(row, index);
      const t = row.trace;
      const rule = verdictClass(t.verdict.rule);
      const selected = key === state.selectedCase;
      const labels = state.detail.labels;
      const reviewed = REVIEW_TARGETS.some((target) => labelFor(labels, row, target));
      const disagree = REVIEW_TARGETS.some((target) => labelFor(labels, row, target)?.agree === false);
      const layer = t.layer
        ? `<span class="layer-mini">${escapeHtml(t.layer)} ${escapeHtml(layerName(t.layer))}</span>`
        : `<span class="layer-mini is-empty">${rule === "pass" ? "无缺陷" : "—"}</span>`;
      return `
        <button type="button" class="case-item is-${rule} ${selected ? "is-selected" : ""}" data-case="${escapeHtml(key)}" aria-pressed="${selected}">
          <span class="case-item-top">
            <span class="case-id">${escapeHtml(t.case_id)}</span>
            <span class="verdict-pill ${rule}">${statusLabel(t.verdict.rule)}</span>
          </span>
          <span class="case-title">${escapeHtml(rowTitle(row))}</span>
          <span class="case-bottom">
            <span class="dimension">${escapeHtml(dimensionLabel(row.dimension))}</span>
            ${layer}
            ${reviewed ? `<span class="review-dot ${disagree ? "is-disagree" : ""}" title="${disagree ? "人工复核与机器结论不一致" : "已人工复核"}">${disagree ? "有异议" : "已复核"}</span>` : ""}
          </span>
        </button>`;
    }).join("");
  }

  function rateCell(r) {
    if (!r.n) return '<span class="muted">—</span>';
    const [lo, hi] = r.ci;
    return `<b>${r.k}/${r.n}</b> = ${r.rate.toFixed(1)}%<div class="muted small">95% CI ${lo}–${hi}</div>`;
  }

  // 故障注入用例的失败是注入的：这里给的是 AgentLens 自己的分数，不是被测对象的缺陷
  function calibrationHtml() {
    const c = state.detail.calibration;
    if (!c) return "";
    const rows = c.by_op.map((r) => `
      <tr>
        <td><span class="tag">${escapeHtml(r.layer)}</span> ${escapeHtml(layerName(r.layer))}</td>
        <td class="mono">${escapeHtml(r.op)}</td>
        <td class="num">${rateCell(r.detected)}</td>
        <td class="num">${rateCell(r.attributed)}</td>
      </tr>`).join("");
    return `
      <section class="panel calib-panel">
        <div class="panel-bar">
          <h2>故障注入校准 <span class="muted small">根因已知的注入样本：裁判能否发现、归因能否归对层</span></h2>
        </div>
        <div class="calib-kpis">
          <div class="kpi"><span>检出率（判定为 fail）</span><strong>${c.detected.rate == null ? "—" : c.detected.rate.toFixed(1) + "%"}</strong><small class="muted">${c.detected.k}/${c.detected.n}${c.detected.ci ? ` · CI ${c.detected.ci[0]}–${c.detected.ci[1]}` : ""}</small></div>
          <div class="kpi"><span>归因准确率（层 = 注入层）</span><strong>${c.attributed.rate == null ? "—" : c.attributed.rate.toFixed(1) + "%"}</strong><small class="muted">${c.attributed.k}/${c.attributed.n}${c.attributed.ci ? ` · CI ${c.attributed.ci[0]}–${c.attributed.ci[1]}` : ""}</small></div>
        </div>
        <div class="table-wrap">
          <table class="data-table">
            <thead><tr><th>注入层</th><th>算子</th><th class="num">检出率</th><th class="num">归因准确率</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        <p class="case-note">这批失败由注入产生，不计入被测对象缺陷。录制变异的算子与归因分支一一对应，高分只说明决策顺序自洽；归因在真实缺陷上的准确率以人工复核 κ 为准。</p>
      </section>`;
  }

  function selectedRow() {
    const rows = state.detail.rows;
    const index = rows.findIndex((row, i) => rowKey(row, i) === state.selectedCase);
    return index < 0 ? null : rows[index];
  }

  function renderRun() {
    const d = state.detail;
    const s = d.summary;
    const progress = reviewProgress();
    const dims = d.heatmap.dimensions.map((id) => `<option value="${escapeHtml(id)}" ${state.filter.dimension === id ? "selected" : ""}>${escapeHtml(dimensionLabel(id))}</option>`).join("");
    const counts = { all: d.rows.length, fail: s.fail, pass: s.pass, skip: s.skip };
    const filterBtn = (key, text) => `<button class="filter ${state.filter.verdict === key ? "is-active" : ""}" type="button" data-verdict="${key}">${text} <b>${counts[key]}</b></button>`;
    const narrowing = state.filter.dimension || state.filter.layer;
    // 整批都是注入用例时，失败是造出来的，可靠性分没有意义
    const calibOnly = Boolean(d.calibration) && d.calibration.detected.n === d.rows.length;
    const row = selectedRow();
    const suite = s.source === "chat" ? "chat" : s.suite;

    view.innerHTML = `
      ${pageHead(`${escapeHtml(suiteLabel(suite))}`, `${escapeHtml(runLabel(s))} · ${escapeHtml(formatTime(s.generated_at))} · 模型 ${escapeHtml(s.models.join(", "))} · ${s.llm_judge ? "双轨判定（规则 + LLM 忠实度）" : "仅规则轨"}`, {
        crumbs: `<a href="#/runs">审计结果</a> / <span class="mono">${escapeHtml(s.run_id)}</span>`,
      })}

      <section class="kpi-strip">
        <div class="kpi"><span>可靠性分</span><strong>${calibOnly ? '—<small> 注入集不计分</small>' : s.score.toFixed(1)}</strong></div>
        <div class="kpi"><span>通过</span><strong class="pass-text">${s.pass}</strong></div>
        <div class="kpi"><span>失败</span><strong class="fail-text">${s.fail}</strong></div>
        ${s.skip ? `<div class="kpi"><span>跳过</span><strong>${s.skip}</strong></div>` : ""}
        <div class="kpi"><span>人工复核进度</span><strong>${progress.done}<small> / ${progress.need}</small></strong></div>
      </section>

      ${calibrationHtml()}

      ${s.fail ? `
      <section class="panel">
        <div class="panel-bar">
          <h2>缺陷分布 <span class="muted small">行 = 测试维度，列 = 归因层；点格子筛出那几条用例</span></h2>
          ${narrowing ? '<button type="button" class="ghost-button" id="clearFilter">清除筛选</button>' : ""}
        </div>
        ${heatmapHtml()}
      </section>` : ""}

      <section class="workspace-grid">
        <aside class="case-panel" aria-label="用例清单">
          <div class="filters" role="group" aria-label="按判定筛选">
            ${filterBtn("all", "全部")}${filterBtn("fail", "失败")}${filterBtn("pass", "通过")}${s.skip ? filterBtn("skip", "跳过") : ""}
          </div>
          <select id="dimSelect" class="dim-select" aria-label="按维度筛选"><option value="">全部维度</option>${dims}</select>
          <div class="case-list" id="caseList">${caseListHtml()}</div>
        </aside>
        <section class="detail-panel" id="detailPanel">${row ? inspectorHtml(row, d.labels) : placeholder("从左侧选择一条用例")}</section>
      </section>
    `;
    bindRunEvents(row);
  }

  function selectFirstVisible() {
    const rows = rowsFiltered();
    const keys = rows.map((row) => rowKey(row, state.detail.rows.indexOf(row)));
    if (!keys.includes(state.selectedCase)) state.selectedCase = keys[0] || null;
  }

  function bindRunEvents(row) {
    view.querySelectorAll("[data-verdict]").forEach((btn) => btn.addEventListener("click", () => {
      state.filter.verdict = btn.dataset.verdict;
      selectFirstVisible();
      renderRun();
    }));
    $("#dimSelect").addEventListener("change", (e) => {
      state.filter.dimension = e.target.value;
      state.filter.layer = "";
      selectFirstVisible();
      renderRun();
    });
    view.querySelectorAll(".hm-cell").forEach((cell) => cell.addEventListener("click", () => {
      const same = state.filter.dimension === cell.dataset.dim && state.filter.layer === cell.dataset.layer;
      state.filter = { verdict: "all", dimension: same ? "" : cell.dataset.dim, layer: same ? "" : cell.dataset.layer };
      selectFirstVisible();
      renderRun();
    }));
    $("#clearFilter")?.addEventListener("click", () => {
      state.filter = { verdict: "all", dimension: "", layer: "" };
      selectFirstVisible();
      renderRun();
    });
    $("#caseList").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-case]");
      if (!btn) return;
      state.selectedCase = btn.dataset.case;
      renderRun();
      if (window.innerWidth < 821) $("#detailPanel").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    if (row) bindInspector($("#detailPanel"), row, state.detail.labels, renderRun);
  }

  // ------------------------------------------------------------ 运行对比

  function sideCell(side, field) {
    if (!side) return '<td class="muted">—</td>';
    if (field === "verdict") return `<td><span class="verdict-pill ${verdictClass(side.verdict)}">${statusLabel(side.verdict)}</span></td>`;
    if (field === "layer") return `<td>${side.layer ? escapeHtml(side.layer) : '<span class="muted">—</span>'}</td>`;
    if (side.llm === null || side.llm === undefined) return '<td class="muted">—</td>';
    return `<td>${side.llm ? "忠实" : '<span class="fail-text">不忠实</span>'}${side.llm_score ? ` <span class="muted small">${side.llm_score}/5</span>` : ""}</td>`;
  }

  const GATE_STATES = {
    regressed: "新增失败", fixed: "已修复", relayered: "仍失败·换层", still_failing: "仍失败",
    still_passing: "仍通过", added: "新增用例", removed: "移除用例",
  };

  // 把 A 当基线、B 当本次：门禁结论与命令行 `agentlens compare A B` 完全一致（同一个 audit.gate）
  function gateHtml(g) {
    const n = g.counts;
    const ms = (v) => (v == null ? "—" : `${Math.round(v)}ms`);
    const change = g.perf.p90_change == null ? "" : ` <small>${g.perf.p90_change >= 0 ? "+" : ""}${(g.perf.p90_change * 100).toFixed(0)}%</small>`;
    return `
      <section class="panel gate-panel ${g.passed ? "is-pass" : "is-fail"}">
        <div class="panel-bar">
          <h2>基线门禁：<span class="${g.passed ? "pass-text" : "fail-text"}">${g.passed ? "放行" : "拦截"}</span>
            <span class="muted small">A 为基线、B 为本次；只比两侧都有的 ${g.common} 条用例</span></h2>
        </div>
        ${g.reasons.length ? `<p class="fail-text">${g.reasons.map(escapeHtml).join("；")}</p>` : ""}
        <div class="gate-kpis">
          <div class="kpi"><span>新增失败</span><strong class="${n.regressed ? "fail-text" : ""}">${n.regressed}</strong></div>
          <div class="kpi"><span>已修复</span><strong class="${n.fixed ? "pass-text" : ""}">${n.fixed}</strong></div>
          <div class="kpi"><span>仍失败</span><strong>${n.still_failing + n.relayered}</strong><small class="muted">其中换层 ${n.relayered}</small></div>
          <div class="kpi"><span>McNemar p</span><strong>${g.mcnemar_p}</strong><small class="muted">${g.mcnemar_p < 0.05 ? "变化显著" : "不足以说明不是偶然"}</small></div>
          <div class="kpi"><span>p90 耗时</span><strong>${ms(g.perf.cur.p90_ms)}${change}</strong><small class="muted">基线 ${ms(g.perf.base.p90_ms)}</small></div>
        </div>
        ${n.added || n.removed ? `<p class="case-note">另有新增用例 ${n.added} 条、移除用例 ${n.removed} 条，不计入门禁结论。</p>` : ""}
      </section>`;
  }

  function renderCompare() {
    const c = state.compare;
    const items = state.compareOnlyChanged ? c.items.filter((i) => i.changes.length) : c.items;
    const chips = Object.entries(c.counts).map(([k, n]) => `<span class="tag warn">${escapeHtml(k)} ${n}</span>`).join("") || '<span class="tag ok">无变化</span>';
    const head = (s, tag) => `
      <div class="cmp-side">
        <span class="cmp-tag">${tag}</span>
        <a class="mono" href="#/run/${encodeURIComponent(s.run_id)}">${escapeHtml(s.run_id)}</a>
        <div class="muted small">${escapeHtml(runLabel(s))} · ${escapeHtml(formatTime(s.generated_at))} · ${s.total} 条</div>
        <strong>${s.score.toFixed(1)}</strong>
      </div>`;
    const delta = (c.b.score - c.a.score).toFixed(1);
    const stateOf = Object.fromEntries(c.gate.items.map((g) => [g.case_id, g.state]));
    const stateTag = (id) => {
      const st = stateOf[id];
      if (!st || st === "still_passing") return "";
      const cls = st === "regressed" ? "bad" : st === "fixed" ? "ok" : "warn";
      return `<span class="tag ${cls}">${GATE_STATES[st]}</span> `;
    };
    const rows = items.map((i) => `
      <tr class="${i.changes.length ? "is-changed" : ""}">
        <td class="mono">${i.b ? `<a href="#/run/${encodeURIComponent(c.b.run_id)}/${encodeURIComponent(i.case_id)}">${escapeHtml(i.case_id)}</a>` : escapeHtml(i.case_id)}</td>
        <td>${escapeHtml(dimensionLabel(i.dimension))}</td>
        ${sideCell(i.a, "verdict")}${sideCell(i.a, "layer")}${sideCell(i.a, "llm")}
        ${sideCell(i.b, "verdict")}${sideCell(i.b, "layer")}${sideCell(i.b, "llm")}
        <td>${stateTag(i.case_id)}${i.changes.map((x) => `<span class="tag warn">${escapeHtml(x)}</span>`).join(" ")}</td>
      </tr>`).join("");
    view.innerHTML = `
      ${pageHead("运行对比", "按用例对齐两次运行，标出判定、归因、LLM 结论与执行内容的变化；门禁结论与命令行 agentlens compare 一致。", {
        crumbs: '<a href="#/runs">审计结果</a> / 对比',
      })}
      <section class="panel cmp-head">
        ${head(c.a, "A")}
        <div class="cmp-delta"><span>B − A</span><strong class="${delta >= 0 ? "pass-text" : "fail-text"}">${delta >= 0 ? "+" : ""}${delta}</strong><div>${chips}</div></div>
        ${head(c.b, "B")}
      </section>
      ${gateHtml(c.gate)}
      <section class="panel">
        <div class="panel-bar">
          <h2>${c.changed} 条用例有变化 <span class="muted small">共 ${c.items.length} 条</span></h2>
          <label class="check-inline"><input type="checkbox" id="onlyChanged" ${state.compareOnlyChanged ? "checked" : ""}> 只看有变化的</label>
        </div>
        <div class="table-wrap">
          <table class="data-table cmp-table">
            <thead>
              <tr><th rowspan="2">用例</th><th rowspan="2">维度</th><th colspan="3">A</th><th colspan="3">B</th><th rowspan="2">变化</th></tr>
              <tr><th>判定</th><th>归因</th><th>LLM</th><th>判定</th><th>归因</th><th>LLM</th></tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="9" class="muted">两次运行没有差异。</td></tr>'}</tbody>
          </table>
        </div>
      </section>`;
    $("#onlyChanged").addEventListener("change", (e) => {
      state.compareOnlyChanged = e.target.checked;
      renderCompare();
    });
  }

  // ------------------------------------------------------------ 复核一致性

  function kappaLabel(k) {
    if (k === null || k === undefined) return "样本不足";
    if (k < 0) return "低于随机";
    if (k < 0.21) return "轻微一致";
    if (k < 0.41) return "一般一致";
    if (k < 0.61) return "中等一致";
    if (k < 0.81) return "高度一致";
    return "几乎完全一致";
  }

  function labelHref(lb) {
    if (lb.run_id.startsWith("chat-")) {
      const cid = lb.case_id.split("#")[0];
      return `#/chat/${encodeURIComponent(cid)}`;
    }
    return `#/run/${encodeURIComponent(lb.run_id)}/${encodeURIComponent(lb.case_id)}`;
  }

  function renderReviews() {
    const r = state.reviews;
    const cards = Object.entries(r.targets).map(([, s]) => `
      <article class="panel stat-card">
        <h2>${escapeHtml(s.name)}</h2>
        <div class="stat-line">
          <div><span>样本</span><strong>${s.n}</strong></div>
          <div><span>一致率</span><strong>${s.rate === null ? "—" : `${s.rate}%`}</strong></div>
          <div><span>Cohen's κ</span><strong>${s.kappa === null ? "—" : s.kappa.toFixed(2)}</strong></div>
        </div>
        <p class="muted small">${escapeHtml(kappaLabel(s.kappa))}${s.n && s.n < 30 ? " · 样本少于 30，结论仅供参考" : ""}</p>
      </article>`).join("");
    const rows = r.labels.map((lb) => `
      <tr class="${lb.agree ? "" : "is-changed"}">
        <td>${escapeHtml(formatTime(lb.at))}</td>
        <td class="mono"><a href="${labelHref(lb)}">${escapeHtml(lb.case_id)}</a></td>
        <td>${escapeHtml(state.catalog.review_targets[lb.target] || lb.target)}</td>
        <td>${escapeHtml(valueLabel(lb.target, lb.machine))}</td>
        <td>${escapeHtml(valueLabel(lb.target, lb.human))}</td>
        <td>${lb.agree ? '<span class="tag ok">一致</span>' : '<span class="tag warn">不一致</span>'}</td>
        <td>${escapeHtml(lb.reviewer || "")}</td>
        <td>${escapeHtml(lb.note || "")}</td>
      </tr>`).join("");
    view.innerHTML = `
      ${pageHead("复核一致性", "机器结论与人工复核的一致率和 Cohen's κ：这是归因在真实缺陷上到底准不准的唯一证据。同一 trace 同一目标只取最后一次标注。", {
        actions: '<a class="run-button" href="#/queue">去复核队列</a>',
      })}
      <section class="stat-grid">${cards}</section>
      <section class="panel">
        <div class="panel-bar"><h2>标注明细 <span class="muted">${r.labels.length}</span></h2></div>
        ${r.labels.length ? `
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>时间</th><th>用例</th><th>目标</th><th>机器</th><th>人工</th><th>一致</th><th>复核人</th><th>备注</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : placeholder("还没有人工标注", "到「待人工复核」逐条确认机器结论")}
      </section>`;
  }

  // ------------------------------------------------------------ router

  function setNav(name) {
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("is-active", a.dataset.nav === name));
  }

  async function route() {
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    const [page, a, b] = parts;
    try {
      if (page === "run" && a) {
        setNav(a.startsWith("chat-") ? "chats" : "runs");
        if (state.detail?.summary.run_id !== a) {
          view.innerHTML = a.startsWith("chat-")
            ? placeholder("正在读取线上对话并逐条判定…", "未判定过的对话需要调用裁判模型，首次打开可能要几十秒")
            : placeholder("正在读取运行…");
          state.detail = await api(`/api/runs/${encodeURIComponent(a)}`);
          state.filter = { verdict: "all", dimension: "", layer: "" };
          state.selectedCase = null;
        }
        if (b) {
          const index = state.detail.rows.findIndex((row) => row.trace.case_id === b);
          if (index >= 0) state.selectedCase = rowKey(state.detail.rows[index], index);
        }
        if (!state.selectedCase) {
          const rows = state.detail.rows;
          const firstFail = rows.findIndex((row) => row.trace.verdict.rule === "fail");
          const index = firstFail >= 0 ? firstFail : 0;
          state.selectedCase = rows.length ? rowKey(rows[index], index) : null;
        }
        renderRun();
      } else if (page === "compare" && a && b) {
        setNav("runs");
        view.innerHTML = placeholder("正在对比…");
        state.compare = await api(`/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
        renderCompare();
      } else if (page === "chats") {
        setNav("chats");
        view.innerHTML = placeholder("正在读取线上对话…");
        state.chats = (await api("/api/chats")).conversations;
        renderChats();
      } else if (page === "chat" && a) {
        setNav("chats");
        if (state.chat?.conversation_id !== a) {
          view.innerHTML = placeholder("正在读取会话并判定…", "未判定过的轮次需要调用裁判模型，可能要十几秒");
          state.chat = await api(`/api/chats/${encodeURIComponent(a)}`);
        }
        const turn = Number(b);
        state.selectedTurn = turn >= 1 ? turn - 1 : Math.max(0, state.chat.rows.findIndex((r) => r.trace.verdict.rule === "fail"));
        renderChat();
      } else if (page === "queue") {
        setNav("queue");
        view.innerHTML = placeholder("正在整理复核队列…");
        state.queue = await api("/api/queue");
        setQueueBadge(state.queue.pending);
        const wanted = a && b ? `${a}/${b}` : null;
        let item = state.queue.items.find((i) => itemKey(i) === wanted);
        if (item) state.queueTab = item.reviewed ? "reviewed" : "pending";
        else item = queueItems()[0] || null;
        await selectQueueItem(item);
      } else if (page === "reviews") {
        setNav("reviews");
        state.reviews = await api("/api/reviews");
        renderReviews();
      } else if (page === "runs") {
        setNav("runs");
        state.runs = (await api("/api/runs")).runs;
        state.detail = null;
        renderRuns();
      } else {
        setNav("overview");
        view.innerHTML = placeholder("正在汇总最新审计…");
        state.overview = await api("/api/overview");
        setQueueBadge(state.overview.queue.pending);
        renderOverview();
      }
      window.scrollTo({ top: 0 });
    } catch (error) {
      view.innerHTML = placeholder("加载失败", error.message);
      showToast(error.message);
    }
  }

  async function boot() {
    try {
      reviewerInput.value = window.localStorage.getItem("agentlens.reviewer") || "";
    } catch {
      /* 隐私模式下 localStorage 不可用：复核人每次手填 */
    }
    reviewerInput.addEventListener("change", () => {
      try {
        window.localStorage.setItem("agentlens.reviewer", reviewer());
      } catch {
        /* 同上 */
      }
    });
    try {
      state.catalog = await api("/api/catalog");
    } catch (error) {
      view.innerHTML = placeholder("页面没能连上本地审计服务", error.message);
      return;
    }
    window.addEventListener("hashchange", route);
    route();
    refreshQueueBadge();
  }

  boot();
})();
