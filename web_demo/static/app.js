(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const state = {
    catalog: null,
    run: null,
    selectedId: null,
    filter: "all",
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

  const refs = {
    runBtn: $("#runBtn"),
    runId: $("#runId"),
    runStatus: $("#runStatus"),
    runPulse: $("#runPulse"),
    metaAdapter: $("#metaAdapter"),
    metaModel: $("#metaModel"),
    metaCases: $("#metaCases"),
    scoreValue: $("#scoreValue"),
    ringValue: $("#ringValue"),
    scoreHeadline: $("#scoreHeadline"),
    scoreCaption: $("#scoreCaption"),
    kpiTotal: $("#kpiTotal"),
    kpiPass: $("#kpiPass"),
    kpiFail: $("#kpiFail"),
    defectTotal: $("#defectTotal"),
    defectBars: $("#defectBars"),
    filters: $("#filters"),
    caseCount: $("#caseCount"),
    caseList: $("#caseList"),
    detailPanel: $("#detailPanel"),
    toast: $("#toast"),
  };

  const RING_CIRCUMFERENCE = 2 * Math.PI * 54;

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
    if (typeof value === "string") return value;
    return JSON.stringify(value);
  }

  function prettyJson(value) {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  function dimensionLabel(id) {
    const found = state.catalog?.dimensions?.find((d) => d.id === id);
    return found?.label || id || "未知维度";
  }

  function layerName(code) {
    return state.catalog?.layers?.[code] || code || "";
  }

  function statusLabel(rule) {
    return { pass: "PASS", fail: "FAIL", skip: "SKIP" }[rule] || "SKIP";
  }

  function verdictClass(rule) {
    return ["pass", "fail", "skip"].includes(rule) ? rule : "skip";
  }

  function toolNames(trace) {
    return (trace.spans || []).filter((span) => span.span === "tool_call").map((span) => span.name);
  }

  function displayList(values) {
    return values.length ? values.join(", ") : "无工具调用";
  }

  function latencyLabel(value) {
    if (value === null || value === undefined) return "";
    if (value <= 0) return "<1ms";
    return `${Number(value).toFixed(1)}ms`;
  }

  function setText(node, text) {
    if (node) node.textContent = text;
  }

  function showToast(message) {
    if (!refs.toast) return;
    refs.toast.textContent = message;
    refs.toast.classList.add("is-visible");
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      refs.toast.classList.remove("is-visible");
    }, 4200);
  }

  function setBusy(busy) {
    state.busy = busy;
    document.body.classList.remove("is-finishing");
    document.body.classList.toggle("is-running", busy);
    refs.runBtn.disabled = busy;
    refs.runBtn.classList.toggle("is-loading", busy);
    refs.runBtn.querySelector("span").textContent = busy ? "体检中" : "重新体检";

    if (busy) {
      refs.runPulse.classList.remove("is-idle", "is-error");
      setText(refs.runStatus, "正在逐 span 执行与判定…");
    } else {
      window.setTimeout(() => {
        document.body.classList.add("is-finishing");
        window.setTimeout(() => document.body.classList.remove("is-running", "is-finishing"), 420);
      }, 80);
    }
  }

  function setRunMeta(run) {
    const metrics = run.metrics;
    const runFolder = String(run.out_dir || "").split("/").pop();
    setText(refs.runId, run.run_id);
    refs.runId.title = run.out_dir;
    setText(
      refs.runStatus,
      `${metrics.pass} PASS · ${metrics.fail} FAIL · 已落盘 ${runFolder || "results"}`,
    );
    refs.runPulse.classList.remove("is-idle", "is-error");
    setText(refs.metaCases, `${metrics.total} 条 / 7 维`);
  }

  function renderScoreboard() {
    const run = state.run;
    if (!run) return;
    const metrics = run.metrics;
    const score = Number(metrics.score || 0);
    const layers = metrics.layers || {};
    const layerEntries = Object.entries(layers);
    const maxCount = Math.max(1, ...layerEntries.map(([, count]) => count));

    setText(refs.scoreValue, score.toFixed(1));
    refs.ringValue.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, score)) / 100));
    refs.ringValue.style.stroke = score >= 75 ? "var(--green)" : score >= 50 ? "#a27322" : "var(--red)";

    setText(refs.kpiTotal, String(metrics.total));
    setText(refs.kpiPass, String(metrics.pass));
    setText(refs.kpiFail, String(metrics.fail));
    setText(refs.defectTotal, String(metrics.fail));

    if (metrics.fail === 0) {
      setText(refs.scoreHeadline, "本轮全部通过");
      setText(refs.scoreCaption, "所有 span 断言成立；报告仍保留完整证据链。");
    } else {
      const names = layerEntries
        .map(([code]) => `${code} ${layerName(code)}`)
        .join(" / ");
      setText(refs.scoreHeadline, `${metrics.pass} 条通过，${metrics.fail} 条待修复`);
      setText(refs.scoreCaption, names ? `缺陷已定位：${names}` : "失败样本尚待人工复核。");
    }

    if (!layerEntries.length) {
      refs.defectBars.innerHTML = `<p class="muted">本轮未发现失败样本。</p>`;
      return;
    }

    refs.defectBars.innerHTML = layerEntries
      .map(([code, count]) => `
        <div class="defect-row">
          <span class="layer-code">${escapeHtml(code)}</span>
          <div class="defect-track">
            <div class="defect-fill" style="width:${Math.max(12, (count / maxCount) * 100)}%"></div>
          </div>
          <span>${escapeHtml(layerName(code))} ×${count}</span>
        </div>
      `)
      .join("");
  }

  function renderFilterCounts() {
    const cases = state.run?.cases || [];
    const counts = {
      all: cases.length,
      fail: cases.filter(({ trace }) => trace.verdict.rule === "fail").length,
      pass: cases.filter(({ trace }) => trace.verdict.rule === "pass").length,
    };
    $$(".filter", refs.filters).forEach((button) => {
      const key = button.dataset.filter;
      const badge = button.querySelector("b");
      if (badge) badge.textContent = String(counts[key] ?? 0);
      button.classList.toggle("is-active", key === state.filter);
      button.setAttribute("aria-pressed", String(key === state.filter));
    });
  }

  function filteredCases() {
    const cases = state.run?.cases || [];
    if (state.filter === "all") return cases;
    return cases.filter(({ trace }) => trace.verdict.rule === state.filter);
  }

  function renderCaseList() {
    const cases = state.run?.cases || [];
    const visible = filteredCases();
    setText(refs.caseCount, `${visible.length} / ${cases.length}`);

    if (!visible.length) {
      refs.caseList.innerHTML = `<div class="is-empty-state">这个筛选下没有用例。</div>`;
      return;
    }

    refs.caseList.innerHTML = visible
      .map(({ case: item, trace }, index) => {
        const rule = verdictClass(trace.verdict.rule);
        const selected = item.id === state.selectedId;
        const layer = trace.layer
          ? `<span class="layer-mini">${escapeHtml(trace.layer)} ${escapeHtml(layerName(trace.layer))}</span>`
          : `<span class="layer-mini is-empty">${rule === "pass" ? "无缺陷" : "—"}</span>`;
        return `
          <button
            type="button"
            class="case-item is-${rule} ${selected ? "is-selected" : ""}"
            data-case-id="${escapeHtml(item.id)}"
            style="--i:${index}"
            aria-pressed="${selected}"
          >
            <span class="case-item-top">
              <span class="case-id">${escapeHtml(item.id)}</span>
              <span class="verdict-pill ${rule}">${statusLabel(trace.verdict.rule)}</span>
            </span>
            <span class="case-title">${escapeHtml(item.title || "未命名用例")}</span>
            <span class="case-bottom">
              <span class="dimension">${escapeHtml(dimensionLabel(item.dimension))}</span>
              ${layer}
            </span>
          </button>
        `;
      })
      .join("");
  }

  function spanSummary(span) {
    switch (span.span) {
      case "plan":
        return `意图：${escapeHtml(span.intent || "未记录")}`;
      case "tool_call":
        return `<span class="accent">${escapeHtml(span.name)}</span> 调用 <span class="${span.schema_ok ? "" : "schema-bad"}">${span.schema_ok ? "· schema OK" : "· schema 不通过"}</span>`;
      case "observation":
        return span.ok
          ? `返回正常${span.row_count !== null ? ` · ${escapeHtml(span.row_count)} 行` : ""}`
          : `<span class="span-error">工具报错：${escapeHtml(span.error || "未知错误")}</span>`;
      case "retrieve": {
        const hits = (span.chunk_ids || []).length;
        return `查询 “${escapeHtml(span.query)}” → ${hits ? `${hits} 个 chunk` : `<span class="span-error">零召回</span>`}`;
      }
      case "generate":
        return `生成回答 · 引用 ${(span.citations || []).length} 个证据`;
      case "guardrail":
        return span.triggered
          ? `<span class="span-error">${escapeHtml(span.action)}</span> · rule=${escapeHtml(span.rule || "unknown")}`
          : `allow <span class="accent">· 未触发</span>`;
      default:
        return escapeHtml(span.span || "");
    }
  }

  function spanDetails(span) {
    if (span.span === "plan") {
      const steps = span.steps || [];
      return steps.length
        ? steps.map((step) => `<span class="arg-chip"><b>step</b> ${escapeHtml(step)}</span>`).join("")
        : '<span class="arg-chip">无计划步骤</span>';
    }
    if (span.span === "tool_call") {
      const chips = Object.entries(span.args || {})
        .map(([key, value]) => `<span class="arg-chip"><b>${escapeHtml(key)}</b> ${escapeHtml(formatValue(value))}</span>`)
        .join("");
      const errors = (span.schema_errors || []).length
        ? `<span class="arg-chip span-error">${escapeHtml(span.schema_errors.join("; "))}</span>`
        : "";
      return chips + errors;
    }
    if (span.span === "observation") {
      const detail = span.error
        ? `<span class="arg-chip span-error">${escapeHtml(span.error)}</span>`
        : "";
      const raw = span.raw === null || span.raw === undefined
        ? ""
        : `
          <details class="raw-details">
            <summary>查看原始返回</summary>
            <pre>${escapeHtml(prettyJson(span.raw))}</pre>
          </details>
        `;
      return detail + raw;
    }
    if (span.span === "retrieve") {
      return (span.chunk_ids || [])
        .map((chunk, index) => `<span class="chunk-chip">${escapeHtml(chunk)} <i>${Number(span.scores?.[index] ?? 0).toFixed(2)}</i></span>`)
        .join("");
    }
    if (span.span === "generate") {
      return (span.citations || [])
        .map((citation) => `<span class="citation-chip">${escapeHtml(citation)}</span>`)
        .join("");
    }
    if (span.span === "guardrail") {
      return span.reason
        ? `<span class="arg-chip">${escapeHtml(span.reason)}</span>`
        : "";
    }
    return "";
  }

  function renderSpan(span, evidenceSet, index) {
    const isEvidence = evidenceSet.has(span.span_id);
    const latency = span.latency_ms ? `<span class="span-latency">${latencyLabel(span.latency_ms)}</span>` : "";
    const label = SPAN_LABELS[span.span] || span.span;
    return `
      <li
        class="span-node ${isEvidence ? "is-evidence" : ""}"
        data-span-id="${escapeHtml(span.span_id)}"
        style="--i:${index}"
      >
        <span class="span-icon" aria-hidden="true">${ICONS[span.span] || ICONS.plan}</span>
        <div class="span-body">
          <div class="span-line">
            <span class="span-kind">${escapeHtml(span.span.toUpperCase())} · ${escapeHtml(label)}</span>
            <span class="span-step">#${escapeHtml(span.step)}</span>
            ${isEvidence ? '<span class="evidence-tag">证据</span>' : ""}
            ${latency}
          </div>
          <div class="span-summary">${spanSummary(span)}</div>
          <div class="span-detail">${spanDetails(span)}</div>
        </div>
      </li>
    `;
  }

  function renderChecks(trace) {
    const checks = trace.verdict?.checks || [];
    if (!checks.length) {
      return `<p class="muted">本轮没有规则检查记录。</p>`;
    }
    const passed = checks.filter((check) => check.passed).length;
    const rows = checks
      .map((check) => {
        const evidence = (check.evidence || [])
          .map((id) => `<button type="button" class="evidence-link" data-jump="${escapeHtml(id)}">${escapeHtml(id)}</button>`)
          .join("");
        return `
          <div class="check-row ${check.passed ? "" : "is-bad"}">
            <span class="check-mark" aria-hidden="true">${check.passed ? "✓" : "×"}</span>
            <div>
              <div class="check-name">${escapeHtml(check.check)}</div>
              <div class="check-reason">${escapeHtml(check.reason)}</div>
              ${evidence ? `<div class="check-evidence">${evidence}</div>` : ""}
            </div>
          </div>
        `;
      })
      .join("");
    return `<div class="side-head"><h3>规则裁判</h3><span>${passed}/${checks.length} 通过</span></div><div class="check-list">${rows}</div>`;
  }

  function renderAttribution(trace) {
    const healthy = !trace.layer;
    const evidence = (trace.layer_evidence || [])
      .map((id) => `<button type="button" class="evidence-link" data-jump="${escapeHtml(id)}">${escapeHtml(id)}</button>`)
      .join("");
    return `
      <section class="attribution-card ${healthy ? "is-healthy" : ""}" id="attribution">
        <div class="attr-top">
          <span class="attr-code">${escapeHtml(trace.layer || "OK")}</span>
          <span class="attr-title">
            <small>${healthy ? "NO DEFECT" : "ROOT CAUSE"}</small>
            <strong>${healthy ? "未触发失败归因" : `${escapeHtml(trace.layer)} · ${escapeHtml(layerName(trace.layer))}`}</strong>
          </span>
        </div>
        <p class="attr-reason">${escapeHtml(
          healthy
            ? "全部 span 断言通过，没有失败样本需要归因。"
            : trace.layer_reason || "归因引擎未返回原因。"
        )}</p>
        ${evidence ? `<div class="attr-evidence"><span>EVIDENCE</span>${evidence}</div>` : ""}
      </section>
    `;
  }

  function renderDetail() {
    if (!state.run?.cases?.length) {
      refs.detailPanel.innerHTML = `<div class="detail-placeholder"><p>本轮没有可展示的用例。</p></div>`;
      return;
    }

    const found = state.run.cases.find(({ case: item }) => item.id === state.selectedId) || state.run.cases[0];
    const { case: item, trace } = found;
    const rule = verdictClass(trace.verdict.rule);
    const expected = item.expected_tools || [];
    const actual = toolNames(trace);
    const expectedText = displayList(expected);
    const actualText = displayList(actual);
    const toolMismatch = rule === "fail" && JSON.stringify(expected) !== JSON.stringify(actual);

    const evidenceSet = new Set(trace.layer_evidence || []);
    (trace.verdict?.checks || []).forEach((check) => {
      if (!check.passed) (check.evidence || []).forEach((id) => evidenceSet.add(id));
    });

    const citations = [...new Set(
      (trace.spans || [])
        .filter((span) => span.span === "generate")
        .flatMap((span) => span.citations || [])
    )];

    const layerBadge = trace.layer
      ? `<div class="layer-badge"><span class="code">${escapeHtml(trace.layer)}</span><span class="label"><small>ROOT CAUSE</small><strong>${escapeHtml(layerName(trace.layer))}</strong></span></div>`
      : `<div class="layer-badge is-healthy"><span class="code">OK</span><span class="label"><small>HEALTHY</small><strong>全部检查通过</strong></span></div>`;

    refs.detailPanel.innerHTML = `
      <article class="detail">
        <header class="case-hero">
          <div class="case-headline">
            <span class="status-badge ${rule}"><i></i>${statusLabel(trace.verdict.rule)}</span>
            <div>
              <div class="case-kicker"><b>${escapeHtml(item.id)}</b> · ${escapeHtml(dimensionLabel(item.dimension))} · ${escapeHtml(item.difficulty || "easy")}</div>
              <h2 class="case-h2">${escapeHtml(item.title || "未命名用例")}</h2>
            </div>
            ${layerBadge}
          </div>

          <div class="question">
            <span class="question-label">USER</span>
            <p>${escapeHtml(item.input_text || "")}</p>
          </div>

          <div class="meta-row">
            <span class="meta-chip">${escapeHtml(item.source || "golden")}</span>
            <span class="meta-chip">seed ${escapeHtml(trace.seed)}</span>
            <span class="meta-chip">${escapeHtml(trace.model)}</span>
            <span class="meta-chip">${escapeHtml(latencyLabel(trace.latency_ms) || "0ms")}</span>
            ${(item.tags || []).map((tag) => `<span class="meta-chip">#${escapeHtml(tag)}</span>`).join("")}
          </div>
        </header>

        <div class="detail-grid">
          <div class="trace-column">
            <div class="block-title">
              <span>执行链路</span>
              <span>${(trace.spans || []).length} SPANS · 点击证据可定位</span>
            </div>

            <div class="tool-compare">
              <div class="compare-cell">
                <small>EXPECTED TOOL</small>
                <code>${escapeHtml(expectedText)}</code>
              </div>
              <div class="compare-cell ${toolMismatch ? "is-bad" : ""}">
                <small>ACTUAL TOOL</small>
                <code>${escapeHtml(actualText)}</code>
              </div>
            </div>

            <ol class="trace-list">
              ${(trace.spans || []).map((span, index) => renderSpan(span, evidenceSet, index)).join("")}
            </ol>
          </div>

          <aside class="evidence-column">
            <section class="side-card">${renderChecks(trace)}</section>
            ${renderAttribution(trace)}
            <section class="answer-card">
              <div class="answer-label"><span>AGENT ANSWER</span><span>${escapeHtml(latencyLabel(trace.latency_ms) || "0ms")}</span></div>
              <p class="answer-text">${escapeHtml(trace.answer || "（无回答）")}</p>
              ${citations.length ? `<div class="answer-citations">${citations.map((c) => `<span class="citation-chip">${escapeHtml(c)}</span>`).join("")}</div>` : ""}
            </section>
          </aside>
        </div>
      </article>
    `;
  }

  function renderAll() {
    if (!state.run) return;
    renderScoreboard();
    renderFilterCounts();
    renderCaseList();
    renderDetail();
  }

  async function execute() {
    if (state.busy) return;
    const previous = state.selectedId;
    setBusy(true);
    try {
      const minimumDelay = new Promise((resolve) => window.setTimeout(resolve, 480));
      const request = fetch("/api/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ case_ids: [] }),
      });
      const [response] = await Promise.all([request, minimumDelay]);
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`服务返回了非 JSON 响应（HTTP ${response.status}）`);
      }
      if (!response.ok) throw new Error(payload.error || `执行失败（HTTP ${response.status}）`);

      state.run = payload.run;
      const hasPrevious = state.run.cases.some(({ case: item }) => item.id === previous);
      if (!hasPrevious) {
        const preferred = state.run.cases.find(({ trace }) => trace.layer === "L2")
          || state.run.cases.find(({ trace }) => trace.verdict.rule === "fail")
          || state.run.cases[0];
        state.selectedId = preferred?.case.id || null;
      }
      setRunMeta(state.run);
      renderAll();
    } catch (error) {
      setText(refs.runStatus, "执行失败，请查看提示");
      refs.runPulse.classList.add("is-error");
      refs.runPulse.classList.remove("is-idle");
      showToast(`无法完成体检：${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  function bindEvents() {
    refs.runBtn.addEventListener("click", execute);

    refs.filters.addEventListener("click", (event) => {
      const button = event.target.closest(".filter");
      if (!button || !state.run) return;
      state.filter = button.dataset.filter || "all";
      const visible = filteredCases();
      if (visible.length && !visible.some(({ case: item }) => item.id === state.selectedId)) {
        state.selectedId = visible[0].case.id;
      }
      renderFilterCounts();
      renderCaseList();
      renderDetail();
    });

    refs.caseList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-case-id]");
      if (!button || !state.run) return;
      state.selectedId = button.dataset.caseId;
      renderCaseList();
      renderDetail();
      if (window.innerWidth < 821) {
        refs.detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });

    refs.detailPanel.addEventListener("click", (event) => {
      const link = event.target.closest("[data-jump]");
      if (!link) return;
      const target = refs.detailPanel.querySelector(`[data-span-id="${CSS.escape(link.dataset.jump)}"]`);
      if (!target) return;
      target.classList.add("is-evidence");
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.animate(
        [
          { boxShadow: "0 0 0 0 rgba(220,236,155,.75)" },
          { boxShadow: "0 0 0 7px rgba(220,236,155,0)" },
        ],
        { duration: 900, easing: "ease-out" }
      );
    });
  }

  async function boot() {
    bindEvents();
    try {
      const response = await fetch("/api/catalog");
      if (!response.ok) throw new Error(`目录加载失败（HTTP ${response.status}）`);
      state.catalog = await response.json();
      setText(refs.metaAdapter, "CampusCopilot");
      setText(refs.metaModel, state.catalog.model || "rule-based@v0");
      setText(refs.metaCases, `${state.catalog.cases.length} 条 / 7 维`);
      await execute();
    } catch (error) {
      refs.runPulse.classList.add("is-error");
      setText(refs.runStatus, "无法连接本地执行器");
      refs.detailPanel.innerHTML = `
        <div class="detail-placeholder">
          <p>页面没能连上本地服务。</p>
          <p class="muted">${escapeHtml(error.message)}</p>
        </div>
      `;
      showToast(`启动失败：${error.message}`);
    }
  }

  boot();
})();
