(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);

  const state = {
    catalog: null,
    runs: [],
    detail: null, // 当前打开的运行
    selectedCase: null,
    filter: { verdict: "all", dimension: "", layer: "" },
    compareSel: [],
    compare: null,
    compareOnlyChanged: true,
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

  const SPAN_LABELS = {
    plan: "规划",
    tool_call: "工具调用",
    observation: "工具观测",
    retrieve: "知识检索",
    generate: "生成",
    guardrail: "护栏",
  };

  const CHECK_LABELS = {
    status: "执行状态",
    refusal: "拒答",
    tool_sequence: "工具序列",
    forbidden_tools: "禁止工具",
    tool_args: "工具参数",
    answer_text: "答案关键词",
    llm_faithfulness: "LLM 忠实度",
  };

  const ADAPTER_LABELS = {
    onegzus: "软帮手智能体",
    campus_copilot: "CampusCopilot 桩",
  };

  const view = $("#view");
  const toast = $("#toast");
  const reviewerInput = $("#reviewerInput");

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

  function rowTitle(row) {
    if (row.case?.title) return row.case.title;
    const users = rowMessages(row).filter((m) => m.role === "user");
    const last = users[users.length - 1]?.content;
    if (last) return last.length > 40 ? `${last.slice(0, 40)}…` : last;
    return row.case === null && row.dimension === "chat" ? "（未记录用户输入）" : "（用例定义已不存在）";
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
            <span class="span-kind">${escapeHtml(span.span.toUpperCase())} · ${escapeHtml(SPAN_LABELS[span.span] || span.span)}</span>
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
    return `<div class="side-head"><h3>双轨判定</h3><span>${passed}/${checks.length} 通过</span></div><div class="check-list">${rows}</div>${degraded}`;
  }

  function renderAttribution(trace) {
    const healthy = !trace.layer;
    const links = evidenceLinks(trace.layer_evidence);
    return `
      <section class="attribution-card ${healthy ? "is-healthy" : ""}">
        <div class="attr-top">
          <span class="attr-code">${escapeHtml(trace.layer || "OK")}</span>
          <span class="attr-title">
            <small>${healthy ? "NO DEFECT" : "ROOT CAUSE"}</small>
            <strong>${healthy ? (trace.verdict.rule === "skip" ? "已跳过，未判定" : "未触发失败归因") : `${escapeHtml(trace.layer)} · ${escapeHtml(layerName(trace.layer))}`}</strong>
          </span>
        </div>
        <p class="attr-reason">${escapeHtml(healthy ? (trace.meta?.error || "全部检查通过，没有失败需要归因。") : trace.layer_reason || "归因引擎未返回原因。")}</p>
        ${links ? `<div class="attr-evidence"><span>EVIDENCE</span>${links}</div>` : ""}
      </section>
    `;
  }

  // ------------------------------------------------------------ runs view

  function suiteOptions() {
    return (state.catalog?.suites || [])
      .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.label)} · ${s.cases} 条</option>`)
      .join("");
  }

  function renderRuns() {
    const runs = state.runs;
    const sel = new Set(state.compareSel);
    const rows = runs.map((r) => {
      const judge = r.llm_judge
        ? (r.judge_degraded ? `<span class="tag warn">降级 ${r.judge_degraded}</span>` : '<span class="tag ok">已启用</span>')
        : '<span class="tag">未启用</span>';
      return `
        <tr>
          <td><input type="checkbox" class="cmp-box" data-run="${escapeHtml(r.run_id)}" ${sel.has(r.run_id) ? "checked" : ""} aria-label="选择 ${escapeHtml(r.run_id)} 用于对比"></td>
          <td class="mono"><a href="#/run/${encodeURIComponent(r.run_id)}">${escapeHtml(r.run_id)}</a></td>
          <td>${escapeHtml(formatTime(r.generated_at))}</td>
          <td>${escapeHtml(runLabel(r))}${r.source === "chat" ? ' <span class="tag">线上</span>' : ""}<div class="muted small">${escapeHtml(r.models.join(", "))}</div></td>
          <td class="num">${r.total}</td>
          <td class="num"><span class="pass-text">${r.pass}</span> / <span class="fail-text">${r.fail}</span>${r.skip ? ` / <span class="muted">${r.skip}</span>` : ""}</td>
          <td class="num"><b>${r.score.toFixed(1)}</b></td>
          <td>${judge}</td>
        </tr>`;
    }).join("");

    view.innerHTML = `
      <section class="page-head">
        <div>
          <p class="section-index">RUNS</p>
          <h1 class="page-title">运行记录</h1>
          <p class="muted">用例运行写入 results/&lt;run_id&gt;/traces.jsonl；软帮手聊天页的真实对话按天汇成「线上对话」运行（没有预设期望，只判执行状态与 LLM 忠实度）。每个数字都能点进去找到原始 span。</p>
        </div>
      </section>

      <section class="panel launch-panel">
        <div class="launch-copy">
          <h2>发起一次运行</h2>
          <p class="muted small">软帮手用例回放已录制的模型回复，工具在被测对象一侧真实执行；LLM 裁判优先命中缓存${state.catalog?.judge_configured ? "，未命中时调用已配置的裁判模型" : "，未配置裁判模型时未命中的条目只保留规则轨"}。</p>
        </div>
        <div class="launch-form">
          <label><span>用例集</span><select id="suiteSelect">${suiteOptions()}</select></label>
          <label class="check-inline"><input type="checkbox" id="judgeToggle" checked> LLM 忠实度裁判</label>
          <button class="run-button" id="launchBtn" type="button" data-busy-disable>
            <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M6 4.5v11l9-5.5-9-5.5Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>
            <span>运行</span>
          </button>
        </div>
      </section>

      <section class="panel">
        <div class="panel-bar">
          <h2>历史运行 <span class="muted">${runs.length}</span></h2>
          <button type="button" class="ghost-button" id="compareBtn" ${sel.size === 2 ? "" : "disabled"}>对比所选两次运行（${sel.size}/2）</button>
        </div>
        ${runs.length ? `
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th></th><th>运行</th><th>时间</th><th>被测对象</th><th class="num">用例</th><th class="num">通过 / 失败</th><th class="num">可靠性分</th><th>LLM 裁判</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : placeholder("还没有运行记录", "在上方发起一次运行，或在命令行执行 python -m agentlens run")}
      </section>
    `;

    $("#launchBtn").addEventListener("click", launchRun);
    $("#compareBtn").addEventListener("click", () => {
      const [a, b] = state.compareSel;
      location.hash = `#/compare/${encodeURIComponent(a)}/${encodeURIComponent(b)}`;
    });
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
      location.hash = `#/run/${encodeURIComponent(result.run_id)}`;
    } catch (error) {
      showToast(`运行失败：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  // ------------------------------------------------------------ run view

  function expectedTools(item) {
    return (item?.expect?.tools || []).filter((t) => !t.optional).map((t) => t.name);
  }

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

  function labelFor(row, target) {
    return state.detail.labels?.[`${row.trace_key}|${target}`] || null;
  }

  function reviewProgress() {
    let need = 0;
    let done = 0;
    state.detail.rows.forEach((row) => {
      ["verdict", "layer", "llm_faithfulness"].forEach((target) => {
        if (machineValue(row.trace, target) === null) return;
        need += 1;
        if (labelFor(row, target)) done += 1;
      });
    });
    return { need, done };
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
          ? `<td><button type="button" class="hm-cell ${active ? "is-active" : ""}" data-dim="${escapeHtml(d)}" data-layer="${escapeHtml(l)}" style="--a:${(0.18 + 0.82 * n / max).toFixed(2)}" aria-label="${escapeHtml(dimensionLabel(d))} × ${escapeHtml(l)}：${n} 条">${n}</button></td>`
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
      const reviewed = ["verdict", "layer", "llm_faithfulness"].some((target) => labelFor(row, target));
      const disagree = ["verdict", "layer", "llm_faithfulness"].some((target) => labelFor(row, target)?.agree === false);
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

  const REVIEW_OPTIONS = {
    verdict: [["pass", "PASS"], ["fail", "FAIL"]],
    layer: [["none", "无缺陷"], ["L0", "L0 环境/超时"], ["L1", "L1 意图与规划"], ["L2", "L2 工具选型"], ["L3", "L3 参数填充"], ["L4", "L4 结果解读"], ["L5", "L5 知识与检索"], ["L6", "L6 护栏"]],
    llm_faithfulness: [["faithful", "忠实"], ["unfaithful", "不忠实"]],
  };

  function valueLabel(target, value) {
    return (REVIEW_OPTIONS[target].find(([v]) => v === value) || [value, value])[1];
  }

  function reviewHtml(row) {
    const targets = ["verdict", "layer", "llm_faithfulness"].filter((t) => machineValue(row.trace, t) !== null);
    if (!targets.length) return `<section class="side-card review-card"><div class="side-head"><h3>人工复核</h3></div><p class="muted">跳过的用例不参与复核。</p></section>`;
    const items = targets.map((target) => {
      const machine = machineValue(row.trace, target);
      const label = labelFor(row, target);
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
          <select data-target="${target}" data-machine="${escapeHtml(machine)}" aria-label="${escapeHtml(state.catalog.review_targets[target])} 的人工结论">
            <option value="">— 人工结论 —</option>${options}
          </select>
          ${status}
          ${label?.note ? `<p class="review-note">${escapeHtml(label.note)}</p>` : ""}
        </div>`;
    }).join("");
    return `
      <section class="side-card review-card">
        <div class="side-head"><h3>人工复核</h3><span>标注沿用到同一 trace 的所有复跑</span></div>
        <div class="review-list">${items}</div>
        <textarea id="reviewNote" rows="2" maxlength="500" placeholder="备注（可选）：例如「88.7 应为 88.64」"></textarea>
        <button type="button" class="run-button" id="reviewSubmit">提交复核</button>
      </section>`;
  }

  function detailHtml() {
    const rows = state.detail.rows;
    const index = rows.findIndex((row, i) => rowKey(row, i) === state.selectedCase);
    if (index < 0) return placeholder("从左侧选择一条用例");
    const row = rows[index];
    const item = row.case || {};
    const t = row.trace;
    const rule = verdictClass(t.verdict.rule);
    const expected = expectedTools(item);
    const actual = (t.spans || []).filter((s) => s.span === "tool_call").map((s) => s.name);
    const evidence = new Set(t.layer_evidence || []);
    (t.verdict?.checks || []).forEach((c) => {
      if (!c.passed) (c.evidence || []).forEach((id) => evidence.add(id));
    });
    const recorded = rowMessages(row);
    const messages = recorded.length ? recorded.map((m) => `
      <div class="question ${m.role === "assistant" ? "is-assistant" : ""}">
        <span class="question-label">${m.role === "assistant" ? "AGENT（历史）" : "USER"}</span>
        <p>${escapeHtml(m.content)}</p>
      </div>`).join("") : '<p class="case-note">这条对话产生于记录用户输入之前，原始问题已无法还原；回答与执行链路仍可审计。</p>';
    const meta = t.meta || {};
    return `
      <article class="detail">
        <header class="case-hero">
          <div class="case-headline">
            <span class="status-badge ${rule}"><i></i>${statusLabel(t.verdict.rule)}</span>
            <div>
              <div class="case-kicker"><b>${escapeHtml(t.case_id)}</b> · ${escapeHtml(dimensionLabel(row.dimension))} · ${escapeHtml(item.difficulty || "")}</div>
              <h2 class="case-h2">${escapeHtml(rowTitle(row))}</h2>
            </div>
          </div>
          ${messages}
          <div class="meta-row">
            <span class="meta-chip">${escapeHtml(t.model)}</span>
            ${meta.mode ? `<span class="meta-chip">${escapeHtml(meta.mode)}</span>` : ""}
            ${meta.today ? `<span class="meta-chip">今天 ${escapeHtml(meta.today)}</span>` : ""}
            ${meta.current_term ? `<span class="meta-chip">${escapeHtml(meta.current_term)} 第 ${escapeHtml(meta.week)} 周</span>` : ""}
            <span class="meta-chip">${escapeHtml(latencyLabel(t.latency_ms) || "0ms")}</span>
            <span class="meta-chip">tokens ${escapeHtml((t.tokens?.prompt || 0) + (t.tokens?.completion || 0))}</span>
            <span class="meta-chip mono" title="trace 内容指纹">#${escapeHtml(row.trace_key)}</span>
            ${(item.tags || []).map((tag) => `<span class="meta-chip">#${escapeHtml(tag)}</span>`).join("")}
          </div>
          ${item.note ? `<p class="case-note">${escapeHtml(item.note)}</p>` : ""}
        </header>

        <div class="detail-grid">
          <div class="trace-column">
            <div class="block-title">
              <span>思考—行动链路</span>
              <span>${(t.spans || []).length} 步 · 点击证据可定位</span>
            </div>
            <div class="tool-compare">
              <div class="compare-cell"><small>期望工具</small><code>${escapeHtml(expected.join(", ") || "无")}</code>${(item.expect?.forbid_tools || []).length ? `<small class="forbid">禁止：${escapeHtml(item.expect.forbid_tools.join(", "))}</small>` : ""}</div>
              <div class="compare-cell ${rule === "fail" && JSON.stringify(expected) !== JSON.stringify(actual) ? "is-bad" : ""}"><small>实际工具</small><code>${escapeHtml(actual.join(", ") || "无")}</code></div>
            </div>
            <ol class="trace-list">${(t.spans || []).map((s, i) => renderSpan(s, evidence, i)).join("")}</ol>
            <section class="answer-card">
              <div class="answer-label"><span>AGENT ANSWER</span><span>${escapeHtml(latencyLabel(t.latency_ms))}</span></div>
              <p class="answer-text">${escapeHtml(t.answer || "（无回答）")}</p>
            </section>
          </div>
          <aside class="evidence-column">
            ${renderAttribution(t)}
            <section class="side-card">${renderChecks(t)}</section>
            ${reviewHtml(row)}
          </aside>
        </div>
      </article>`;
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

    view.innerHTML = `
      <section class="page-head">
        <div>
          <p class="section-index"><a href="#/runs">运行记录</a> / ${escapeHtml(s.run_id)}</p>
          <h1 class="page-title">${escapeHtml(runLabel(s))} · ${escapeHtml(formatTime(s.generated_at))}</h1>
          <p class="muted">模型 ${escapeHtml(s.models.join(", "))} · ${s.llm_judge ? "双轨判定（规则 + LLM 忠实度）" : "仅规则轨"}</p>
        </div>
      </section>

      <section class="kpi-strip">
        <div class="kpi"><span>可靠性分</span><strong>${calibOnly ? '—<small> 注入集不计分</small>' : s.score.toFixed(1)}</strong></div>
        <div class="kpi"><span>通过</span><strong class="pass-text">${s.pass}</strong></div>
        <div class="kpi"><span>失败</span><strong class="fail-text">${s.fail}</strong></div>
        <div class="kpi"><span>跳过</span><strong>${s.skip}</strong></div>
        <div class="kpi"><span>人工复核</span><strong>${progress.done}<small> / ${progress.need}</small></strong></div>
      </section>

      ${calibrationHtml()}

      <section class="panel">
        <div class="panel-bar">
          <h2>缺陷热力图 <span class="muted small">维度 × 归因层，点格子筛选用例</span></h2>
          ${narrowing ? '<button type="button" class="ghost-button" id="clearFilter">清除筛选</button>' : ""}
        </div>
        ${s.fail ? heatmapHtml() : '<p class="muted">本次运行没有失败样本。</p>'}
      </section>

      <section class="workspace audit-workspace">
        <div class="workspace-grid">
          <aside class="case-panel" aria-label="用例清单">
            <div class="filters" role="group" aria-label="按判定筛选">
              ${filterBtn("all", "全部")}${filterBtn("fail", "失败")}${filterBtn("pass", "通过")}${s.skip ? filterBtn("skip", "跳过") : ""}
            </div>
            <select id="dimSelect" class="dim-select" aria-label="按维度筛选"><option value="">全部维度</option>${dims}</select>
            <div class="case-list" id="caseList">${caseListHtml()}</div>
          </aside>
          <section class="detail-panel" id="detailPanel">${detailHtml()}</section>
        </div>
      </section>
    `;
    bindRunEvents();
  }

  function selectFirstVisible() {
    const rows = rowsFiltered();
    const keys = rows.map((row) => rowKey(row, state.detail.rows.indexOf(row)));
    if (!keys.includes(state.selectedCase)) state.selectedCase = keys[0] || null;
  }

  function bindRunEvents() {
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
    $("#detailPanel").addEventListener("click", (e) => {
      const link = e.target.closest("[data-jump]");
      if (!link) return;
      const target = $(`[data-span-id="${CSS.escape(link.dataset.jump)}"]`, $("#detailPanel"));
      if (!target) return;
      target.classList.add("is-evidence");
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.animate(
        [{ boxShadow: "0 0 0 0 rgba(220,236,155,.75)" }, { boxShadow: "0 0 0 7px rgba(220,236,155,0)" }],
        { duration: 900, easing: "ease-out" },
      );
    });
    $("#reviewSubmit")?.addEventListener("click", submitReview);
  }

  async function submitReview() {
    const rows = state.detail.rows;
    const index = rows.findIndex((row, i) => rowKey(row, i) === state.selectedCase);
    const row = rows[index];
    const picks = [...view.querySelectorAll(".review-row select")].filter((s) => s.value);
    if (!picks.length) {
      showToast("至少给一项选择人工结论");
      return;
    }
    if (!reviewer()) {
      showToast("请先在右上角填写复核人");
      reviewerInput.focus();
      return;
    }
    const note = $("#reviewNote").value.trim();
    try {
      for (const select of picks) {
        const { label } = await api("/api/reviews", {
          method: "POST",
          body: JSON.stringify({
            trace_key: row.trace_key,
            case_id: row.trace.case_id,
            run_id: state.detail.summary.run_id,
            target: select.dataset.target,
            machine: select.dataset.machine,
            human: select.value,
            note,
            reviewer: reviewer(),
          }),
        });
        state.detail.labels[`${row.trace_key}|${label.target}`] = label;
      }
      showToast(`已保存 ${picks.length} 项复核`);
      renderRun();
    } catch (error) {
      showToast(`保存失败：${error.message}`);
    }
  }

  // ------------------------------------------------------------ compare view

  function sideCell(side, field) {
    if (!side) return '<td class="muted">—</td>';
    if (field === "verdict") return `<td><span class="verdict-pill ${verdictClass(side.verdict)}">${statusLabel(side.verdict)}</span></td>`;
    if (field === "layer") return `<td>${side.layer ? escapeHtml(side.layer) : '<span class="muted">—</span>'}</td>`;
    if (side.llm === null || side.llm === undefined) return '<td class="muted">—</td>';
    return `<td>${side.llm ? "忠实" : '<span class="fail-text">不忠实</span>'}${side.llm_score ? ` <span class="muted small">${side.llm_score}/5</span>` : ""}</td>`;
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
    const rows = items.map((i) => `
      <tr class="${i.changes.length ? "is-changed" : ""}">
        <td class="mono">${i.b ? `<a href="#/run/${encodeURIComponent(c.b.run_id)}/${encodeURIComponent(i.case_id)}">${escapeHtml(i.case_id)}</a>` : escapeHtml(i.case_id)}</td>
        <td>${escapeHtml(dimensionLabel(i.dimension))}</td>
        ${sideCell(i.a, "verdict")}${sideCell(i.a, "layer")}${sideCell(i.a, "llm")}
        ${sideCell(i.b, "verdict")}${sideCell(i.b, "layer")}${sideCell(i.b, "llm")}
        <td>${i.changes.map((x) => `<span class="tag warn">${escapeHtml(x)}</span>`).join(" ")}</td>
      </tr>`).join("");
    view.innerHTML = `
      <section class="page-head">
        <div>
          <p class="section-index"><a href="#/runs">运行记录</a> / 对比</p>
          <h1 class="page-title">运行对比</h1>
          <p class="muted">按用例对齐两次运行，标出判定、归因、LLM 结论与执行内容的变化。</p>
        </div>
      </section>
      <section class="panel cmp-head">
        ${head(c.a, "A")}
        <div class="cmp-delta"><span>B − A</span><strong class="${delta >= 0 ? "pass-text" : "fail-text"}">${delta >= 0 ? "+" : ""}${delta}</strong><div>${chips}</div></div>
        ${head(c.b, "B")}
      </section>
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

  // ------------------------------------------------------------ reviews view

  function kappaLabel(k) {
    if (k === null || k === undefined) return "样本不足";
    if (k < 0) return "低于随机";
    if (k < 0.21) return "轻微一致";
    if (k < 0.41) return "一般一致";
    if (k < 0.61) return "中等一致";
    if (k < 0.81) return "高度一致";
    return "几乎完全一致";
  }

  function renderReviews() {
    const r = state.reviews;
    const cards = Object.entries(r.targets).map(([target, s]) => `
      <article class="panel stat-card">
        <span class="section-index">${escapeHtml(target)}</span>
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
        <td class="mono"><a href="#/run/${encodeURIComponent(lb.run_id)}/${encodeURIComponent(lb.case_id)}">${escapeHtml(lb.case_id)}</a></td>
        <td>${escapeHtml(state.catalog.review_targets[lb.target] || lb.target)}</td>
        <td>${escapeHtml(valueLabel(lb.target, lb.machine))}</td>
        <td>${escapeHtml(valueLabel(lb.target, lb.human))}</td>
        <td>${lb.agree ? '<span class="tag ok">一致</span>' : '<span class="tag warn">不一致</span>'}</td>
        <td>${escapeHtml(lb.reviewer || "")}</td>
        <td>${escapeHtml(lb.note || "")}</td>
      </tr>`).join("");
    view.innerHTML = `
      <section class="page-head">
        <div>
          <p class="section-index">REVIEWS</p>
          <h1 class="page-title">人工复核</h1>
          <p class="muted">审计员对机器结论逐条标注「同意 / 改判」，这里统计机器与人工的一致率和 Cohen's κ。标注写入 reviews/labels.jsonl，同一 trace 只取最后一次。</p>
        </div>
      </section>
      <section class="stat-grid">${cards}</section>
      <section class="panel">
        <div class="panel-bar"><h2>标注明细 <span class="muted">${r.labels.length}</span></h2></div>
        ${r.labels.length ? `
          <div class="table-wrap">
            <table class="data-table">
              <thead><tr><th>时间</th><th>用例</th><th>目标</th><th>机器</th><th>人工</th><th>一致</th><th>复核人</th><th>备注</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
          </div>` : placeholder("还没有人工标注", "打开任意一次运行，在用例详情右侧的「人工复核」里标注")}
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
        setNav("runs");
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
      } else if (page === "reviews") {
        setNav("reviews");
        state.reviews = await api("/api/reviews");
        renderReviews();
      } else {
        setNav("runs");
        state.runs = (await api("/api/runs")).runs;
        state.detail = null;
        renderRuns();
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
  }

  boot();
})();
