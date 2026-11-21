(() => {
  const POLL_OVERVIEW_MS = 10_000;
  const POLL_CONV_MS = 2500;
  const PREFS_KEY = 'usageMonitor.prefs.v1';
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);

  const DEFAULT_PREFS = {
    defaultToSimple: false,
    creditPricePer1k: 10.0,
    simpleWidgets: {
      contextGauge: true,
      tokenSummary: true,
      quotas: true,
      credits: true,
      breakdown: false,
      topModels: false,
      recentChats: false,
    },
  };

  function loadPrefs() {
    try {
      const raw = localStorage.getItem(PREFS_KEY);
      if (!raw) return structuredClone(DEFAULT_PREFS);
      const parsed = JSON.parse(raw);
      return {
        defaultToSimple: Boolean(parsed?.defaultToSimple),
        creditPricePer1k:
          Number.isFinite(Number(parsed?.creditPricePer1k)) && Number(parsed.creditPricePer1k) >= 0
            ? Number(parsed.creditPricePer1k)
            : DEFAULT_PREFS.creditPricePer1k,
        simpleWidgets: {
          ...DEFAULT_PREFS.simpleWidgets,
          ...(parsed?.simpleWidgets || {}),
        },
      };
    } catch {
      return structuredClone(DEFAULT_PREFS);
    }
  }

  function savePrefs() {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage failures inside restricted iframes.
    }
  }

  const prefs = loadPrefs();
  const explicitView = params.get('view');
  const defaultModeFromHost =
    location.pathname === '/conversation' ||
    explicitView === 'aux' ||
    Boolean(window.sidecar?.conversationId)
      ? 'conversation'
      : 'overview';
  const initialMode =
    explicitView === 'simple'
      ? 'simple'
      : explicitView === 'aux' || explicitView === 'overview'
        ? defaultModeFromHost
        : prefs.defaultToSimple
          ? 'simple'
          : defaultModeFromHost;

  const state = {
    mode: initialMode,
    range: 'all',
    search: '',
    sort: 'recent',
    selectedConvId: window.sidecar?.conversationId || params.get('conversationId') || '',
    pinActive: true,
    turnsNewestFirst: true,
    customizeOpen: false,
    overview: null,
    convData: null,
    timer: null,
    lastOverviewFetchMs: 0,
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

  // ---------- formatting & tooltip helpers ----------
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));

  const infoTip = (text) =>
    `<button type="button" class="info-btn" data-tip="${esc(text)}" aria-label="More info">i</button>`;

  function fmtTokens(n) {
    const v = Number(n) || 0;
    if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(v >= 100_000 ? 0 : 1)}K`;
    return String(Math.round(v));
  }

  function fmtNum(n) {
    return Math.round(Number(n) || 0).toLocaleString();
  }

  function fmtUsd(amount) {
    const v = Number(amount) || 0;
    if (v <= 0) return '$0.00';
    if (v < 0.01) return `$${v.toFixed(4)}`;
    if (v < 1) return `$${v.toFixed(3)}`;
    return `$${v.toFixed(2)}`;
  }

  function creditsToUsd(credits) {
    return ((Number(credits) || 0) / 1000) * (Number(prefs.creditPricePer1k) || 0);
  }

  function fmtPct(frac) {
    const v = Math.max(0, Math.min(1, Number(frac) || 0));
    return `${(v * 100).toFixed(1)}%`;
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

  // ---------- viewport-clamped floating tooltip ----------
  function initTooltips() {
    const tipEl = $('floating-tooltip');
    let activeTrigger = null;

    function showTip(trigger) {
      const text = trigger?.dataset?.tip;
      if (!text) return;
      activeTrigger = trigger;
      tipEl.textContent = text;
      tipEl.classList.remove('hidden');

      const pad = 8;
      const rect = trigger.getBoundingClientRect();
      const tipRect = tipEl.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let left = rect.left + rect.width / 2 - tipRect.width / 2;
      left = Math.max(pad, Math.min(vw - tipRect.width - pad, left));

      let top = rect.bottom + 6;
      if (top + tipRect.height + pad > vh && rect.top - tipRect.height - 6 >= pad) {
        top = rect.top - tipRect.height - 6;
      }
      top = Math.max(pad, Math.min(vh - tipRect.height - pad, top));

      tipEl.style.left = `${Math.round(left)}px`;
      tipEl.style.top = `${Math.round(top)}px`;
    }

    function hideTip() {
      activeTrigger = null;
      tipEl.classList.add('hidden');
    }

    document.addEventListener('mouseover', (e) => {
      const btn = e.target.closest?.('.info-btn');
      if (btn) showTip(btn);
    });
    document.addEventListener('mouseout', (e) => {
      const btn = e.target.closest?.('.info-btn');
      if (btn && btn === activeTrigger) hideTip();
    });
    document.addEventListener('focusin', (e) => {
      const btn = e.target.closest?.('.info-btn');
      if (btn) showTip(btn);
    });
    document.addEventListener('focusout', (e) => {
      const btn = e.target.closest?.('.info-btn');
      if (btn) hideTip();
    });
    document.addEventListener('click', (e) => {
      const btn = e.target.closest?.('.info-btn');
      if (btn) {
        e.preventDefault();
        if (activeTrigger === btn && !tipEl.classList.contains('hidden')) hideTip();
        else showTip(btn);
      } else if (activeTrigger) {
        hideTip();
      }
    });
    window.addEventListener('scroll', hideTip, true);
  }
  initTooltips();

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

  // ---------- shared HTML builders ----------
  function renderQuotaLegendHtml() {
    return `
      <div class="legend-bar" aria-label="Quota color legend">
        <span class="legend-item"><span class="swatch good"></span>Healthy (&gt;50%)</span>
        <span class="legend-item"><span class="swatch warn"></span>Getting low (20–50%)</span>
        <span class="legend-item"><span class="swatch danger"></span>Nearly empty (≤20%)</span>
      </div>
    `;
  }

  function renderTokenLegendHtml({ includeOutput = true, includeRemaining = false } = {}) {
    return `
      <div class="legend-bar" aria-label="Token color legend">
        <span class="legend-item">
          <span class="swatch seg-cache"></span>Cached Context
          ${infoTip('Previously seen prompt/conversation prefix reused from prompt cache (cheaper & faster than new input).')}
        </span>
        <span class="legend-item">
          <span class="swatch seg-input"></span>New Input
          ${infoTip('Uncached tokens newly processed in each turn (new user messages, tool results, and read files).')}
        </span>
        ${includeOutput ? `
          <span class="legend-item">
            <span class="swatch seg-output"></span>Output
            ${infoTip('Tokens generated by the model (includes both hidden thinking/reasoning tokens and visible responses).')}
          </span>
        ` : ''}
        ${includeRemaining ? `
          <span class="legend-item"><span class="swatch" style="background:var(--surface-2);border:1px solid var(--line)"></span>Free Window</span>
        ` : ''}
      </div>
    `;
  }

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

  function renderBreakdownHtml(conv) {
    const tb = conv?.tokenBreakdown;
    if (!tb || !tb.groups?.length) return '';
    const denom = Math.max(1, tb.totalTokens || conv.contextTokensUsed);
    return `
      <div class="breakdown-wrap">
        <div class="card-label">
          <span>Context Breakdown</span>
          ${infoTip('Shows what fills the current prompt window: System instructions, Tool schemas, and Chat messages/tool outputs.')}
        </div>
        ${tb.groups
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
          .join('')}
      </div>
    `;
  }

  function renderContextGaugeHtml(conv, { showBreakdown = true } = {}) {
    if (!conv) return '';
    const maxCtx = Math.max(1, conv.maxContextTokens || 1_000_000);
    const usedCtx = conv.contextTokensUsed || 0;
    const utilFrac = Math.min(1, usedCtx / maxCtx);
    const utilPct = utilFrac * 100;
    const remaining = Math.max(0, maxCtx - usedCtx);

    const latestTotal = conv.latestCacheReadTokens + conv.latestUncachedInputTokens;
    const cacheShare = latestTotal > 0 ? (conv.latestCacheReadTokens / latestTotal) * utilPct : utilPct;
    const inputShare = Math.max(0, utilPct - cacheShare);

    let compClass = 'good';
    let compMsg = `${fmtTokens(remaining)} free before max context — plenty of room.`;
    if (utilFrac >= 0.85) {
      compClass = 'danger';
      compMsg = `Near limit (${fmtTokens(remaining)} left) — good time to spin up a new conversation before compaction.`;
    } else if (utilFrac >= 0.65) {
      compClass = 'warn';
      compMsg = `Filling up (${fmtTokens(remaining)} left) — consider starting a fresh chat soon for best recall.`;
    }

    return `
      <div class="card-head">
        <div>
          <div class="card-label">
            <span>Context Window</span>
            ${infoTip('Current prompt size sent to the model on the latest turn out of the maximum context window before automatic compaction.')}
          </div>
          <div class="ctx-headline">${esc(fmtTokens(usedCtx))} / ${esc(fmtTokens(maxCtx))} tokens</div>
        </div>
        <div class="pct-badge ${utilPct > 85 ? 'danger' : utilPct > 65 ? 'warn' : ''}">${utilPct.toFixed(1)}%</div>
      </div>
      <div class="ctx-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${utilPct.toFixed(0)}">
        <div class="seg-cache" style="width:${cacheShare}%"></div>
        <div class="seg-input" style="width:${inputShare}%"></div>
      </div>
      <div class="ctx-legend">
        <span class="legend-item"><span class="swatch seg-cache"></span>Cached: <strong>${esc(fmtTokens(conv.latestCacheReadTokens))}</strong></span>
        <span class="legend-item"><span class="swatch seg-input"></span>New Input: <strong>${esc(fmtTokens(conv.latestUncachedInputTokens))}</strong></span>
        <span class="legend-item">Remaining: <strong>${esc(fmtTokens(remaining))}</strong></span>
      </div>
      <div class="compaction-status ${compClass}">${esc(compMsg)}</div>
      ${conv.truncationReason ? `<div class="truncation-alert">Context compacted (${esc(conv.truncationReason.replace(/^TRUNCATION_REASON_/, ''))})</div>` : ''}
      ${showBreakdown ? renderBreakdownHtml(conv) : ''}
    `;
  }

  function renderCreditsAnalysisHtml({
    creditsStatus,
    creditsUsed = 0,
    creditBilledTurns = 0,
    quotaCoveredTurns = 0,
    estApiCostUsd = 0,
    estCacheSavingsUsd = 0,
    scopeLabel = 'Scope',
    rateInputId = '',
  }) {
    const avail = creditsStatus?.totalAvailableCredits || 0;
    const planName = creditsStatus?.planName || 'Antigravity';
    const spentUsd = creditsToUsd(creditsUsed);
    const availUsd = creditsToUsd(avail);
    const totalTurns = creditBilledTurns + quotaCoveredTurns;
    const minReq = creditsStatus?.availableCredits?.[0]?.minimumCreditAmountForUsage || 0;

    return `
      <div class="credits-top">
        <div class="head-with-tip">
          <span class="pill accent">${esc(planName)}</span>
          ${creditsUsed > 0
            ? `<span class="pill credit">⚡ ${esc(fmtNum(creditsUsed))} credits spent</span>`
            : `<span class="pill good">100% Quota-covered</span>`}
        </div>
        <span class="muted-text">${esc(`${creditBilledTurns}/${totalTurns} turns billed credits`)}</span>
      </div>
      <div class="credits-grid">
        <div class="credit-stat">
          <div class="credit-stat-label">
            <span>Available AI Credits</span>
            ${infoTip('Your remaining Google AI credit pool (used automatically when a model quota hits its limit or when AI credits are enabled).')}
          </div>
          <div class="credit-stat-value">${esc(fmtNum(avail))} cr</div>
          <div class="credit-stat-sub">Est. value: <span class="credit-usd-val" data-credits="${avail}">${esc(fmtUsd(availUsd))}</span>${minReq ? ` · Min ${minReq}` : ''}</div>
        </div>
        <div class="credit-stat">
          <div class="credit-stat-label">
            <span>Credits Spent (${esc(scopeLabel)})</span>
            ${infoTip('Actual GOOGLE_ONE_AI credits deducted on turns in this scope. Turns covered by your plan quota show 0 credits.')}
          </div>
          <div class="credit-stat-value">${esc(fmtNum(creditsUsed))} cr</div>
          <div class="credit-stat-sub">Est. value: <span class="credit-usd-val" data-credits="${creditsUsed}">${esc(fmtUsd(spentUsd))}</span></div>
        </div>
        <div class="credit-stat">
          <div class="credit-stat-label">
            <span>Est. API Equivalent</span>
            ${infoTip('What the exact same uncached input, cached read, and output tokens would cost on pay-as-you-go LLM API pricing (approximate reference rates).')}
          </div>
          <div class="credit-stat-value">${esc(fmtUsd(estApiCostUsd))}</div>
          <div class="credit-stat-sub">Cache saved ~${esc(fmtUsd(estCacheSavingsUsd))}</div>
        </div>
      </div>
      <div class="credits-footer">
        <span>${esc(`${quotaCoveredTurns} quota turns · ${creditBilledTurns} credit turns`)}</span>
        ${rateInputId ? `
          <label class="rate-control" title="Used to convert AI credits into dollar value (Google AI Pro top-up reference is ~$10 per 1,000 credits)">
            <span>$ / 1K credits:</span>
            <input id="${esc(rateInputId)}" type="number" step="0.5" min="0" class="input sm rate-input" value="${esc(prefs.creditPricePer1k)}">
          </label>
        ` : ''}
      </div>
    `;
  }

  function wireRateInput(inputId) {
    const el = $(inputId);
    if (!el) return;
    el.addEventListener('input', () => {
      const val = Number(el.value);
      if (!Number.isFinite(val) || val < 0) return;
      prefs.creditPricePer1k = val;
      savePrefs();
      document.querySelectorAll('.rate-input').forEach((other) => {
        if (other !== el) other.value = String(val);
      });
      document.querySelectorAll('.credit-usd-val[data-credits]').forEach((span) => {
        span.textContent = fmtUsd(creditsToUsd(Number(span.dataset.credits || 0)));
      });
    });
  }

  // ---------- renderers: Overview ----------
  function renderQuotas(quota) {
    $('quota-legend').innerHTML = renderQuotaLegendHtml();
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
        <div class="kpi-label"><span>Total Tokens</span>${infoTip('Sum of uncached input, cached prefix read, and output tokens across all turns in this window.')}</div>
        <div class="kpi-value">${esc(fmtTokens(g.totalTokens))}</div>
        <div class="kpi-sub">${esc(`${g.turnCount} turns · ${g.conversationCount} chats`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span>Uncached Input</span>${infoTip('Fresh prompt tokens processed without hitting the prompt cache.')}</div>
        <div class="kpi-value">${esc(fmtTokens(g.totalInputTokens))}</div>
        <div class="kpi-sub">${esc(`Cache read: ${fmtTokens(g.totalCacheReadTokens)}`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span>Cache Hit Rate</span>${infoTip('Percentage of all prompt input tokens served from prompt cache rather than re-billed at full uncached cost.')}</div>
        <div class="kpi-value">${esc(cachePct)}</div>
        <div class="kpi-sub">${esc(`${fmtTokens(g.totalCacheReadTokens)} cached`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span>Output Tokens</span>${infoTip('All tokens generated by models: internal thinking/reasoning tokens plus visible reply & tool-call tokens.')}</div>
        <div class="kpi-value">${esc(fmtTokens(g.totalOutputTokens))}</div>
        <div class="kpi-sub">${esc(`Think: ${fmtTokens(g.totalThinkingTokens)} · Resp: ${fmtTokens(g.totalResponseTokens)}`)}</div>
      </div>
    `;
  }

  function renderModelUsage(models, globalTotalTokens) {
    $('model-token-legend').innerHTML = renderTokenLegendHtml({ includeOutput: true });
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
        const crBadge = m.creditsUsed > 0
          ? `<span class="pill credit">⚡ ${esc(fmtNum(m.creditsUsed))} cr</span>`
          : '';
        return `
          <div class="list-row">
            <div class="row-top">
              <span class="row-title">${esc(m.displayName)}</span>
              <div class="conv-actions">
                ${crBadge}
                ${qBadge}
                <span class="pill accent">${esc(fmtTokens(m.totalTokens))} (${esc(fmtPct(share))})</span>
              </div>
            </div>
            <div class="stacked-bar" title="Cached Context / New Input / Output">
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
              <span>Est. API <strong>${esc(fmtUsd(m.estApiCostUsd))}</strong></span>
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
                ${c.totalCreditsUsed > 0 ? `<span class="pill credit">⚡ ${esc(fmtNum(c.totalCreditsUsed))} cr</span>` : ''}
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
              <span>API ~<strong>${esc(fmtUsd(c.estApiCostUsd))}</strong></span>
              <span>${esc(fmtRelativeTime(c.lastModifiedMs))}</span>
            </div>
            <div class="bar-track" title="Context window fullness">
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

    const g = data.globalTotals || {};
    const scopeLabel = state.range === '24h' ? '24h' : state.range === '7d' ? '7d' : 'All Time';
    $('overview-credits-card').innerHTML = renderCreditsAnalysisHtml({
      creditsStatus: data.creditsStatus,
      creditsUsed: g.totalCreditsUsed || 0,
      creditBilledTurns: g.creditBilledTurns || 0,
      quotaCoveredTurns: g.quotaCoveredTurns || 0,
      estApiCostUsd: g.estApiCostUsd || 0,
      estCacheSavingsUsd: g.estCacheSavingsUsd || 0,
      scopeLabel,
      rateInputId: 'credit-rate-input-overview',
    });
    wireRateInput('credit-rate-input-overview');

    renderModelUsage(data.modelUsage || [], g.totalTokens || 0);
    renderConversationsList(data.conversations || []);
    renderModelsCatalog(data.modelsCatalog || []);
  }

  // ---------- renderers: Conversation Inspector ----------
  function renderTurnChart(turns) {
    const el = $('turn-chart-card');
    if (!turns.length) {
      el.innerHTML = '<div class="muted-text">No LLM turns recorded yet.</div>';
      return;
    }
    const slice = turns.slice(-48);
    const maxCtx = Math.max(1, ...slice.map((t) => t.contextTokens + t.outputTokens));
    el.innerHTML = `
      ${renderTokenLegendHtml({ includeOutput: true })}
      <div class="chart-bars" role="img" aria-label="Token usage per turn">
        ${slice.map((t) => {
          const cacheH = Math.max(1, Math.round((t.cacheReadTokens / maxCtx) * 70));
          const inH = Math.max(t.inputTokens > 0 ? 2 : 0, Math.round((t.inputTokens / maxCtx) * 70));
          const outH = Math.max(t.outputTokens > 0 ? 2 : 0, Math.round((t.outputTokens / maxCtx) * 70));
          const crPart = t.creditsUsed > 0 ? ` | Credits: ${t.creditsUsed}` : '';
          const tip = `Turn ${t.turnNumber} (${t.modelDisplayName}): Context ${fmtTokens(t.contextTokens)} | New In ${fmtTokens(t.inputTokens)} | Cache ${fmtTokens(t.cacheReadTokens)} | Out ${fmtTokens(t.outputTokens)}${crPart}`;
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
        <span>Peak prompt: ${esc(fmtTokens(maxCtx))}</span>
      </div>
    `;
  }

  function syncConversationPicker(pickerEl, pinWrapEl, pinCheckEl, payload) {
    const list = payload?.conversations || [];
    pickerEl.innerHTML = list.length
      ? list.map((c) => `<option value="${esc(c.conversationId)}">${esc(c.title)}</option>`).join('')
      : '<option value="">No conversations found</option>';
    if (payload?.conversationId) pickerEl.value = payload.conversationId;

    if (window.sidecar?.conversationId) {
      pinWrapEl.classList.remove('hidden');
      pinCheckEl.checked = state.pinActive;
    } else {
      pinWrapEl.classList.add('hidden');
    }
  }

  function renderConvMetaRow(metaEl, conv, openBtnId) {
    if (!conv) {
      metaEl.innerHTML = '';
      return;
    }
    const canOpenChat = Boolean(window.sidecar?.ui?.toggleConversation);
    metaEl.innerHTML = `
      ${statusBadge(conv.status)}
      <span class="pill accent">${esc(conv.primaryModel)}</span>
      ${conv.workspaceName ? `<span class="pill">${esc(conv.workspaceName)}</span>` : ''}
      <span class="pill">${esc(`${conv.turnCount} turns · ${conv.stepCount} steps`)}</span>
      ${conv.totalCreditsUsed > 0 ? `<span class="pill credit">⚡ ${esc(fmtNum(conv.totalCreditsUsed))} cr</span>` : ''}
      ${canOpenChat && conv.conversationId !== window.sidecar?.conversationId
        ? `<button type="button" id="${esc(openBtnId)}" class="action-link">Open Chat</button>`
        : ''}
    `;
    const openBtn = $(openBtnId);
    if (openBtn) {
      openBtn.addEventListener('click', () => window.sidecar.ui.toggleConversation(conv.conversationId));
    }
  }

  function renderConversation() {
    const payload = state.convData;
    if (!payload) return;

    syncConversationPicker($('conv-picker'), $('pin-active-wrap'), $('pin-active'), payload);

    const conv = payload.conversation;
    renderConvMetaRow($('conv-meta-row'), conv, 'open-selected-conv');

    if (!conv) {
      $('conv-empty').classList.remove('hidden');
      $('conv-body').classList.add('hidden');
      return;
    }

    $('conv-empty').classList.add('hidden');
    $('conv-body').classList.remove('hidden');

    $('conv-context-card').innerHTML = renderContextGaugeHtml(conv, { showBreakdown: true });

    // Cumulative KPIs (2x2)
    $('conv-kpis').innerHTML = `
      <div class="kpi-card">
        <div class="kpi-label"><span>Total Tokens</span>${infoTip('Total tokens processed across every turn in this conversation (each turn re-sends context + new input + output).')}</div>
        <div class="kpi-value">${esc(fmtTokens(conv.totalTokens))}</div>
        <div class="kpi-sub">${esc(`Uncached In: ${fmtTokens(conv.totalInputTokens)}`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span>Cache Hit Rate</span>${infoTip('Share of prompt input tokens served from prompt cache instead of being billed as fresh uncached input.')}</div>
        <div class="kpi-value">${esc(fmtPct(conv.cacheHitRate))}</div>
        <div class="kpi-sub">${esc(`Read: ${fmtTokens(conv.totalCacheReadTokens)}${conv.totalCacheWriteTokens ? ` · Write: ${fmtTokens(conv.totalCacheWriteTokens)}` : ''}`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span>Output Tokens</span>${infoTip('Combined tokens generated by the model: internal Thinking reasoning tokens plus visible Response text/tool calls.')}</div>
        <div class="kpi-value">${esc(fmtTokens(conv.totalOutputTokens))}</div>
        <div class="kpi-sub">${esc(`Think: ${fmtTokens(conv.totalThinkingTokens)} · Resp: ${fmtTokens(conv.totalResponseTokens)}`)}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label"><span>Avg TTFT &amp; Stream</span>${infoTip('TTFT = Time to First Token (model latency before streaming begins). Stream = total generation duration across turns.')}</div>
        <div class="kpi-value">${esc(fmtDurationMs(conv.avgTtftMs))}</div>
        <div class="kpi-sub">${esc(`Stream: ${fmtDurationMs(conv.totalStreamingMs)}${conv.totalRetries ? ` · ${conv.totalRetries} retries` : ''}`)}</div>
      </div>
    `;

    // Conversation AI Credits & Cost Analysis
    $('conv-credits-card').innerHTML = renderCreditsAnalysisHtml({
      creditsStatus: payload.creditsStatus,
      creditsUsed: conv.totalCreditsUsed || 0,
      creditBilledTurns: conv.creditBilledTurns || 0,
      quotaCoveredTurns: conv.quotaCoveredTurns || 0,
      estApiCostUsd: conv.estApiCostUsd || 0,
      estCacheSavingsUsd: conv.estCacheSavingsUsd || 0,
      scopeLabel: 'This Chat',
      rateInputId: 'credit-rate-input-conv',
    });
    wireRateInput('credit-rate-input-conv');

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
              <div class="conv-actions">
                ${m.creditsUsed > 0 ? `<span class="pill credit">⚡ ${esc(fmtNum(m.creditsUsed))} cr</span>` : ''}
                <span class="pill accent">${esc(fmtTokens(m.totalTokens))} (${esc(fmtPct(m.totalTokens / denom))})</span>
              </div>
            </div>
            <div class="row-metrics">
              <span><strong>${esc(m.turns)}</strong> turns</span>
              <span>In <strong>${esc(fmtTokens(m.inputTokens))}</strong></span>
              <span>Cache <strong>${esc(fmtTokens(m.cacheReadTokens))}</strong></span>
              <span>Out <strong>${esc(fmtTokens(m.outputTokens))}</strong></span>
              <span>Est. API <strong>${esc(fmtUsd(m.estApiCostUsd))}</strong></span>
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
              <div class="conv-actions">
                ${t.creditsUsed > 0
                  ? `<span class="pill credit">⚡ ${esc(t.creditsUsed)} cr</span>`
                  : '<span class="pill">Quota</span>'}
                <span class="muted-text" title="${esc(fmtExactTime(t.timestamp))}">${esc(fmtRelativeTime(t.timestamp))}</span>
              </div>
            </div>
            <div class="row-metrics">
              <span>Ctx <strong>${esc(fmtTokens(t.contextTokens))}</strong></span>
              <span>+In <strong>${esc(fmtTokens(t.inputTokens))}</strong></span>
              <span>Cache <strong>${esc(fmtTokens(t.cacheReadTokens))}</strong></span>
              <span>Out <strong>${esc(fmtTokens(t.outputTokens))}</strong>${t.thinkingTokens ? ` (${esc(fmtTokens(t.thinkingTokens))} think)` : ''}</span>
              ${t.ttftMs ? `<span>TTFT <strong>${esc(fmtDurationMs(t.ttftMs))}</strong></span>` : ''}
              <span>~<strong>${esc(fmtUsd(t.estApiCostUsd))}</strong></span>
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

  // ---------- renderers: Simple Customizable View ----------
  function syncCustomizePanelInputs() {
    document.querySelectorAll('#simple-customize-panel input[data-widget]').forEach((cb) => {
      cb.checked = Boolean(prefs.simpleWidgets[cb.dataset.widget]);
    });
    $('pref-default-simple').checked = Boolean(prefs.defaultToSimple);
    $('credit-rate-input-simple').value = String(prefs.creditPricePer1k);
  }

  function renderSimple() {
    const convPayload = state.convData;
    const overview = state.overview;
    const conv = convPayload?.conversation || null;
    const w = prefs.simpleWidgets;

    if (convPayload) {
      syncConversationPicker($('simple-conv-picker'), $('simple-pin-wrap'), $('simple-pin-active'), convPayload);
      renderConvMetaRow($('simple-meta-row'), conv, 'simple-open-selected-conv');
    }

    // 1. Context & Compaction Gauge
    const ctxEl = $('sw-contextGauge');
    if (w.contextGauge) {
      ctxEl.innerHTML = conv
        ? `<div class="card context-card">${renderContextGaugeHtml(conv, { showBreakdown: false })}</div>`
        : '<div class="card empty-state muted-text">Select or open a conversation to see its context window.</div>';
    } else {
      ctxEl.innerHTML = '';
    }

    // 2. Active Chat Token Totals
    const tokEl = $('sw-tokenSummary');
    if (w.tokenSummary && conv) {
      tokEl.innerHTML = `
        <div class="kpi-grid kpi-2x2">
          <div class="kpi-card">
            <div class="kpi-label"><span>Chat Total Tokens</span>${infoTip('All tokens processed across every turn in the selected chat.')}</div>
            <div class="kpi-value">${esc(fmtTokens(conv.totalTokens))}</div>
            <div class="kpi-sub">${esc(`${conv.turnCount} turns · In: ${fmtTokens(conv.totalInputTokens)}`)}</div>
          </div>
          <div class="kpi-card">
            <div class="kpi-label"><span>Cache Hit &amp; Output</span>${infoTip('Prompt cache hit rate and total output tokens generated in this chat.')}</div>
            <div class="kpi-value">${esc(fmtPct(conv.cacheHitRate))}</div>
            <div class="kpi-sub">${esc(`Out: ${fmtTokens(conv.totalOutputTokens)} (${fmtTokens(conv.totalThinkingTokens)} think)`)}</div>
          </div>
        </div>
      `;
    } else {
      tokEl.innerHTML = '';
    }

    // 3. Model Quotas
    const quotasEl = $('sw-quotas');
    if (w.quotas) {
      const groups = overview?.quota?.groups || [];
      if (groups.length > 0) {
        quotasEl.innerHTML = `
          <div class="section-head" style="margin:4px 0 6px">
            <div class="head-with-tip">
              <h2 class="section-title">Model Quotas</h2>
              ${infoTip('Remaining capacity across your model quota pools.')}
            </div>
            <span class="muted-text">${overview ? `Updated ${fmtRelativeTime(overview.generatedAt)}` : ''}</span>
          </div>
          ${renderQuotaLegendHtml()}
          <div class="quota-groups">
            ${groups.map((g) => `
              <div class="card quota-group-card">
                <div class="quota-group-title">${esc(g.displayName)}</div>
                ${(g.buckets || []).map(renderBucketRow).join('')}
              </div>
            `).join('')}
          </div>
        `;
      } else {
        quotasEl.innerHTML = '<div class="card empty-state muted-text">Loading model quotas…</div>';
      }
    } else {
      quotasEl.innerHTML = '';
    }

    // 4. AI Credits & Cost Snapshot
    const creditsEl = $('sw-credits');
    if (w.credits) {
      const cs = convPayload?.creditsStatus || overview?.creditsStatus;
      creditsEl.innerHTML = `
        <div class="section-head" style="margin:4px 0 6px">
          <div class="head-with-tip">
            <h2 class="section-title">AI Credits &amp; Cost</h2>
            ${infoTip('Available AI credits and credit/API cost breakdown for the selected chat.')}
          </div>
        </div>
        <div class="card credits-card">
          ${renderCreditsAnalysisHtml({
            creditsStatus: cs,
            creditsUsed: conv?.totalCreditsUsed || 0,
            creditBilledTurns: conv?.creditBilledTurns || 0,
            quotaCoveredTurns: conv?.quotaCoveredTurns || 0,
            estApiCostUsd: conv?.estApiCostUsd || 0,
            estCacheSavingsUsd: conv?.estCacheSavingsUsd || 0,
            scopeLabel: conv ? 'This Chat' : 'Selected',
          })}
        </div>
      `;
    } else {
      creditsEl.innerHTML = '';
    }

    // 5. Context Breakdown
    const bdEl = $('sw-breakdown');
    if (w.breakdown && conv?.tokenBreakdown?.groups?.length) {
      bdEl.innerHTML = `<div class="card context-card">${renderBreakdownHtml(conv)}</div>`;
    } else {
      bdEl.innerHTML = '';
    }

    // 6. Top Models Used
    const modelsEl = $('sw-topModels');
    if (w.topModels && overview?.modelUsage?.length) {
      const top = overview.modelUsage.slice(0, 4);
      modelsEl.innerHTML = `
        <div class="section-head" style="margin:4px 0 6px"><h2 class="section-title">Top Models Used</h2></div>
        <div class="card stack-list">
          ${top.map((m) => `
            <div class="list-row">
              <div class="row-top">
                <span class="row-title">${esc(m.displayName)}</span>
                <span class="pill accent">${esc(fmtTokens(m.totalTokens))}</span>
              </div>
              <div class="row-metrics">
                <span><strong>${esc(m.turnCount)}</strong> turns</span>
                <span>Cache <strong>${esc(fmtPct(m.cacheHitRate))}</strong></span>
                ${m.creditsUsed > 0 ? `<span>⚡ <strong>${esc(fmtNum(m.creditsUsed))}</strong> cr</span>` : ''}
                <span>~<strong>${esc(fmtUsd(m.estApiCostUsd))}</strong></span>
              </div>
            </div>
          `).join('')}
        </div>
      `;
    } else {
      modelsEl.innerHTML = '';
    }

    // 7. Recent Conversations
    const recentEl = $('sw-recentChats');
    if (w.recentChats && overview?.conversations?.length) {
      const rec = overview.conversations.slice(0, 5);
      recentEl.innerHTML = `
        <div class="section-head" style="margin:4px 0 6px"><h2 class="section-title">Recent Conversations</h2></div>
        <div class="card stack-list">
          ${rec.map((c) => `
            <div class="list-row">
              <div class="row-top">
                <span class="row-title" title="${esc(c.title)}">${esc(c.title)}</span>
                <button type="button" class="action-link" data-simple-select="${esc(c.conversationId)}">Focus</button>
              </div>
              <div class="row-metrics">
                <span>Ctx <strong>${esc(fmtTokens(c.contextTokensUsed))}</strong>/${esc(fmtTokens(c.maxContextTokens))}</span>
                <span>Total <strong>${esc(fmtTokens(c.totalTokens))}</strong></span>
                <span>${esc(fmtRelativeTime(c.lastModifiedMs))}</span>
              </div>
            </div>
          `).join('')}
        </div>
      `;
      recentEl.querySelectorAll('[data-simple-select]').forEach((btn) => {
        btn.addEventListener('click', () => {
          state.selectedConvId = btn.dataset.simpleSelect;
          state.pinActive = false;
          loadConversation();
        });
      });
    } else {
      recentEl.innerHTML = '';
    }
  }

  // ---------- data loading & polling ----------
  async function loadOverview(forceQuota = false) {
    try {
      const qs = new URLSearchParams({ range: state.range });
      if (forceQuota) qs.set('refresh', '1');
      const data = await getJson(`/api/overview?${qs.toString()}`);
      state.overview = data;
      state.lastOverviewFetchMs = Date.now();
      setError('');
      setLiveOk(true);
      if (state.mode === 'overview') renderOverview();
      else if (state.mode === 'simple') renderSimple();
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
      if (state.mode === 'conversation') renderConversation();
      else if (state.mode === 'simple') renderSimple();
    } catch (err) {
      setLiveOk(false);
      setError(`Failed to load conversation usage: ${err.message}`);
    }
  }

  async function loadSimple(forceQuota = false) {
    const tasks = [loadConversation()];
    if (forceQuota || !state.overview || Date.now() - state.lastOverviewFetchMs >= POLL_OVERVIEW_MS) {
      tasks.push(loadOverview(forceQuota));
    }
    await Promise.all(tasks);
  }

  function schedulePoll() {
    if (state.timer) clearInterval(state.timer);
    const interval = state.mode === 'overview' ? POLL_OVERVIEW_MS : POLL_CONV_MS;
    state.timer = setInterval(() => {
      if (document.hidden) return;
      if (state.mode === 'overview') loadOverview(false);
      else if (state.mode === 'conversation') loadConversation();
      else loadSimple(false);
    }, interval);
  }

  function switchMode(mode) {
    state.mode = mode;
    $('tab-simple').classList.toggle('active', mode === 'simple');
    $('tab-simple').setAttribute('aria-selected', String(mode === 'simple'));
    $('tab-overview').classList.toggle('active', mode === 'overview');
    $('tab-overview').setAttribute('aria-selected', String(mode === 'overview'));
    $('tab-conversation').classList.toggle('active', mode === 'conversation');
    $('tab-conversation').setAttribute('aria-selected', String(mode === 'conversation'));

    $('view-simple').classList.toggle('hidden', mode !== 'simple');
    $('view-overview').classList.toggle('hidden', mode !== 'overview');
    $('view-conversation').classList.toggle('hidden', mode !== 'conversation');

    if (mode === 'overview') loadOverview(false);
    else if (mode === 'conversation') loadConversation();
    else {
      syncCustomizePanelInputs();
      renderSimple();
      loadSimple(false);
    }
    schedulePoll();
  }

  // ---------- event wiring ----------
  $('tab-simple').addEventListener('click', () => switchMode('simple'));
  $('tab-overview').addEventListener('click', () => switchMode('overview'));
  $('tab-conversation').addEventListener('click', () => switchMode('conversation'));

  $('refresh-btn').addEventListener('click', () => {
    if (state.mode === 'overview') loadOverview(true);
    else if (state.mode === 'conversation') loadConversation();
    else loadSimple(true);
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

  function onPickerChange(e) {
    state.selectedConvId = e.target.value;
    state.pinActive = Boolean(window.sidecar?.conversationId && state.selectedConvId === window.sidecar.conversationId);
    loadConversation();
  }
  $('conv-picker').addEventListener('change', onPickerChange);
  $('simple-conv-picker').addEventListener('change', onPickerChange);

  function onPinChange(e) {
    state.pinActive = e.target.checked;
    if (state.pinActive && window.sidecar?.conversationId) {
      state.selectedConvId = window.sidecar.conversationId;
      loadConversation();
    }
  }
  $('pin-active').addEventListener('change', onPinChange);
  $('simple-pin-active').addEventListener('change', onPinChange);

  $('turn-order-btn').addEventListener('click', () => {
    state.turnsNewestFirst = !state.turnsNewestFirst;
    renderConversation();
  });

  $('simple-customize-btn').addEventListener('click', () => {
    state.customizeOpen = !state.customizeOpen;
    $('simple-customize-panel').classList.toggle('hidden', !state.customizeOpen);
    $('simple-customize-btn').setAttribute('aria-expanded', String(state.customizeOpen));
  });

  document.querySelectorAll('#simple-customize-panel input[data-widget]').forEach((cb) => {
    cb.addEventListener('change', () => {
      prefs.simpleWidgets[cb.dataset.widget] = cb.checked;
      savePrefs();
      renderSimple();
    });
  });

  $('pref-default-simple').addEventListener('change', (e) => {
    prefs.defaultToSimple = e.target.checked;
    savePrefs();
  });

  wireRateInput('credit-rate-input-simple');

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (state.mode === 'overview') loadOverview(false);
      else if (state.mode === 'conversation') loadConversation();
      else loadSimple(false);
    }
  });

  // Initial load
  switchMode(state.mode);
})();
