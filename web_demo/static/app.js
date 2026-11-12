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
    queueTab: "pending", // pending / discuss / reviewed
    reviewDrafts: {}, // 复核草稿，按 run_id/case_id
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
    library: "馆藏助手（接入示例）",
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

  // 列表预览用的纯文本：去掉 Markdown 表格分隔线、竖线、加粗和标题符号
  function mdPlain(text) {
    return String(text || "")
      .split("\n")
      .filter((line) => !/^\s*\|?[\s:|-]+\|?\s*$/.test(line))
      .map((line) => line.replace(/^\s*[-*]\s+/, ""))
      .join(" ")
      .replace(/\*\*|`|^#+\s*/gm, "")
      .replace(/\s*\|\s*/g, " ")
      .replace(/\s+/g, " ")
      .trim();
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
    if (target === "disposition") return state.catalog.dispositions?.[value] || value;
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

  function messagesHtml(row) {
    const recorded = rowMessages(row);
    if (!recorded.length) return '<p class="case-note">这条对话产生于记录用户输入之前，原始问题已无法还原；回答与执行链路仍可审计。</p>';
    return recorded.map((m) => `
      <div class="question ${m.role === "assistant" ? "is-assistant" : ""}">
        <span class="question-label">${m.role === "assistant" ? "智能体（历史）" : "用户"}</span>
        <p>${escapeHtml(m.content)}</p>
      </div>`).join("");
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
          <b>${c.real_account ? '<span class="tag warn" title="真实账号的对话含本人真实数据，只留本地">真实账号</span> ' : ""}${escapeHtml(c.title ? clip(c.title, 60) : "（未记录用户输入）")}</b>
          <small>${escapeHtml(clip(mdPlain(c.last_answer), 90))}</small>
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
        <div class="turn ${i === sel ? "is-selected" : ""} is-${rule}" data-turn="${i}" role="button" tabindex="0" aria-pressed="${i === sel}">
          <span class="turn-no">第 ${escapeHtml(t.turn || i + 1)} 轮</span>
          ${question ? `<span class="bubble user">${escapeHtml(question)}</span>` : '<span class="bubble user is-missing">（未记录用户输入）</span>'}
          <div class="bubble agent md-bubble ${i === sel ? "" : "is-clamped"}">${t.answer ? renderAnswer(t.answer, []).html : '<p class="muted">（无回答）</p>'}</div>
          <span class="turn-foot">
            <span class="verdict-pill ${rule}">${statusLabel(t.verdict.rule)}</span>
            ${t.layer ? `<span class="layer-mini">${escapeHtml(t.layer)} ${escapeHtml(layerName(t.layer))}</span>` : ""}
            ${t.verdict.judge_degraded ? '<span class="layer-mini is-empty">未判定</span>' : ""}
            <span class="muted small">${escapeHtml(latencyLabel(t.latency_ms))}</span>
          </span>
        </div>`;
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
        <section class="detail-panel" id="detailPanel">${auditPanelHtml(itemFromRow(rows[sel], c.labels), rows[sel], { inPlace: true, compact: true })}</section>
      </section>`;
    const openTurn = (b) => {
      state.selectedTurn = Number(b.dataset.turn);
      history.replaceState(null, "", `#/chat/${encodeURIComponent(c.conversation_id)}/${state.selectedTurn + 1}`);
      renderChat();
      $(`[data-turn="${state.selectedTurn}"]`)?.focus({ preventScroll: true });
    };
    // 轮次里有渲染后的回答（含表格），不能放进 <button>，用 role=button 的 div 并补上键盘操作
    view.querySelectorAll("[data-turn]").forEach((b) => {
      b.addEventListener("click", () => openTurn(b));
      b.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openTurn(b);
        }
      });
    });
    state.audit = null;
    bindAudit(itemFromRow(rows[sel], c.labels), rows[sel], {
      opts: { inPlace: true, compact: true },
      onSaved: (records) => { mergeLabels(c.labels, records); renderChat(); },
    });
  }

  // ------------------------------------------------------------ 待人工复核（复核工作台）
  //
  // 三栏：左边队列（同一基准用例的几种说法归一组）→ 中间卷宗（期望 vs 实际、回答高亮、裁判意见、链路）
  // → 右边判断面板（先定「这条失败站不站得住」，再定归因层与裁判对错）。键盘：J/K 上下条、A 全部同意机器、
  // 1–5 选复核结论、Enter 提交、S 跳过。

  const VARIANT_LABELS = { asr: "语音转写", colloquial: "口语", verbose: "啰嗦", indirect: "间接问法" };

  const REASON_SHORT = { conflict: "两轨冲突", llm_only: "仅 LLM 发现", uncertain: "归因待定", failure: "规则轨失败", unjudged: "未经裁判" };

  const REASON_GUIDE = {
    conflict: "规则轨判失败（答案里出现了不该出现的内容，或缺了该有的内容），LLM 裁判却认为回答忠实。看回答：是智能体真答错了，还是用例要求太严？",
    llm_only: "规则轨全部通过，只有 LLM 裁判指出问题。逐条核对裁判列出的问题是否属实，尤其是它给的「正确值」。",
    uncertain: "归因器没能把失败定到某一层。看链路，判断根因在哪一层。",
    failure: "规则轨判失败。确认失败成立，以及机器给的归因层对不对。",
    unjudged: "LLM 裁判没判（无缓存也未配置），只有规则轨结论。",
  };

  const DISPOSITION_HELP = {
    agent_defect: "失败成立，是被测智能体的问题",
    case_too_strict: "智能体其实答对了，是用例的断言写得过严",
    judge_wrong: "LLM 裁判指出的问题不成立",
    case_invalid: "改写跑偏了原意，或期望本身写错，这条不该参与评判",
    unsure: "先放进「待讨论」，回头再定",
  };

  const LAYER_HELP = {
    L0: "超时、异常、不可达",
    L1: "没计划、计划与执行脱节、多余调用",
    L2: "选错了工具",
    L3: "参数填错、学期口径错",
    L4: "数据拿对了，回答说错 / 算错",
    L5: "照实转述，但数据源或召回本身错",
    L6: "该拒没拒，或误拒",
  };

  function variantLabel(item) {
    if (item.source === "chat") return "线上对话";
    return item.variant ? VARIANT_LABELS[item.variant] || item.variant : "基准";
  }

  function familyTitle(item) {
    return String(item.title || "").replace(/^\[改写·[a-z]+\]\s*/, "");
  }

  function dispositionLabel(value) {
    return state.catalog.dispositions?.[value] || value;
  }

  function queueItems() {
    const q = state.queue;
    const tab = state.queueTab;
    return q.items.filter((i) => (tab === "pending" ? !i.reviewed && !i.discuss : tab === "discuss" ? i.discuss : i.reviewed)
      && (!state.queueReason || i.reasons.includes(state.queueReason)));
  }

  function itemKey(item) {
    return `${item.run_id}/${item.case_id}`;
  }

  // 同组、未复核、失败方式完全相同（失败检查项、机器归因层、LLM 结论都一样）的其他说法：可一并沿用本条结论
  function batchPeers(item) {
    const sig = (i) => JSON.stringify([i.failed_checks, i.machine]);
    return state.queue.items.filter((i) => i !== item && i.family === item.family && i.source === item.source
      && !i.reviewed && sig(i) === sig(item));
  }

  // ---------------------------------------------------- 卷宗：期望 vs 实际

  function constraintText(name, c) {
    if (c.equals !== null && c.equals !== undefined) return `${name} = ${formatValue(c.equals)}`;
    if (c.in) return `${name} ∈ {${c.in.map(formatValue).join(", ")}}`;
    if (c.regex) return `${name} ~ /${c.regex}/`;
    const range = [c.gte != null ? `≥ ${c.gte}` : "", c.lte != null ? `≤ ${c.lte}` : ""].filter(Boolean).join(" 且 ");
    return range ? `${name} ${range}` : name;
  }

  function expectationFor(check, expect, judgement) {
    const tools = (expect.tools || []).map((t) => `${t.name}${t.optional ? "（可选）" : ""}`);
    switch (check) {
      case "status": return "执行正常完成";
      case "refusal": return expect.refusal === true ? "应当拒答" : expect.refusal === false ? "不应拒答" : "不判";
      case "tool_sequence":
        return tools.length ? `${expect.mode === "exact" ? "恰好调用" : "至少包含"} ${tools.join(" → ")}` : (expect.mode === "exact" ? "不调用任何工具" : "不限");
      case "forbidden_tools": return `不得调用 ${(expect.forbid_tools || []).join("、")}`;
      case "tool_args": {
        const parts = (expect.tools || []).flatMap((t) => Object.entries(t.args || {}).map(([k, c]) => `${t.name}.${constraintText(k, c)}`));
        return parts.join("；") || "—";
      }
      case "tool_schema": return "参数通过工具 schema 校验";
      case "plan": return "计划的工具与实际执行一致";
      case "answer_text": {
        const parts = [];
        if ((expect.answer_contains || []).length) parts.push(`必须出现：${expect.answer_contains.join("、")}`);
        if ((expect.answer_not_contains || []).length) parts.push(`不得出现：${expect.answer_not_contains.join("、")}`);
        return parts.join("；") || "—";
      }
      case "budget": {
        const b = expect.budget || {};
        return [b.latency_ms ? `耗时 ≤ ${b.latency_ms}ms` : "", b.tokens ? `token ≤ ${b.tokens}` : "", b.tool_calls != null ? `工具调用 ≤ ${b.tool_calls} 次` : ""].filter(Boolean).join("；");
      }
      case "llm_faithfulness": {
        const rubric = expect.rubric || judgement?.rubric;
        return `回答忠实于观测${rubric ? `；额外要求：${rubric}` : ""}`;
      }
      default: return "—";
    }
  }

  function checksTable(row) {
    const checks = row.trace.verdict?.checks || [];
    if (!checks.length) return '<p class="muted">没有检查记录（跳过）。</p>';
    const expect = row.case?.expect || {};
    const body = checks.map((c) => `
      <tr class="${c.passed ? "" : "is-bad"}">
        <td class="rv-mark">${c.passed ? "✓" : "✗"}</td>
        <td><b>${escapeHtml(CHECK_LABELS[c.check] || c.check)}</b><span class="rv-track ${c.check === "llm_faithfulness" ? "llm" : ""}">${c.check === "llm_faithfulness" ? "语义轨" : "规则轨"}</span></td>
        <td>${row.case || c.check === "llm_faithfulness" || c.check === "status" ? escapeHtml(expectationFor(c.check, expect, row.judgement)) : '<span class="muted">线上对话无预设期望</span>'}</td>
        <td>${c.check === "llm_faithfulness" && row.judgement?.verdict ? `${c.passed ? "判忠实" : "判不忠实"}（评分 ${escapeHtml(row.judgement.verdict.score)}/5），逐条意见见下方「LLM 裁判意见」` : escapeHtml(c.reason)}${evidenceLinks(c.evidence) ? `<div class="rv-links">${evidenceLinks(c.evidence)}</div>` : ""}</td>
      </tr>`).join("");
    return `
      <div class="table-wrap">
        <table class="rv-table">
          <thead><tr><th></th><th>检查项</th><th>期望</th><th>实际</th></tr></thead>
          <tbody>${body}</tbody>
        </table>
      </div>`;
  }

  // ---------------------------------------------------- 卷宗：回答（Markdown + 高亮）

  // 先转义、再用私有区字符占位高亮词、再做极简 Markdown，最后把占位换成 <mark>：高亮不会被 Markdown 拆坏
  function renderAnswer(text, marks) {
    let src = escapeHtml(text || "");
    const used = [];
    marks.forEach(({ term, cls, title }) => {
      const t = escapeHtml(term);
      if (!t || !src.includes(t) || used.some((u) => u.t === t)) return;
      const id = used.length;
      used.push({ t, cls, title });
      src = src.split(t).join(`\uE000${id}\uE001`);
    });
    const inline = (s) => s
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    const lines = src.split("\n");
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*\|.*\|\s*$/.test(line)) {
        const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
        const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));
        const isSep = (r) => /^\s*\|?[\s:|-]+\|?\s*$/.test(r);
        const head = rows[0];
        const bodyRows = rows.slice(isSep(rows[1] || "") ? 2 : 1);
        out.push(`<div class="table-wrap"><table class="rv-md-table"><thead><tr>${cells(head).map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${bodyRows.map((r) => `<tr>${cells(r).map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
        const ordered = /^\s*\d+\./.test(line);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        out.push(`<${ordered ? "ol" : "ul"}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
        continue;
      }
      if (/^#{1,6}\s+/.test(line)) {
        out.push(`<p class="rv-md-h">${inline(line.replace(/^#{1,6}\s+/, ""))}</p>`);
      } else if (line.trim()) {
        out.push(`<p>${inline(line)}</p>`);
      }
      i += 1;
    }
    const html = out.join("").replace(/\uE000(\d+)\uE001/g, (_, id) => {
      const m = used[Number(id)];
      return `<mark class="${m.cls}" title="${escapeHtml(m.title)}">${m.t}</mark>`;
    });
    return { html, used: new Set(used.map((u) => u.cls)) };
  }

  // 裁判引用的原话常和回答差几个 Markdown 符号（如 **88.9**）：整句对不上时，退而高亮其中的小数和三位以上的数字
  function claimTerms(claim, answer) {
    if (answer.includes(claim)) return [claim];
    return (claim.match(/\d+\.\d+|\d{3,}/g) || []).filter((n) => answer.includes(n));
  }

  function answerBlock(row) {
    const t = row.trace;
    const expect = row.case?.expect || {};
    const issues = row.judgement?.verdict?.issues || [];
    const marks = [
      ...(expect.answer_not_contains || []).filter((w) => (t.answer || "").includes(w)).map((w) => ({ term: w, cls: "hl-bad", title: "用例要求不得出现" })),
      ...(expect.answer_contains || []).map((w) => ({ term: w, cls: "hl-ok", title: "用例要求必须出现" })),
      ...issues.map((it) => (typeof it === "string" ? null : it?.claim)).filter((c) => c && c.length <= 60)
        .flatMap((c) => claimTerms(c, t.answer || "")).map((c) => ({ term: c, cls: "hl-claim", title: "LLM 裁判指出的问题" })),
    ];
    const rendered = t.answer ? renderAnswer(t.answer, marks) : null;
    const missing = (expect.answer_contains || []).filter((w) => !(t.answer || "").includes(w));
    const used = rendered?.used || new Set();
    const legend = [
      used.has("hl-bad") ? '<span><mark class="hl-bad">　</mark>不得出现却出现了</span>' : "",
      used.has("hl-ok") ? '<span><mark class="hl-ok">　</mark>要求出现</span>' : "",
      used.has("hl-claim") ? '<span><mark class="hl-claim">　</mark>裁判指出的问题</span>' : "",
    ].filter(Boolean).join("");
    return `
      <div class="rv-answer">${rendered ? rendered.html : '<p class="muted">（无回答）</p>'}</div>
      ${missing.length ? `<p class="rv-missing">要求出现但回答里没有：${missing.map((w) => `<code>${escapeHtml(w)}</code>`).join(" ")}</p>` : ""}
      ${legend ? `<div class="rv-legend">${legend}</div>` : ""}`;
  }

  function judgementBlock(row) {
    const check = (row.trace.verdict?.checks || []).find((c) => c.check === "llm_faithfulness");
    if (!check) return '<p class="muted">这条没有经过 LLM 裁判（拒答、未完成，或没有可对照的观测）。</p>';
    const j = row.judgement;
    const verdict = j?.verdict;
    const head = `
      <div class="rv-judge-head">
        <span class="rv-verdict ${check.passed ? "ok" : "bad"}">${check.passed ? "判忠实" : "判不忠实"}</span>
        ${verdict?.score != null ? `<span class="rv-score">评分 <b>${escapeHtml(verdict.score)}</b> / 5</span>` : ""}
        ${j ? `<span class="muted small">${escapeHtml(j.model || "")} · ${escapeHtml(j.prompt_version || "")}</span>` : ""}
      </div>`;
    if (!verdict) return `${head}<p class="muted">${escapeHtml(check.reason)}（裁判缓存未找到，看不到逐条意见）</p>`;
    const issues = (verdict.issues || []).map((it) => {
      if (typeof it === "string") return `<li><p>${escapeHtml(it)}</p></li>`;
      return `
        <li>
          ${it.claim ? `<blockquote>${escapeHtml(it.claim)}</blockquote>` : ""}
          <p>${escapeHtml(it.problem || "")}</p>
          ${it.span ? `<div class="rv-links">${evidenceLinks([it.span])}</div>` : ""}
        </li>`;
    }).join("");
    return `${head}${issues ? `<ol class="rv-issues">${issues}</ol>` : '<p class="muted">裁判没有指出问题。</p>'}`;
  }

  // peers：同一基准用例的其他说法（队列里取队列条目，运行页里取同一次运行的用例）
  function familyBlock(peers) {
    if (!peers.length) return "";
    const rows = peers.map((p) => `
      <a class="rv-peer" href="${p.href}" ${p.qkey ? `data-qkey="${escapeHtml(p.qkey)}"` : ""}>
        <span class="rv-variant">${escapeHtml(variantLabel(p))}</span>
        <span class="verdict-pill ${verdictClass(p.verdict)}">${statusLabel(p.verdict)}</span>
        ${p.layer ? `<span class="layer-mini">${escapeHtml(p.layer)}</span>` : ""}
        <span class="rv-peer-checks">${escapeHtml(p.failed_checks.map((c) => CHECK_LABELS[c] || c).join("、") || "—")}</span>
        <span class="rv-peer-state">${escapeHtml(p.state)}</span>
      </a>`).join("");
    return `
      <section class="rv-section">
        <h3>同一问题的其他说法 <span class="muted">${peers.length}</span></h3>
        <p class="muted small">保义改写：说法不同、期望相同。几种说法都错在同一处，基本可以断定是稳定缺陷；只有一种错，先怀疑改写本身。</p>
        <div class="rv-peers">${rows}</div>
      </section>`;
  }

  // opts.inPlace：已经在所属运行 / 会话里，不再给「打开」链接；opts.compact：左侧已有对话记录，不重复；opts.peers：同组说法
  function dossierHtml(item, row, opts = {}) {
    const t = row.trace;
    const evidence = new Set(t.layer_evidence || []);
    (t.verdict?.checks || []).forEach((c) => { if (!c.passed) (c.evidence || []).forEach((id) => evidence.add(id)); });
    const meta = t.meta || {};
    const guide = (item.reasons || []).map((r) => `<li>${reasonTag(r)}<span>${escapeHtml(REASON_GUIDE[r] || "")}</span></li>`).join("");
    return `
      <article class="rv-dossier">
        <header class="rv-head">
          <p class="rv-kicker">
            <span class="status-badge ${verdictClass(t.verdict.rule)}"><i></i>${statusLabel(t.verdict.rule)}</span>
            ${escapeHtml(suiteLabel(item.suite))}${item.dimension === "chat" ? "" : ` · ${escapeHtml(dimensionLabel(item.dimension))}`} · <span class="mono">${escapeHtml(t.case_id)}</span>${row.case?.difficulty ? ` · ${escapeHtml(row.case.difficulty)}` : ""}
          </p>
          <h2>${escapeHtml(familyTitle(item))}${item.source === "chat" ? "" : `<span class="rv-variant">${escapeHtml(variantLabel(item))}</span>`}</h2>
          <div class="meta-row">
            <span class="meta-chip">${escapeHtml(t.model)}</span>
            ${meta.today ? `<span class="meta-chip">今天 ${escapeHtml(meta.today)}</span>` : ""}
            ${meta.current_term ? `<span class="meta-chip">${escapeHtml(meta.current_term)} 第 ${escapeHtml(meta.week)} 周</span>` : ""}
            <span class="meta-chip">耗时 ${escapeHtml(latencyLabel(t.latency_ms) || "0ms")}</span>
            <span class="meta-chip mono" title="trace 内容指纹：人工标注按它沿用到所有复跑">#${escapeHtml(row.trace_key)}</span>
            ${opts.inPlace ? "" : `<a class="meta-chip link" href="${item.source === "chat" ? `#/chat/${encodeURIComponent(item.conversation_id || "")}` : `#/run/${encodeURIComponent(item.run_id)}/${encodeURIComponent(item.case_id)}`}">在${item.source === "chat" ? "会话" : "所属运行"}里打开 →</a>`}
            ${(row.case?.tags || []).map((tag) => `<span class="meta-chip">#${escapeHtml(tag)}</span>`).join("")}
          </div>
        </header>

        ${guide ? `
        <section class="rv-guide">
          <h3>你要判断什么</h3>
          <ul>${guide}</ul>
        </section>` : ""}

        ${opts.compact ? "" : `
        <section class="rv-section">
          <h3>对话</h3>
          ${messagesHtml(row)}
          ${row.case?.note ? `<p class="case-note">用例说明：${escapeHtml(row.case.note)}</p>` : ""}
        </section>`}

        <section class="rv-section">
          <h3>期望 vs 实际</h3>
          ${checksTable(row)}
        </section>

        <section class="rv-section">
          <h3>智能体回答</h3>
          ${answerBlock(row)}
        </section>

        <section class="rv-section">
          <h3>LLM 裁判意见</h3>
          ${judgementBlock(row)}
        </section>

        <section class="rv-section">
          <h3>机器归因</h3>
          ${renderAttribution(t)}
        </section>

        <section class="rv-section">
          <h3>思考—行动链路 <span class="muted">${(t.spans || []).length} 步 · 高亮为证据</span></h3>
          <ol class="trace-list">${(t.spans || []).map((s, i) => renderSpan(s, evidence, i)).join("")}</ol>
        </section>

        ${familyBlock(opts.peers || [])}
      </article>`;
  }

  // ---------------------------------------------------- 判断面板

  // 运行页 / 会话页没有队列条目：从审计行和已有标注拼出同样形状的条目
  function itemFromRow(row, labels) {
    const t = row.trace;
    const chat = row.dimension === "chat";
    const human = {};
    let reviewer_ = null;
    let defect = null;
    Object.keys(state.catalog.review_targets).forEach((target) => {
      const lb = labels?.[`${row.trace_key}|${target}`];
      if (!lb) return;
      human[target] = lb.human;
      reviewer_ = reviewer_ || lb.reviewer;
      defect = defect || lb.defect || null;
    });
    const sep = t.case_id.indexOf("__gen_");
    return {
      run_id: row.run_id,
      case_id: t.case_id,
      conversation_id: t.conversation_id,
      source: chat ? "chat" : "cases",
      suite: chat ? "chat" : state.detail?.summary?.suite,
      title: rowTitle(row),
      dimension: row.dimension,
      family: sep >= 0 ? t.case_id.slice(0, sep) : t.case_id,
      variant: sep >= 0 ? t.case_id.slice(sep + 6) : null,
      verdict: t.verdict.rule,
      layer: t.layer,
      reasons: [],
      failed_checks: (t.verdict.checks || []).filter((c) => !c.passed).map((c) => c.check),
      machine: Object.fromEntries(REVIEW_TARGETS.map((target) => [target, machineValue(t, target)])),
      human,
      reviewer: reviewer_,
      defect,
      disposition: human.disposition || null,
    };
  }

  // 复核草稿：每条一份，切走再回来不丢
  function draftFor(item) {
    state.reviewDrafts = state.reviewDrafts || {};
    const key = itemKey(item);
    if (!state.reviewDrafts[key]) {
      const h = item.human || {};
      state.reviewDrafts[key] = {
        disposition: h.disposition || "",
        layer: h.layer && h.layer !== "none" ? h.layer : item.machine.layer && item.machine.layer !== "none" ? item.machine.layer : "",
        llm: h.llm_faithfulness || "",
        defect: item.defect || "",
        note: "",
        batch: false,
      };
    }
    return state.reviewDrafts[key];
  }

  // 由复核结论推出要写的几项标注；返回 [labels, 错误提示]
  function labelsFromDraft(item, row, d) {
    const m = item.machine;
    if (!d.disposition) return [null, m.verdict === "pass" ? "先选「机器判通过，对吗」" : "先选「这条失败站得住吗」"];
    const onlyLlmFailed = item.failed_checks.length === 1 && item.failed_checks[0] === "llm_faithfulness";
    let verdict = null;
    let layer = null;
    if (d.disposition === "agent_defect") {
      verdict = "fail";
      layer = d.layer;
      if (!layer) return [null, "选一个归因层"];
    } else if (d.disposition === "case_too_strict" || d.disposition === "pass_ok") {
      verdict = "pass";
      layer = "none";
    } else if (d.disposition === "judge_wrong") {
      verdict = onlyLlmFailed ? "pass" : "fail";
      layer = verdict === "pass" ? "none" : d.layer;
      if (!layer) return [null, "除了裁判那项，还有别的检查失败：选一个归因层"];
    }
    let llm = d.llm || null;
    if (d.disposition === "judge_wrong" && m.llm_faithfulness) llm = m.llm_faithfulness === "faithful" ? "unfaithful" : "faithful";
    const base = { trace_key: row.trace_key, case_id: row.trace.case_id, run_id: row.run_id, reviewer: reviewer(), note: d.note.trim(), defect: d.defect.trim() };
    // 「确认通过」不是复核结论（没有失败要定性），只记总判定等几项
    const out = d.disposition === "pass_ok" ? [] : [{ ...base, target: "disposition", machine: m.verdict, human: d.disposition }];
    if (verdict && m.verdict) out.push({ ...base, target: "verdict", machine: m.verdict, human: verdict });
    if (layer && m.layer) out.push({ ...base, target: "layer", machine: m.layer, human: layer });
    if (llm && m.llm_faithfulness && d.disposition !== "case_invalid" && d.disposition !== "unsure") {
      out.push({ ...base, target: "llm_faithfulness", machine: m.llm_faithfulness, human: llm });
    }
    return [out, null];
  }

  // 机器判通过时第一步换成「对吗」：确认通过，或标出机器漏判的缺陷
  const PASS_CHOICES = {
    pass_ok: ["确认通过", "回答和链路都没问题"],
    agent_defect: ["其实有问题（机器漏判）", "规则与裁判都没发现，但智能体确实错了"],
  };

  // opts.batch：同组批量沿用（只在复核队列）；opts.queue：显示跳过与 J/K 提示
  function prevSummary(item) {
    const h = item.human;
    const head = h.disposition ? dispositionLabel(h.disposition) : h.verdict === "pass" ? "确认通过" : h.verdict === "fail" ? "确认失败" : "";
    const layer = h.layer && h.layer !== "none" ? `${h.layer} ${layerName(h.layer)}` : "";
    return [head, layer].filter(Boolean).join(" · ") || "已标注";
  }

  function decisionHtml(item, opts = {}) {
    const d = draftFor(item);
    const m = item.machine;
    if (!m.verdict) {
      return `<aside class="rv-decide"><div class="rv-machine"><small>机器结论</small><div><span class="verdict-pill skip">SKIP</span></div></div><p class="muted">跳过的用例没有判定，不参与复核。</p></aside>`;
    }
    const passed = m.verdict === "pass";
    const needsLayer = d.disposition === "agent_defect"
      || (d.disposition === "judge_wrong" && !(item.failed_checks.length === 1 && item.failed_checks[0] === "llm_faithfulness"));
    const choices = passed
      ? Object.entries(PASS_CHOICES).map(([key, [text, help]]) => [key, text, help])
      : Object.entries(state.catalog.dispositions).map(([key, text]) => [key, text, DISPOSITION_HELP[key]]);
    const dispositions = choices.map(([key, text, help], idx) => `
      <button type="button" class="rv-choice ${d.disposition === key ? "is-on" : ""}" data-disp="${key}" ${key === "judge_wrong" && !m.llm_faithfulness ? "disabled" : ""}>
        <kbd>${idx + 1}</kbd>
        <span><b>${escapeHtml(text)}</b><small>${escapeHtml(help)}</small></span>
      </button>`).join("");
    const layers = Object.keys(LAYER_HELP).map((code) => `
      <button type="button" class="rv-layer ${d.layer === code ? "is-on" : ""}" data-layer="${code}">
        <b>${code}</b><span>${escapeHtml(layerName(code))}</span>
        ${m.layer === code ? '<i class="rv-machine-tag">机器</i>' : ""}
        <small>${escapeHtml(LAYER_HELP[code])}</small>
      </button>`).join("");
    const llmNo = needsLayer ? 3 : 2;
    const llmStep = m.llm_faithfulness && !["case_invalid", "unsure", "judge_wrong"].includes(d.disposition) ? `
      <div class="rv-step">
        <h4><span>${llmNo}</span>LLM 裁判判「${m.llm_faithfulness === "faithful" ? "忠实" : "不忠实"}」，对吗？</h4>
        <div class="rv-seg">
          <button type="button" class="${d.llm === m.llm_faithfulness ? "is-on" : ""}" data-llm="${m.llm_faithfulness}">对</button>
          <button type="button" class="${d.llm && d.llm !== m.llm_faithfulness ? "is-on" : ""}" data-llm="${m.llm_faithfulness === "faithful" ? "unfaithful" : "faithful"}">不对</button>
        </div>
      </div>` : "";
    const peers = opts.batch ? batchPeers(item) : [];
    const defects = (state.catalog.defects || []).map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.layer)} · ${escapeHtml(x.title)}</option>`).join("");
    const previous = Object.keys(item.human || {}).length
      ? `<p class="rv-prev">已复核：${escapeHtml(prevSummary(item))} · ${escapeHtml(item.reviewer || "匿名")}${item.defect ? ` · ${escapeHtml(item.defect)}` : ""}。再次提交会追加一条新结论，以最后一次为准。</p>`
      : "";
    return `
      <aside class="rv-decide" aria-label="复核判断">
        <div class="rv-machine">
          <small>机器结论</small>
          <div>
            <span class="verdict-pill ${verdictClass(m.verdict)}">${statusLabel(m.verdict)}</span>
            ${m.layer && m.layer !== "none" ? `<span class="layer-mini">${escapeHtml(m.layer)} ${escapeHtml(layerName(m.layer))}</span>` : ""}
            ${m.llm_faithfulness ? `<span class="tag ${m.llm_faithfulness === "faithful" ? "ok" : "warn"}">LLM ${m.llm_faithfulness === "faithful" ? "忠实" : "不忠实"}</span>` : ""}
          </div>
          <button type="button" class="rv-agree" data-agree-all><kbd>A</kbd> 全部同意机器</button>
        </div>
        ${previous}
        <div class="rv-step">
          <h4><span>1</span>${passed ? "机器判通过，对吗？" : "这条失败站得住吗？"}</h4>
          <div class="rv-choices">${dispositions}</div>
        </div>
        ${needsLayer ? `
        <div class="rv-step">
          <h4><span>2</span>根因在哪一层？</h4>
          <div class="rv-layers">${layers}</div>
        </div>` : ""}
        ${llmStep}
        <div class="rv-step">
          <h4><span>${llmStep ? llmNo + 1 : llmNo}</span>关联缺陷与备注 <small>（可选）</small></h4>
          <select id="rvDefect" class="dim-select" aria-label="关联缺陷编号">
            <option value="">不关联缺陷编号</option>${defects}
          </select>
          <textarea id="rvNote" rows="2" maxlength="500" placeholder="例如：88.8 是算术平均，加权应为 88.64">${escapeHtml(d.note)}</textarea>
        </div>
        ${peers.length ? `
        <label class="rv-batch">
          <input type="checkbox" id="rvBatch" ${d.batch ? "checked" : ""}>
          <span>同组还有 <b>${peers.length}</b> 种说法失败方式完全相同（${escapeHtml(peers.map(variantLabel).join("、"))}），一并沿用本条结论
          <small>批量沿用的标注不计入 κ，只计你亲眼看过的这一条</small></span>
        </label>` : ""}
        <div class="rv-actions">
          <button type="button" class="run-button" id="rvSubmit">提交<kbd>Enter</kbd></button>
          ${opts.queue ? '<button type="button" class="ghost-button" id="rvSkip">跳过<kbd>S</kbd></button>' : ""}
        </div>
        <p class="rv-keys">${opts.queue ? "J / K 上下条 · " : ""}1–${choices.length} 选结论 · A 全部同意 · Enter 提交</p>
      </aside>`;
  }

  // ---------------------------------------------------- 队列

  function queueListHtml(items) {
    const groups = [];
    const byFamily = new Map();
    items.forEach((i) => {
      const k = `${i.source}:${i.family}`;
      if (!byFamily.has(k)) {
        byFamily.set(k, []);
        groups.push(k);
      }
      byFamily.get(k).push(i);
    });
    return groups.map((k) => {
      const list = byFamily.get(k);
      const head = list[0];
      const rows = list.map((i) => {
        const key = itemKey(i);
        const state_ = i.disposition ? `rv-dot is-${i.disposition}` : "rv-dot";
        return `
          <button type="button" class="rv-item ${key === state.queueSel ? "is-selected" : ""}" data-qkey="${escapeHtml(key)}">
            <i class="${state_}" title="${escapeHtml(i.disposition ? dispositionLabel(i.disposition) : "未定")}"></i>
            <span class="rv-item-variant">${escapeHtml(variantLabel(i))}</span>
            <span class="rv-item-reason" title="${escapeHtml(state.queue.reasons[i.reasons[0]] || "")}">${escapeHtml(REASON_SHORT[i.reasons[0]] || i.reasons[0])}</span>
            ${i.layer ? `<span class="layer-mini">${escapeHtml(i.layer)}</span>` : ""}
          </button>`;
      }).join("");
      return `
        <div class="rv-group">
          <div class="rv-group-head">
            <b>${escapeHtml(familyTitle(head))}</b>
            <span>${escapeHtml(suiteLabel(head.suite))} · ${list.length} 条</span>
          </div>
          ${rows}
        </div>`;
    }).join("");
  }

  function queueOpts(item) {
    const peers = state.queue.items.filter((i) => i.family === item.family && i !== item && i.source === item.source)
      .map((p) => ({ ...p, href: queueHref(p), qkey: itemKey(p), state: p.disposition ? dispositionLabel(p.disposition) : p.reviewed ? "已复核" : "待复核" }));
    return { queue: true, batch: true, peers };
  }

  function renderQueue() {
    const q = state.queue;
    const items = queueItems();
    const current = q.items.find((i) => itemKey(i) === state.queueSel) || null;
    const total = q.items.length;
    const done = q.reviewed;
    const tab = (key, text, n) => `<button class="${state.queueTab === key ? "is-on" : ""}" type="button" data-qtab="${key}">${text} <b>${n}</b></button>`;
    const inTab = q.items.filter((i) => (state.queueTab === "pending" ? !i.reviewed && !i.discuss : state.queueTab === "discuss" ? i.discuss : i.reviewed));
    const reasonChips = Object.entries(q.reasons).map(([r, text]) => {
      const n = inTab.filter((i) => i.reasons.includes(r)).length;
      return n ? `<button type="button" class="rv-chip ${state.queueReason === r ? "is-on" : ""}" data-reason="${r}" title="${escapeHtml(text)}">${escapeHtml(REASON_SHORT[r] || text)} <b>${n}</b></button>` : "";
    }).join("");

    let body;
    if (!current) {
      body = `<section class="rv-empty">${placeholder(items.length ? "从左侧选一条开始复核" : state.queueTab === "pending" ? "待复核队列已清空" : "这里没有条目", state.queueTab === "pending" ? "新的失败与两轨分歧会在下次运行后自动进来" : "")}</section>`;
    } else if (!state.queueRow) {
      body = `<section class="rv-empty">${placeholder("正在读取 trace…")}</section>`;
    } else {
      body = "__PANEL__";
    }

    view.innerHTML = `
      ${pageHead("待人工复核", "机器拿不准、或两条判定轨结论打架的样本。先判断这条失败站不站得住，再确认归因层与裁判对错；结论写入 reviews/labels.jsonl，用来算人机一致性 κ。")}
      <div class="rv-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${done}">
        <div class="rv-bar"><i style="width:${total ? (done / total) * 100 : 0}%"></i><i class="discuss" style="width:${total ? (q.discuss / total) * 100 : 0}%"></i></div>
        <span>已复核 <b>${done}</b> / ${total}${q.discuss ? ` · 待讨论 ${q.discuss}` : ""}</span>
      </div>
      <section class="rv-workspace">
        <aside class="rv-queue" aria-label="复核队列">
          <div class="rv-tabs" role="group" aria-label="复核状态">
            ${tab("pending", "待复核", q.pending)}${tab("discuss", "待讨论", q.discuss)}${tab("reviewed", "已复核", q.reviewed)}
          </div>
          ${reasonChips ? `<div class="rv-chips">${reasonChips}</div>` : ""}
          <div class="rv-list">${queueListHtml(items) || '<div class="is-empty-state">没有条目。</div>'}</div>
        </aside>
        ${body === "__PANEL__" ? auditPanelHtml(current, state.queueRow, queueOpts(current)) : `<div class="rv-main"><div class="rv-grid">${body}</div></div>`}
      </section>`;

    view.querySelectorAll("[data-qtab]").forEach((b) => b.addEventListener("click", () => {
      state.queueTab = b.dataset.qtab;
      state.queueReason = "";
      selectQueueItem(queueItems()[0] || null);
    }));
    view.querySelectorAll("[data-reason]").forEach((b) => b.addEventListener("click", () => {
      state.queueReason = state.queueReason === b.dataset.reason ? "" : b.dataset.reason;
      selectQueueItem(queueItems()[0] || null);
    }));
    view.querySelectorAll("[data-qkey]").forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      selectQueueItem(q.items.find((i) => itemKey(i) === b.dataset.qkey));
    }));
    $(".rv-item.is-selected", view)?.scrollIntoView({ block: "nearest" });
    state.audit = null;
    if (current && state.queueRow) bindAudit(current, state.queueRow, { opts: queueOpts(current), onSaved: () => afterQueueSave(current) });
  }

  // 卷宗 + 判断面板（复核队列、运行页、会话页共用）
  function auditPanelHtml(item, row, opts = {}) {
    return `<div class="rv-main" id="rvMain"><div class="rv-grid">${dossierHtml(item, row, opts)}${decisionHtml(item, opts)}</div></div>`;
  }

  // ctx：{ opts（同 auditPanelHtml）, onSaved(records) }；当前面板记在 state.audit，供快捷键使用
  function bindAudit(item, row, ctx) {
    const main = $("#rvMain");
    const d = draftFor(item);
    main.addEventListener("click", (e) => {
      const jump = e.target.closest("[data-jump]");
      if (jump) {
        const target = $(`[data-span-id="${CSS.escape(jump.dataset.jump)}"]`, main);
        target?.scrollIntoView({ behavior: "smooth", block: "center" });
        target?.animate([{ boxShadow: "0 0 0 0 rgba(220,236,155,.75)" }, { boxShadow: "0 0 0 7px rgba(220,236,155,0)" }], { duration: 900 });
      }
    });
    const rerender = () => {
      const panel = $(".rv-decide", main);
      if (!panel) return;
      const scroll = panel.scrollTop;
      const fresh = document.createElement("div");
      fresh.innerHTML = decisionHtml(item, ctx.opts);
      panel.replaceWith(fresh.firstElementChild);
      $(".rv-decide", main).scrollTop = scroll;
      wire();
    };
    const wire = () => {
      const panel = $(".rv-decide", main);
      if (!$("#rvSubmit", panel)) return; // 跳过的用例
      panel.querySelectorAll("[data-disp]").forEach((b) => b.addEventListener("click", () => {
        pickDisposition(item, b.dataset.disp);
        rerender();
      }));
      panel.querySelectorAll("[data-layer]").forEach((b) => b.addEventListener("click", () => { d.layer = b.dataset.layer; rerender(); }));
      panel.querySelectorAll("[data-llm]").forEach((b) => b.addEventListener("click", () => { d.llm = b.dataset.llm; rerender(); }));
      $("[data-agree-all]", panel).addEventListener("click", () => { agreeAll(item); rerender(); });
      const defect = $("#rvDefect", panel);
      defect.value = d.defect;
      defect.addEventListener("change", () => { d.defect = defect.value; });
      $("#rvNote", panel).addEventListener("input", (e) => { d.note = e.target.value; });
      $("#rvBatch", panel)?.addEventListener("change", (e) => { d.batch = e.target.checked; });
      $("#rvSubmit", panel).addEventListener("click", () => submitAudit(item, row, ctx));
      $("#rvSkip", panel)?.addEventListener("click", () => stepQueue(1));
    };
    wire();
    state.audit = { item, row, ctx, root: main, rerender };
  }

  function pickDisposition(item, disp) {
    const d = draftFor(item);
    d.disposition = disp;
    // 判「用例过严」或「确认通过」= 认可回答没问题：裁判若判了忠实，默认认可它（可再改）
    if ((disp === "case_too_strict" || disp === "pass_ok") && !d.llm && item.machine.llm_faithfulness === "faithful") d.llm = "faithful";
  }

  function agreeAll(item) {
    const d = draftFor(item);
    const m = item.machine;
    d.disposition = m.verdict === "fail" ? "agent_defect" : "pass_ok";
    d.layer = m.layer && m.layer !== "none" ? m.layer : "";
    d.llm = m.llm_faithfulness || "";
  }

  async function submitAudit(item, row, ctx) {
    if (!reviewer()) {
      showToast("请先在左下角填写复核人");
      reviewerInput.focus();
      return;
    }
    const d = draftFor(item);
    const [labels, error] = labelsFromDraft(item, row, d);
    if (error) {
      showToast(error);
      return;
    }
    let all = labels;
    if (d.batch && ctx.opts.batch) {
      // 同组样本照搬结论：trace 不同，指纹各自独立，标 batch_of 以便 κ 剔除
      for (const p of batchPeers(item)) {
        const peerRow = await api(`/api/trace?run=${encodeURIComponent(p.run_id)}&case=${encodeURIComponent(p.case_id)}`);
        all = all.concat(labels.map((lb) => ({ ...lb, trace_key: peerRow.trace_key, case_id: p.case_id, run_id: p.run_id, batch_of: row.trace_key })));
      }
    }
    let saved;
    try {
      saved = (await api("/api/reviews", { method: "POST", body: JSON.stringify({ labels: all }) })).labels;
    } catch (err) {
      showToast(`保存失败：${err.message}`);
      return;
    }
    delete state.reviewDrafts[itemKey(item)];
    const name = d.disposition === "pass_ok" ? "确认通过" : dispositionLabel(d.disposition);
    showToast(`已保存${all.length > labels.length ? `（含同组 ${all.length / labels.length - 1} 条）` : ""}：${name}`);
    refreshQueueBadge();
    ctx.onSaved(saved);
  }

  // 运行页 / 会话页：保存后把新标注并进本页的标注表再重绘
  function mergeLabels(labels, records) {
    records.forEach((lb) => { labels[`${lb.trace_key}|${lb.target}`] = lb; });
  }

  async function afterQueueSave(item) {
    const before = queueItems();
    const at = before.findIndex((i) => itemKey(i) === itemKey(item));
    state.queue = await api("/api/queue");
    setQueueBadge(state.queue.pending);
    const after = queueItems();
    const stay = state.queueTab === "reviewed";
    selectQueueItem(stay ? state.queue.items.find((i) => itemKey(i) === itemKey(item)) : after[Math.min(at, after.length - 1)] || null);
  }

  function stepQueue(delta) {
    const items = queueItems();
    if (!items.length) return;
    const at = items.findIndex((i) => itemKey(i) === state.queueSel);
    const next = items[Math.max(0, Math.min(items.length - 1, (at < 0 ? 0 : at) + delta))];
    if (next && itemKey(next) !== state.queueSel) selectQueueItem(next);
  }

  // 复核快捷键：页面上有判断面板、且焦点不在输入框里时生效；J/K/S 只在复核队列
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.target.closest("input, textarea, select")) return;
    if (e.key === "Enter" && e.target.closest("button, a, [role=button]")) return; // 回车已经在触发聚焦按钮的点击
    const key = e.key.toLowerCase();
    const inQueue = location.hash.startsWith("#/queue") && state.queue;
    if (inQueue && (key === "j" || key === "s")) stepQueue(1);
    else if (inQueue && key === "k") stepQueue(-1);
    else {
      const a = state.audit;
      if (!a || !document.contains(a.root) || !a.item.machine.verdict) return;
      const choices = a.item.machine.verdict === "pass" ? Object.keys(PASS_CHOICES) : Object.keys(state.catalog.dispositions);
      if (key === "a") {
        agreeAll(a.item);
        a.rerender();
      } else if (key === "enter") submitAudit(a.item, a.row, a.ctx);
      else if (/^[1-9]$/.test(key) && Number(key) <= choices.length) {
        const disp = choices[Number(key) - 1];
        if (disp === "judge_wrong" && !a.item.machine.llm_faithfulness) return;
        pickDisposition(a.item, disp);
        a.rerender();
      } else return;
    }
    e.preventDefault();
  });

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
      $("#rvMain")?.scrollTo({ top: 0 });
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

  // 运行页的「同一问题的其他说法」：同一次运行里同一基准用例的其他条目
  function runOpts(row) {
    const family = (id) => id.split("__gen_")[0];
    const peers = state.detail.rows
      .map((r, i) => [r, i])
      .filter(([r]) => r !== row && family(r.trace.case_id) === family(row.trace.case_id))
      .map(([r, i]) => {
        const it = itemFromRow(r, state.detail.labels);
        return { ...it, href: `#/run/${encodeURIComponent(r.run_id)}/${encodeURIComponent(r.trace.case_id)}`, state: it.disposition ? dispositionLabel(it.disposition) : it.human.verdict ? "已复核" : "未复核", key: rowKey(r, i) };
      });
    return { inPlace: true, peers };
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
        <section class="detail-panel" id="detailPanel">${row ? auditPanelHtml(itemFromRow(row, d.labels), row, runOpts(row)) : placeholder("从左侧选择一条用例")}</section>
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
    state.audit = null;
    if (row) {
      bindAudit(itemFromRow(row, state.detail.labels), row, {
        opts: runOpts(row),
        onSaved: (records) => { mergeLabels(state.detail.labels, records); renderRun(); },
      });
    }
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

  // 复核结论分布：多少失败被确认为智能体缺陷、多少其实是用例或裁判的问题
  function dispositionPanel(r) {
    const counts = r.dispositions || {};
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    if (!total) return "";
    const rows = Object.entries(counts).map(([k, n]) => `
      <div class="disp-row">
        <span><i class="rv-dot is-${k}"></i>${escapeHtml(state.catalog.dispositions[k] || k)}</span>
        <span class="disp-bar"><i class="is-${k}" style="width:${(n / total) * 100}%"></i></span>
        <b>${n}</b>
      </div>`).join("");
    return `
      <section class="panel">
        <div class="panel-bar"><h2>复核结论 <span class="muted">${total}</span></h2></div>
        <div class="disp-list">${rows}</div>
        ${r.batched ? `<p class="muted small">其中 ${r.batched} 条标注是同组批量沿用的，不计入上面的 κ。</p>` : ""}
      </section>`;
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
    // 一条样本一行：同一 trace 的几项标注合并，逐项写「机器 → 人工」，不一致的标出来
    const byTrace = new Map();
    r.labels.forEach((lb) => {
      if (!byTrace.has(lb.trace_key)) byTrace.set(lb.trace_key, { first: lb, items: {} });
      const g = byTrace.get(lb.trace_key);
      g.items[lb.target] = lb;
      if (lb.at > g.first.at) g.first = { ...g.first, at: lb.at };
    });
    const cell = (lb, target) => {
      if (!lb) return '<td class="muted">—</td>';
      if (target === "disposition") return `<td><span class="rv-disp"><i class="rv-dot is-${escapeHtml(lb.human)}"></i>${escapeHtml(valueLabel(target, lb.human))}</span></td>`;
      const same = lb.machine === lb.human;
      return `<td class="${same ? "" : "is-diff"}">${same ? escapeHtml(valueLabel(target, lb.human)) : `<s>${escapeHtml(valueLabel(target, lb.machine))}</s> → <b>${escapeHtml(valueLabel(target, lb.human))}</b>`}</td>`;
    };
    const groups = [...byTrace.values()].sort((a, b) => (a.first.at < b.first.at ? 1 : -1));
    const rows = groups.map(({ first, items }) => {
      const any = Object.values(items);
      const defect = any.find((lb) => lb.defect)?.defect;
      const note = any.find((lb) => lb.note)?.note || "";
      const batch = any.some((lb) => lb.batch_of);
      return `
      <tr>
        <td class="nowrap">${escapeHtml(formatTime(first.at))}</td>
        <td class="mono"><a href="${labelHref(first)}">${escapeHtml(first.case_id)}</a>${batch ? ' <span class="tag" title="同组批量沿用，不计入 κ">批量</span>' : ""}</td>
        ${cell(items.disposition, "disposition")}
        ${cell(items.verdict, "verdict")}
        ${cell(items.layer, "layer")}
        ${cell(items.llm_faithfulness, "llm_faithfulness")}
        <td>${defect ? `<span class="tag bad">${escapeHtml(defect)}</span>` : ""}</td>
        <td>${escapeHtml(first.reviewer || "")}</td>
        <td>${escapeHtml(note)}</td>
      </tr>`;
    }).join("");
    view.innerHTML = `
      ${pageHead("复核一致性", "机器结论与人工复核的一致率和 Cohen's κ：这是归因在真实缺陷上到底准不准的唯一证据。同一 trace 同一目标只取最后一次标注。", {
        actions: '<a class="run-button" href="#/queue">去复核队列</a>',
      })}
      <section class="stat-grid">${cards}</section>
      ${dispositionPanel(r)}
      <section class="panel">
        <div class="panel-bar"><h2>标注明细 <span class="muted">${byTrace.size} 条样本</span></h2><span class="muted small">划线为机器结论，箭头后为人工改判</span></div>
        ${r.labels.length ? `
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>时间</th><th>用例</th><th>复核结论</th><th>总判定</th><th>归因层</th><th>LLM 忠实度</th><th>缺陷</th><th>复核人</th><th>备注</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : placeholder("还没有人工标注", "到「待人工复核」逐条确认机器结论")}
      </section>`;
  }

  // ------------------------------------------------------------ router

  function setNav(name) {
    document.querySelectorAll("[data-nav]").forEach((a) => a.classList.toggle("is-active", a.dataset.nav === name));
  }

  // 页面跳转时作废上一次还在路上的请求：否则慢的旧请求回来会把新页面覆盖掉
  const STALE_ROUTE = Symbol("stale-route");

  async function routeApi(seq, path) {
    const result = await api(path);
    if (seq !== state.routeSeq) throw STALE_ROUTE;
    return result;
  }

  async function route() {
    state.routeSeq = (state.routeSeq || 0) + 1;
    const seq = state.routeSeq;
    const parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
    const [page, a, b] = parts;
    try {
      if (page === "run" && a) {
        setNav(a.startsWith("chat-") ? "chats" : "runs");
        if (state.detail?.summary.run_id !== a) {
          view.innerHTML = a.startsWith("chat-")
            ? placeholder("正在读取线上对话并逐条判定…", "未判定过的对话需要调用裁判模型，首次打开可能要几十秒")
            : placeholder("正在读取运行…");
          state.detail = await routeApi(seq, `/api/runs/${encodeURIComponent(a)}`);
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
        state.compare = await routeApi(seq, `/api/compare?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
        renderCompare();
      } else if (page === "chats") {
        setNav("chats");
        view.innerHTML = placeholder("正在读取线上对话…");
        state.chats = (await routeApi(seq, "/api/chats")).conversations;
        renderChats();
      } else if (page === "chat" && a) {
        setNav("chats");
        if (state.chat?.conversation_id !== a) {
          view.innerHTML = placeholder("正在读取会话并判定…", "未判定过的轮次需要调用裁判模型，可能要十几秒");
          state.chat = await routeApi(seq, `/api/chats/${encodeURIComponent(a)}`);
        }
        const turn = Number(b);
        state.selectedTurn = turn >= 1 ? turn - 1 : Math.max(0, state.chat.rows.findIndex((r) => r.trace.verdict.rule === "fail"));
        renderChat();
      } else if (page === "queue") {
        setNav("queue");
        view.innerHTML = placeholder("正在整理复核队列…");
        state.queue = await routeApi(seq, "/api/queue");
        setQueueBadge(state.queue.pending);
        const wanted = a && b ? `${a}/${b}` : null;
        let item = state.queue.items.find((i) => itemKey(i) === wanted);
        if (item) state.queueTab = item.reviewed ? "reviewed" : "pending";
        else item = queueItems()[0] || null;
        await selectQueueItem(item);
      } else if (page === "reviews") {
        setNav("reviews");
        state.reviews = await routeApi(seq, "/api/reviews");
        renderReviews();
      } else if (page === "runs") {
        setNav("runs");
        state.runs = (await routeApi(seq, "/api/runs")).runs;
        state.detail = null;
        renderRuns();
      } else {
        setNav("overview");
        view.innerHTML = placeholder("正在汇总最新审计…");
        state.overview = await routeApi(seq, "/api/overview");
        setQueueBadge(state.overview.queue.pending);
        renderOverview();
      }
      window.scrollTo({ top: 0 });
    } catch (error) {
      if (error === STALE_ROUTE) return;
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
