(() => {
  const POLL_OVERVIEW_MS = 10_000;
  const POLL_CONV_MS = 2500;
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const initialMode =
    location.pathname === '/conversation' ||
    params.get('view') === 'aux' ||
    Boolean(window.sidecar?.conversationId)
      ? 'conversation'
      : 'overview';

  const state = {
    mode: initialMode,
    range: 'all',
    search: '',
    sort: 'recent',
    selectedConvId: window.sidecar?.conversationId || params.get('conversationId') || '',
    pinActive: true,
    turnsNewestFirst: true,
    overview: null,
    convData: null,
    timer: null,
  };

  // ---------- theme sync ----------
  function syncScheme() {
    const probe = document.createElement('span');
    probe.style.cssText = 'position:absolute;visibility:hidden;color:var(--background, #0f1115)';
    document.documentElement.appendChild(probe);
    const c = getComputedStyle(probe).color;
    probe.remove();
    const nums = (c.match(/[\d.]+/g) || []).map(Number);
    if (nums.length < 3) return;
    const scale = c.startsWith('color(') ? 1 : 255;
    const [r, g, b] = nums.slice(0, 3).map((v) => v / scale);
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.dataset.theme = lum < 0.5 ? 'dark' : 'light';
  }
  syncScheme();
  new MutationObserver(syncScheme).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style'],
  });

  // ---------- formatting helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K`;
    return String(Math.round(v));
  }

  function fmtPct(frac) {
    const v = Math.max(0, Math.min(1, Number(frac) || 0));
    return `${(v * 100).toFixed(v * 100 >= 10 || v === 0 ? 1 : 1)}%`;
  }

  function fmtDurationMs(ms) {
    const v = Number(ms) || 0;
    if (v <= 0) return '—';
    if (v < 1000) return `${Math.round(v)}ms`;
    const s = v / 1000;
    if (s < 60) return `${s.toFixed(1)}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${Math.round(s % 60)}s`;
  }

  function fmtResetCountdown(iso) {
    if (!iso) return '';
    const target = Date.parse(iso);
    if (!Number.isFinite(target)) return '';
    const diff = target - Date.now();
    if (diff <= 0) return 'Refreshing soon';
    const mins = Math.floor(diff / 60_000);
    const days = Math.floor(mins / (60 * 24));
    const hours = Math.floor((mins % (60 * 24)) / 60);
    const remMins = mins % 60;
    if (days > 0) return `Resets in ${days}d ${hours}h`;
    if (hours > 0) return `Resets in ${hours}h ${remMins}m`;
    return `Resets in ${Math.max(1, remMins)}m`;
  }

  function fmtRelativeTime(isoOrMs) {
    const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs || '');
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const diff = Date.now() - ms;
    if (diff < 60_000) return 'just now';
    const mins = Math.floor(diff / 60_000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  function fmtExactTime(iso) {
    if (!iso) return '';
    const ms = Date.parse(iso);
    return Number.isFinite(ms)
      ? new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
      : '';
  }

  function quotaTone(fraction) {
    if (fraction === null || fraction === undefined) return 'good';
    if (fraction <= 0.2) return 'danger';
    if (fraction <= 0.5) return 'warn';
    return 'good';
  }

  function statusBadge(status) {
    if (status === 'CASCADE_RUN_STATUS_RUNNING') {
      return '<span class="pill good">Active</span>';
    }
    return '<span class="pill">Idle</span>';
  }

  // ---------- network ----------
  async function getJson(path) {
    const f = window.sidecar?.fetch ? window.sidecar.fetch.bind(window.sidecar) : fetch;
    const res = await f(path, { method: 'GET' });
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return res.json();
  }

  function setError(msg) {
    const el = $('error-banner');
    if (!msg) {
      el.classList.add('hidden');
      el.textContent = '';
    } else {
      el.classList.remove('hidden');
      el.textContent = msg;
    }
  }

  function setLiveOk(ok) {
    const pill = $('live-pill');
    pill.classList.toggle('stale', !ok);
    $('live-label').textContent = ok ? 'Live' : 'Reconnecting';
  }

  // ---------- renderers: Overview ----------
  function renderBucketRow(b) {
    const frac = b.remainingFraction;
    const tone = quotaTone(frac);
    const pct = frac !== null ? `${(frac * 100).toFixed(1)}%` : '—';
    const widthPct = frac !== null ? Math.max(0, Math.min(100, frac * 100)) : 0;
    const countdown = fmtResetCountdown(b.resetTime);
    const exact = fmtExactTime(b.resetTime);
    const amountLabel = b.remainingAmount != null ? `${b.remainingAmount} left` : '';
    return `
      <div class="bucket-row" title="${esc(b.description || exact || b.displayName)}">
        <div class="bucket-top">
          <span class="bucket-name">${esc(b.displayName)}</span>
          <span class="bucket-pct">${esc(pct)}</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill ${tone}" style="width:${widthPct}%"></div>
        </div>
        <div class="bucket-meta">
          <span>${esc(amountLabel || (b.window ? `${b.window} window` : ''))}</span>
          <span title="${esc(exact)}">${esc(countdown)}</span>
        </div>
      </div>
    `;
  }

  function renderQuotas(quota) {
    const groupsEl = $('quota-groups');
    const noteEl = $('quota-note');
    const groups = quota?.groups || [];
    const topBuckets = quota?.buckets || [];

    if (groups.length > 0) {
      groupsEl.innerHTML = groups
        .map((g) => `
          <div class="card quota-group-card">
            <div>
              <div class="quota-group-title">${esc(g.displayName)}</div>
              ${g.description ? `<div class="quota-group-desc">${esc(g.description)}</div>` : ''}
            </div>
            ${(g.buckets || []).map(renderBucketRow).join('')}
          </div>
        `)
        .join('');
    } else if (topBuckets.length > 0) {
      groupsEl.innerHTML = `
        <div class="card quota-group-card">
          <div class="quota-group-title">Active Quotas</div>
          ${topBuckets.map(renderBucketRow).join('')}
        </div>
      `;
    } else if ((quota?.perModel || []).length > 0) {
      groupsEl.innerHTML = `
        <div class="card quota-group-card">
          <div class="quota-group-title">Model Quotas</div>
          ${quota.perModel.slice(0, 8).map((m) => renderBucketRow({
            displayName: m.displayName,
            remainingFraction: m.remainingFraction,
            resetTime: m.resetTime,
            window: m.tagTitle || '',
          })).join('')}
        </div>
      `;
    } else {
      groupsEl.innerHTML = '<div class="card empty-state"><span class="muted-text">Quota summary unavailable.</span></div>';
    }

    if (quota?.description) {
      noteEl.textContent = quota.description;
      noteEl.classList.remove('hidden');
    } else {
      noteEl.classList.add('hidden');
    }
  }

  function renderGlobalKpis(g) {
    const cachePct = fmtPct(g.cacheHitRate);
    $('global-kpis').innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Total Tokens</div>
        <div class="kpi-value">${esc(fmtTokens(g.totalTokens))}</div>
        <div class="kpi-sub">${esc(`${g.turnCount} turns · ${g.conversationCount} chats`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Uncached Input</div>
        <div class="kpi-value">${esc(fmtTokens(g.totalInputTokens))}</div>
        <div class="kpi-sub">${esc(`Cache read: ${fmtTokens(g.totalCacheReadTokens)}`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Cache Hit Rate</div>
        <div class="kpi-value">${esc(cachePct)}</div>
        <div class="kpi-sub">${esc(`${fmtTokens(g.totalCacheReadTokens)} cached`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Output Tokens</div>
        <div class="kpi-value">${esc(fmtTokens(g.totalOutputTokens))}</div>
        <div class="kpi-sub">${esc(`Think: ${fmtTokens(g.totalThinkingTokens)} · Resp: ${fmtTokens(g.totalResponseTokens)}`)}</div>
      </div>
    `;
  }

  function renderModelUsage(models, globalTotalTokens) {
    const el = $('model-usage-list');
    $('model-usage-count').textContent = `${models.length} used`;
    if (!models.length) {
      el.innerHTML = '<div class="empty-state muted-text">No model token usage recorded in this time window.</div>';
      return;
    }
    const maxTotal = Math.max(1, globalTotalTokens || models[0].totalTokens);
    el.innerHTML = models
      .map((m) => {
        const share = m.totalTokens / maxTotal;
        const t = Math.max(1, m.totalTokens);
        const cacheW = (m.cacheReadTokens / t) * 100;
        const inputW = (m.inputTokens / t) * 100;
        const outW = (m.outputTokens / t) * 100;
        const qFrac = m.quotaInfo?.remainingFraction;
        const qBadge = typeof qFrac === 'number'
          ? `<span class="pill ${quotaTone(qFrac)}">${esc((qFrac * 100).toFixed(0))}% quota</span>`
          : '';
        return `
          <div class="list-row">
            <div class="row-top">
              <span class="row-title">${esc(m.displayName)}</span>
              <div class="conv-actions">
                ${qBadge}
                <span class="pill accent">${esc(fmtTokens(m.totalTokens))} (${esc(fmtPct(share))})</span>
              </div>
            </div>
            <div class="stacked-bar" title="Cache Read / Uncached Input / Output">
              <div class="seg-cache" style="width:${cacheW}%"></div>
              <div class="seg-input" style="width:${inputW}%"></div>
              <div class="seg-output" style="width:${outW}%"></div>
            </div>
            <div class="row-metrics">
              <span><strong>${esc(m.turnCount)}</strong> turns</span>
              <span><strong>${esc(m.conversationCount)}</strong> chats</span>
              <span>In <strong>${esc(fmtTokens(m.inputTokens))}</strong></span>
              <span>Cache <strong>${esc(fmtTokens(m.cacheReadTokens))}</strong> (${esc(fmtPct(m.cacheHitRate))})</span>
              <span>Out <strong>${esc(fmtTokens(m.outputTokens))}</strong></span>
              ${m.thinkingTokens > 0 ? `<span>Think <strong>${esc(fmtTokens(m.thinkingTokens))}</strong></span>` : ''}
            </div>
          </div>
        `;
      })
      .join('');
  }

  function renderConversationsList(conversations) {
    const el = $('conversations-list');
    const q = state.search.trim().toLowerCase();
    let list = conversations.filter((c) => {
      if (!q) return true;
      return (
        c.title.toLowerCase().includes(q) ||
        c.primaryModel.toLowerCase().includes(q) ||
        (c.workspaceName || '').toLowerCase().includes(q) ||
        c.conversationId.toLowerCase().includes(q)
      );
    });

    if (state.sort === 'tokens') {
      list = [...list].sort((a, b) => b.totalTokens - a.totalTokens);
    } else if (state.sort === 'context') {
      list = [...list].sort((a, b) => b.contextUtilization - a.contextUtilization);
    } else {
      list = [...list].sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);
    }

    if (!list.length) {
      el.innerHTML = '<div class="empty-state muted-text">No matching conversations found.</div>';
      return;
    }

    const canToggleConv = Boolean(window.sidecar?.ui?.toggleConversation);
    el.innerHTML = list
      .map((c) => {
        const ctxPct = c.maxContextTokens > 0 ? Math.min(100, c.contextUtilization * 100) : 0;
        const ctxTone = c.contextUtilization > 0.85 ? 'danger' : c.contextUtilization > 0.65 ? 'warn' : 'good';
        return `
          <div class="list-row">
            <div class="row-top">
              <span class="row-title" title="${esc(c.title)}">${esc(c.title)}</span>
              <div class="conv-actions">
                ${statusBadge(c.status)}
                <button type="button" class="action-link" data-inspect-conv="${esc(c.conversationId)}">Inspect</button>
                ${canToggleConv ? `<button type="button" class="action-link" data-open-conv="${esc(c.conversationId)}">Open</button>` : ''}
              </div>
            </div>
            <div class="row-metrics">
              <span>${esc(c.primaryModel)}</span>
              ${c.workspaceName ? `<span>${esc(c.workspaceName)}</span>` : ''}
              <span>Total <strong>${esc(fmtTokens(c.totalTokens))}</strong></span>
              <span>Ctx <strong>${esc(fmtTokens(c.contextTokensUsed))}</strong> / ${esc(fmtTokens(c.maxContextTokens))} (${ctxPct.toFixed(0)}%)</span>
              <span>${esc(fmtRelativeTime(c.lastModifiedMs))}</span>
            </div>
            <div class="bar-track" title="Context window usage">
              <div class="bar-fill ${ctxTone}" style="width:${ctxPct}%"></div>
            </div>
          </div>
        `;
      })
      .join('');

    el.querySelectorAll('[data-inspect-conv]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.selectedConvId = btn.dataset.inspectConv;
        state.pinActive = false;
        switchMode('conversation');
      });
    });
    el.querySelectorAll('[data-open-conv]').forEach((btn) => {
      btn.addEventListener('click', () => {
        window.sidecar?.ui?.toggleConversation?.(btn.dataset.openConv);
      });
    });
  }

  function renderModelsCatalog(catalog) {
    $('catalog-count').textContent = `${catalog.length} models`;
    $('models-catalog').innerHTML = catalog
      .map((m) => {
        const qFrac = m.quotaInfo?.remainingFraction;
        const qBadge = typeof qFrac === 'number'
          ? `<span class="pill ${quotaTone(qFrac)}">${(qFrac * 100).toFixed(0)}% quota</span>`
          : '';
        return `
          <div class="card catalog-card">
            <div class="row-top">
              <span class="row-title">${esc(m.displayName)}</span>
              ${qBadge}
            </div>
            <div class="row-metrics">
              <span>Ctx <strong>${m.maxTokens ? esc(fmtTokens(m.maxTokens)) : '—'}</strong></span>
              <span>Max Out <strong>${m.maxOutputTokens ? esc(fmtTokens(m.maxOutputTokens)) : '—'}</strong></span>
              ${m.supportsThinking ? '<span class="pill">Thinking</span>' : ''}
              ${m.supportsImages ? '<span class="pill">Vision</span>' : ''}
            </div>
            ${m.quotaInfo?.resetTime ? `<div class="muted-text">${esc(fmtResetCountdown(m.quotaInfo.resetTime))}</div>` : ''}
          </div>
        `;
      })
      .join('');
  }

  function renderOverview() {
    const data = state.overview;
    if (!data) return;
    $('quota-updated').textContent = `Updated ${fmtRelativeTime(data.generatedAt)}`;
    renderQuotas(data.quota);
    renderGlobalKpis(data.globalTotals);
    renderModelUsage(data.modelUsage || [], data.globalTotals?.totalTokens || 0);
    renderConversationsList(data.conversations || []);
    renderModelsCatalog(data.modelsCatalog || []);
  }

  // ---------- renderers: Conversation Inspector ----------
  function renderTokenBreakdown(conv) {
    const el = $('ctx-breakdown');
    const tb = conv.tokenBreakdown;
    if (!tb || !tb.groups?.length) {
      el.innerHTML = '';
      return;
    }
    const denom = Math.max(1, tb.totalTokens || conv.contextTokensUsed);
    el.innerHTML = tb.groups
      .map((g) => {
        const pct = ((g.numTokens / denom) * 100).toFixed(1);
        const children = [...(g.children || [])].sort((a, b) => b.numTokens - a.numTokens);
        return `
          <details class="breakdown-group">
            <summary>
              <span>${esc(g.name)}</span>
              <span class="muted-text"><strong>${esc(fmtTokens(g.numTokens))}</strong> (${pct}%)</span>
            </summary>
            ${children.length ? `
              <div class="breakdown-children">
                ${children.slice(0, 40).map((ch) => `
                  <div class="breakdown-child">
                    <span class="breakdown-child-name" title="${esc(ch.name)}">${esc(ch.name)}</span>
                    <span>${esc(fmtTokens(ch.numTokens))}</span>
                  </div>
                `).join('')}
              </div>
            ` : ''}
          </details>
        `;
      })
      .join('');
  }

  function renderTurnChart(turns) {
    const el = $('turn-chart-card');
    if (!turns.length) {
      el.innerHTML = '<div class="muted-text">No LLM turns recorded yet.</div>';
      return;
    }
    const slice = turns.slice(-48);
    const maxCtx = Math.max(1, ...slice.map((t) => t.contextTokens + t.outputTokens));
    el.innerHTML = `
      <div class="chart-bars" role="img" aria-label="Token usage per turn">
        ${slice.map((t) => {
          const cacheH = Math.max(1, Math.round((t.cacheReadTokens / maxCtx) * 70));
          const inH = Math.max(t.inputTokens > 0 ? 2 : 0, Math.round((t.inputTokens / maxCtx) * 70));
          const outH = Math.max(t.outputTokens > 0 ? 2 : 0, Math.round((t.outputTokens / maxCtx) * 70));
          const tip = `Turn ${t.turnNumber} (${t.modelDisplayName}): Context ${fmtTokens(t.contextTokens)} | New In ${fmtTokens(t.inputTokens)} | Cache ${fmtTokens(t.cacheReadTokens)} | Out ${fmtTokens(t.outputTokens)}`;
          return `
            <div class="chart-col" title="${esc(tip)}">
              ${outH ? `<div class="chart-col-fill seg-output" style="height:${outH}px"></div>` : ''}
              ${inH ? `<div class="chart-col-fill seg-input" style="height:${inH}px"></div>` : ''}
              ${cacheH ? `<div class="chart-col-fill seg-cache" style="height:${cacheH}px"></div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
      <div class="chart-caption">
        <span>Turn ${slice[0].turnNumber} → Turn ${slice[slice.length - 1].turnNumber}</span>
        <span>Peak: ${esc(fmtTokens(maxCtx))}</span>
      </div>
    `;
  }

  function renderConversation() {
    const payload = state.convData;
    if (!payload) return;

    // Populate conversation picker
    const picker = $('conv-picker');
    const list = payload.conversations || [];
    picker.innerHTML = list.length
      ? list
          .map((c) => `<option value="${esc(c.conversationId)}">${esc(c.title)}</option>`)
          .join('')
      : '<option value="">No conversations found</option>';
    if (payload.conversationId) picker.value = payload.conversationId;

    const pinWrap = $('pin-active-wrap');
    if (window.sidecar?.conversationId) {
      pinWrap.classList.remove('hidden');
      $('pin-active').checked = state.pinActive;
    } else {
      pinWrap.classList.add('hidden');
    }

    const conv = payload.conversation;
    if (!conv) {
      $('conv-empty').classList.remove('hidden');
      $('conv-body').classList.add('hidden');
      $('conv-meta-row').innerHTML = '';
      return;
    }

    $('conv-empty').classList.add('hidden');
    $('conv-body').classList.remove('hidden');

    const canOpenChat = Boolean(window.sidecar?.ui?.toggleConversation);
    $('conv-meta-row').innerHTML = `
      ${statusBadge(conv.status)}
      <span class="pill accent">${esc(conv.primaryModel)}</span>
      ${conv.workspaceName ? `<span class="pill">${esc(conv.workspaceName)}</span>` : ''}
      <span class="pill">${esc(`${conv.turnCount} turns · ${conv.stepCount} steps`)}</span>
      ${canOpenChat && conv.conversationId !== window.sidecar?.conversationId
        ? `<button type="button" id="open-selected-conv" class="action-link">Open Chat</button>`
        : ''}
    `;
    const openBtn = $('open-selected-conv');
    if (openBtn) {
      openBtn.addEventListener('click', () => window.sidecar.ui.toggleConversation(conv.conversationId));
    }

    // Context Window Gauge
    const maxCtx = Math.max(1, conv.maxContextTokens || 1_000_000);
    const usedCtx = conv.contextTokensUsed || 0;
    const utilPct = Math.min(100, (usedCtx / maxCtx) * 100);
    $('ctx-headline').textContent = `${fmtTokens(usedCtx)} / ${fmtTokens(maxCtx)} tokens`;
    const badge = $('ctx-pct-badge');
    badge.textContent = `${utilPct.toFixed(1)}%`;
    badge.className = `pct-badge ${utilPct > 85 ? 'danger' : utilPct > 65 ? 'warn' : ''}`;

    const latestTotal = conv.latestCacheReadTokens + conv.latestUncachedInputTokens;
    const cacheShare = latestTotal > 0 ? (conv.latestCacheReadTokens / latestTotal) * utilPct : utilPct;
    const inputShare = Math.max(0, utilPct - cacheShare);
    const ctxBar = $('ctx-bar');
    ctxBar.setAttribute('aria-valuenow', utilPct.toFixed(0));
    ctxBar.innerHTML = `
      <div class="seg-cache" style="width:${cacheShare}%"></div>
      <div class="seg-input" style="width:${inputShare}%"></div>
    `;

    $('ctx-legend').innerHTML = `
      <span class="legend-item"><span class="swatch seg-cache"></span>Cached: <strong>${esc(fmtTokens(conv.latestCacheReadTokens))}</strong></span>
      <span class="legend-item"><span class="swatch seg-input"></span>New Input: <strong>${esc(fmtTokens(conv.latestUncachedInputTokens))}</strong></span>
      <span class="legend-item">Remaining: <strong>${esc(fmtTokens(Math.max(0, maxCtx - usedCtx)))}</strong></span>
    `;

    const truncEl = $('ctx-truncation');
    if (conv.truncationReason) {
      truncEl.textContent = `Context compacted (${conv.truncationReason.replace(/^TRUNCATION_REASON_/, '')})`;
      truncEl.classList.remove('hidden');
    } else {
      truncEl.classList.add('hidden');
    }

    renderTokenBreakdown(conv);

    // Cumulative KPIs (2x2)
    $('conv-kpis').innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label">Total Tokens</div>
        <div class="kpi-value">${esc(fmtTokens(conv.totalTokens))}</div>
        <div class="kpi-sub">${esc(`Uncached In: ${fmtTokens(conv.totalInputTokens)}`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Cache Hit Rate</div>
        <div class="kpi-value">${esc(fmtPct(conv.cacheHitRate))}</div>
        <div class="kpi-sub">${esc(`Read: ${fmtTokens(conv.totalCacheReadTokens)}${conv.totalCacheWriteTokens ? ` · Write: ${fmtTokens(conv.totalCacheWriteTokens)}` : ''}`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Output Tokens</div>
        <div class="kpi-value">${esc(fmtTokens(conv.totalOutputTokens))}</div>
        <div class="kpi-sub">${esc(`Think: ${fmtTokens(conv.totalThinkingTokens)} · Resp: ${esc(fmtTokens(conv.totalResponseTokens))}`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">Avg TTFT &amp; Stream</div>
        <div class="kpi-value">${esc(fmtDurationMs(conv.avgTtftMs))}</div>
        <div class="kpi-sub">${esc(`Stream: ${fmtDurationMs(conv.totalStreamingMs)}${conv.totalRetries ? ` · ${conv.totalRetries} retries` : ''}`)}</div>
      </div>
    `;

    // Models used in conversation
    const modelsEl = $('conv-models');
    const cModels = conv.modelsUsed || [];
    if (!cModels.length) {
      modelsEl.innerHTML = '<div class="empty-state muted-text">No model attribution metadata available yet.</div>';
    } else {
      const denom = Math.max(1, conv.totalTokens);
      modelsEl.innerHTML = cModels
        .map((m) => `
          <div class="list-row">
            <div class="row-top">
              <span class="row-title">${esc(m.displayName)}</span>
              <span class="pill accent">${esc(fmtTokens(m.totalTokens))} (${esc(fmtPct(m.totalTokens / denom))})</span>
            </div>
            <div class="row-metrics">
              <span><strong>${esc(m.turns)}</strong> turns</span>
              <span>In <strong>${esc(fmtTokens(m.inputTokens))}</strong></span>
              <span>Cache <strong>${esc(fmtTokens(m.cacheReadTokens))}</strong></span>
              <span>Out <strong>${esc(fmtTokens(m.outputTokens))}</strong></span>
              ${m.thinkingTokens > 0 ? `<span>Think <strong>${esc(fmtTokens(m.thinkingTokens))}</strong></span>` : ''}
            </div>
          </div>
        `)
        .join('');
    }

    // Turn chart & list
    renderTurnChart(conv.turns || []);
    $('turn-order-btn').textContent = state.turnsNewestFirst ? 'Newest first' : 'Chronological';
    const orderedTurns = state.turnsNewestFirst ? [...(conv.turns || [])].reverse() : (conv.turns || []);
    const turnsEl = $('turns-list');
    if (!orderedTurns.length) {
      turnsEl.innerHTML = '<div class="empty-state muted-text">No turns recorded yet.</div>';
    } else {
      turnsEl.innerHTML = orderedTurns
        .map((t) => `
          <div class="list-row">
            <div class="row-top">
              <span class="row-title">Turn ${t.turnNumber} · ${esc(t.modelDisplayName)}</span>
              <span class="muted-text" title="${esc(fmtExactTime(t.timestamp))}">${esc(fmtRelativeTime(t.timestamp))}</span>
            </div>
            <div class="row-metrics">
              <span>Ctx <strong>${esc(fmtTokens(t.contextTokens))}</strong></span>
              <span>+In <strong>${esc(fmtTokens(t.inputTokens))}</strong></span>
              <span>Cache <strong>${esc(fmtTokens(t.cacheReadTokens))}</strong></span>
              <span>Out <strong>${esc(fmtTokens(t.outputTokens))}</strong>${t.thinkingTokens ? ` (${esc(fmtTokens(t.thinkingTokens))} think)` : ''}</span>
              ${t.ttftMs ? `<span>TTFT <strong>${esc(fmtDurationMs(t.ttftMs))}</strong></span>` : ''}
            </div>
            ${t.tools?.length ? `
              <div class="turn-tools">
                ${t.tools.map((tc) => `<span class="tool-chip" title="${esc(tc.summary || tc.name)}">${esc(tc.name)}${tc.summary ? `: ${esc(tc.summary)}` : ''}</span>`).join('')}
              </div>
            ` : ''}
          </div>
        `)
        .join('');
    }
  }

  // ---------- data loading & polling ----------
  async function loadOverview(forceQuota = false) {
    try {
      const qs = new URLSearchParams({ range: state.range });
      if (forceQuota) qs.set('refresh', '1');
      const data = await getJson(`/api/overview?${qs.toString()}`);
      state.overview = data;
      setError('');
      setLiveOk(true);
      renderOverview();
    } catch (err) {
      setLiveOk(false);
      setError(`Failed to load usage overview: ${err.message}`);
    }
  }

  async function loadConversation() {
    try {
      if (state.pinActive && window.sidecar?.conversationId) {
        state.selectedConvId = window.sidecar.conversationId;
      }
      const qs = new URLSearchParams();
      if (state.selectedConvId) qs.set('conversationId', state.selectedConvId);
      const data = await getJson(`/api/conversation?${qs.toString()}`);
      state.convData = data;
      if (!state.selectedConvId && data.conversationId) {
        state.selectedConvId = data.conversationId;
      }
      setError('');
      setLiveOk(true);
      renderConversation();
    } catch (err) {
      setLiveOk(false);
      setError(`Failed to load conversation usage: ${err.message}`);
    }
  }

  function schedulePoll() {
    if (state.timer) clearInterval(state.timer);
    const interval = state.mode === 'overview' ? POLL_OVERVIEW_MS : POLL_CONV_MS;
    state.timer = setInterval(() => {
      if (document.hidden) return;
      if (state.mode === 'overview') loadOverview(false);
      else loadConversation();
    }, interval);
  }

  function switchMode(mode) {
    state.mode = mode;
    $('tab-overview').classList.toggle('active', mode === 'overview');
    $('tab-overview').setAttribute('aria-selected', String(mode === 'overview'));
    $('tab-conversation').classList.toggle('active', mode === 'conversation');
    $('tab-conversation').setAttribute('aria-selected', String(mode === 'conversation'));
    $('view-overview').classList.toggle('hidden', mode !== 'overview');
    $('view-conversation').classList.toggle('hidden', mode !== 'conversation');
    if (mode === 'overview') loadOverview(false);
    else loadConversation();
    schedulePoll();
  }

  // ---------- event wiring ----------
  $('tab-overview').addEventListener('click', () => switchMode('overview'));
  $('tab-conversation').addEventListener('click', () => switchMode('conversation'));

  $('refresh-btn').addEventListener('click', () => {
    if (state.mode === 'overview') loadOverview(true);
    else loadConversation();
  });

  document.querySelectorAll('.seg-btn[data-range]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.range = btn.dataset.range;
      document.querySelectorAll('.seg-btn[data-range]').forEach((b) => {
        b.classList.toggle('active', b === btn);
      });
      loadOverview(false);
    });
  });

  $('conv-search').addEventListener('input', (e) => {
    state.search = e.target.value;
    if (state.overview) renderConversationsList(state.overview.conversations || []);
  });

  $('conv-sort').addEventListener('change', (e) => {
    state.sort = e.target.value;
    if (state.overview) renderConversationsList(state.overview.conversations || []);
  });

  $('conv-picker').addEventListener('change', (e) => {
    state.selectedConvId = e.target.value;
    state.pinActive = Boolean(window.sidecar?.conversationId && state.selectedConvId === window.sidecar.conversationId);
    loadConversation();
  });

  $('pin-active').addEventListener('change', (e) => {
    state.pinActive = e.target.checked;
    if (state.pinActive && window.sidecar?.conversationId) {
      state.selectedConvId = window.sidecar.conversationId;
      loadConversation();
    }
  });

  $('turn-order-btn').addEventListener('click', () => {
    state.turnsNewestFirst = !state.turnsNewestFirst;
    renderConversation();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (state.mode === 'overview') loadOverview(false);
      else loadConversation();
    }
  });

  // Initial load
  switchMode(state.mode);
})();
