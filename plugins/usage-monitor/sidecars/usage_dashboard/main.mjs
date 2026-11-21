/**
 * Read-only sidecar backend for the `usage-monitor` Antigravity plugin.
 *
 * Aggregates:
 *  1. Model quota summaries (`RetrieveUserQuotaSummary`, `GetAvailableModels`,
 *     `GetCascadeModelConfigData`).
 *  2. Per-conversation context window and token usage
 *     (`GetCascadeTrajectoryGeneratorMetadata`, `GetAllCascadeTrajectories`,
 *     `GetConversationMetadata`, and local `brain/<convId>/.system_generated/logs/transcript.jsonl`).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ID_RE = /^[0-9a-f-]{8,}$/i;
const MAX_OVERVIEW_CONVERSATIONS = 50;
const RUNNING_CACHE_TTL_MS = 2500;
const IDLE_CACHE_TTL_MS = 60_000;
const MODEL_CATALOG_TTL_MS = 30_000;
const USER_STATUS_TTL_MS = 15_000;

const STATIC_ASSETS = {
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
};

/**
 * Loads SidecarApp and Response from `sidecar_sdk` when launched via the LS
 * `--import` loader, or provides a local HTTP fallback for standalone testing.
 */
async function loadSidecarSdk() {
  try {
    const mod = await import('sidecar_sdk');
    if (mod?.SidecarApp && mod?.Response) {
      return { SidecarApp: mod.SidecarApp, Response: mod.Response };
    }
  } catch {
    // Standalone fallback below.
  }

  class FallbackResponse {
    constructor(body, { contentType = 'text/plain', status = 200, headers } = {}) {
      this.body = body;
      this.contentType = contentType;
      this.status = status;
      this.headers = headers;
    }
  }

  const fallbackPreload = `(() => {
    const p = new URLSearchParams(location.search);
    const token = p.get('token');
    const conversationId = p.get('conversationId') || '';
    window.sidecar = {
      conversationId,
      fetch: (u, opts = {}) => {
        const h = new Headers(opts.headers || {});
        if (token) h.set('X-Sidecar-Token', token);
        return fetch(u, { ...opts, headers: h });
      },
      getWorkspaceUris: async () => [],
      onWorkspaceChange: () => () => {},
      ui: {}
    };
  })();`;

  class FallbackSidecarApp {
    #port = parseInt(process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || '4321', 10);
    #token = process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN || '';
    #pages = new Map();
    #apis = new Map();

    get config() {
      return {
        projectId: process.env.ANTIGRAVITY_PROJECT_ID || '',
        conversationId: process.env.ANTIGRAVITY_CONVERSATION_ID || '',
      };
    }

    page(path, handler) {
      this.#pages.set(path, handler);
    }

    api(path, handler, method = 'POST') {
      if (!this.#apis.has(path)) this.#apis.set(path, new Map());
      this.#apis.get(path).set(method.toUpperCase(), handler);
    }

    run() {
      this.#pages.set('/preload.js', () => fallbackPreload);
      const server = createServer(async (req, res) => {
        const url = new URL(req.url, `http://127.0.0.1:${this.#port}`);
        if (req.method !== 'GET' && this.#token) {
          const provided = req.headers['x-sidecar-token'] || url.searchParams.get('token');
          if (provided !== this.#token) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
        }
        if (req.method === 'GET' && this.#pages.has(url.pathname)) {
          const out = await this.#pages.get(url.pathname)();
          const isJs = url.pathname.endsWith('.js');
          res.writeHead(200, { 'Content-Type': isJs ? 'application/javascript' : 'text/html; charset=utf-8' });
          res.end(out);
          return;
        }
        const methodMap = this.#apis.get(url.pathname);
        if (methodMap?.has(req.method)) {
          let body = '';
          req.on('data', (chunk) => { body += chunk; });
          req.on('end', async () => {
            try {
              const data = {};
              for (const [k, v] of url.searchParams.entries()) {
                if (k.toLowerCase() !== 'token') data[k] = v;
              }
              if (body) Object.assign(data, JSON.parse(body));
              const result = await methodMap.get(req.method)(data);
              if (result instanceof FallbackResponse || (result && typeof result === 'object' && result.contentType && result.body !== undefined)) {
                res.writeHead(result.status || 200, { 'Content-Type': result.contentType, ...result.headers });
                res.end(typeof result.body === 'string' ? result.body : Buffer.from(result.body));
                return;
              }
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(result));
            } catch (err) {
              res.writeHead(500, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: err.message }));
            }
          });
          return;
        }
        res.writeHead(404);
        res.end('Not found');
      });
      return new Promise((resolve) => {
        server.listen(this.#port, '127.0.0.1', () => {
          console.log(`[usage_dashboard] listening on 127.0.0.1:${server.address().port}`);
          resolve(server);
        });
      });
    }
  }

  return { SidecarApp: FallbackSidecarApp, Response: FallbackResponse };
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

const toNum = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function parseDurationMs(d) {
  if (typeof d === 'number' && Number.isFinite(d)) return d;
  if (typeof d !== 'string' || !d) return 0;
  const m = d.trim().match(/^(-?\d+(?:\.\d+)?)s$/);
  return m ? Math.round(parseFloat(m[1]) * 1000) : 0;
}

function parseTsMs(ts) {
  if (!ts) return 0;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : 0;
}

function safeReaddir(path) {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

function statOf(path) {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return { mtimeMs: 0, size: -1 };
  }
}

function prettifyModelName(raw) {
  if (!raw || typeof raw !== 'string') return 'Unknown Model';
  if (raw.startsWith('MODEL_PLACEHOLDER_')) return raw.replace('MODEL_PLACEHOLDER_', 'Model ');
  if (raw.startsWith('MODEL_')) {
    return raw
      .replace(/^MODEL_(GOOGLE_|ANTHROPIC_|OPENAI_)?/, '')
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return raw;
}

function cleanUserTitle(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw
    .replace(/<\/?USER_REQUEST>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > 72) text = `${text.slice(0, 71).trimEnd()}…`;
  return text;
}

function workspaceDisplayName(workspaces) {
  if (!Array.isArray(workspaces) || !workspaces.length) return '';
  const ws = workspaces[0];
  if (ws?.repository?.computedName) return ws.repository.computedName;
  const uri = ws?.workspaceFolderAbsoluteUri || ws?.gitRootAbsoluteUri || '';
  if (!uri) return '';
  const cleaned = uri.replace(/^file:\/\//, '').replace(/\/+$/, '');
  return basename(cleaned) || cleaned;
}

// ---------------------------------------------------------------------------
// Language Server Connect RPC client
// ---------------------------------------------------------------------------

async function lsRpc(method, body = {}) {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN || '';
  if (!lsAddr) return null;
  try {
    const res = await fetch(
      `http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-codeium-csrf-token': csrf,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// App data & local brain discovery
// ---------------------------------------------------------------------------

function findAppDataDirs() {
  const dirs = [];
  const seen = new Set();
  const addIfBrain = (appData) => {
    if (!appData || seen.has(appData)) return;
    if (existsSync(join(appData, 'brain'))) {
      seen.add(appData);
      dirs.push(appData);
    }
  };

  const execDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (execDataDir) {
    for (let d = execDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        addIfBrain(dirname(d));
        break;
      }
    }
  }
  addIfBrain(process.env.ANTIGRAVITY_APP_DATA_DIR);

  if (!dirs.length) {
    const root = join(homedir(), '.gemini');
    for (const name of safeReaddir(root).sort()) {
      addIfBrain(join(root, name));
    }
  }
  return dirs;
}

function discoverBrainConversations() {
  const convs = new Map();
  for (const appData of findAppDataDirs()) {
    const brainRoot = join(appData, 'brain');
    for (const entry of safeReaddir(brainRoot)) {
      if (!ID_RE.test(entry)) continue;
      const convDir = join(brainRoot, entry);
      const transcriptPath = join(convDir, '.system_generated', 'logs', 'transcript.jsonl');
      const tStat = statOf(transcriptPath);
      const dirStat = statOf(convDir);
      const existing = convs.get(entry);
      const mtimeMs = tStat.mtimeMs || dirStat.mtimeMs;
      if (!existing || mtimeMs > existing.mtimeMs) {
        convs.set(entry, {
          conversationId: entry,
          appData,
          convDir,
          transcriptPath,
          transcriptMtime: tStat.mtimeMs,
          transcriptSize: tStat.size,
          mtimeMs,
        });
      }
    }
  }
  return convs;
}

// ---------------------------------------------------------------------------
// Transcript parser (cached by mtime + size)
// ---------------------------------------------------------------------------

const transcriptCache = new Map();

function parseTranscript(transcriptPath) {
  if (!transcriptPath) return null;
  const st = statOf(transcriptPath);
  if (st.size < 0) return null;
  const cached = transcriptCache.get(transcriptPath);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached.data;
  }

  let raw = '';
  try {
    raw = readFileSync(transcriptPath, 'utf-8');
  } catch {
    return null;
  }

  const byStep = new Map();
  let firstUserInput = '';
  let firstTimestamp = '';
  let lastTimestamp = '';

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const createdAt = typeof obj.created_at === 'string' ? obj.created_at : '';
    if (createdAt) {
      if (!firstTimestamp) firstTimestamp = createdAt;
      lastTimestamp = createdAt;
    }
    if (obj.type === 'USER_INPUT' && !firstUserInput && typeof obj.content === 'string') {
      firstUserInput = cleanUserTitle(obj.content);
    }
    if (typeof obj.step_index === 'number') {
      byStep.set(obj.step_index, obj);
    }
  }

  const plannerSteps = [];
  for (const [, step] of [...byStep.entries()].sort((a, b) => a[0] - b[0])) {
    if (step.type !== 'PLANNER_RESPONSE') continue;
    const tools = Array.isArray(step.tool_calls)
      ? step.tool_calls.map((tc) => ({
          name: tc?.name || tc?.tool_name || 'tool',
          summary: tc?.arguments?.toolSummary || '',
        }))
      : [];
    plannerSteps.push({
      stepIndex: step.step_index,
      createdAt: step.created_at || '',
      status: step.status || '',
      inputTokens: toNum(step.input_tokens),
      outputTokens: toNum(step.output_tokens),
      cacheReadTokens: toNum(step.cache_read_tokens),
      tools,
    });
  }

  const data = {
    byStep,
    plannerSteps,
    firstUserInput,
    firstTimestamp,
    lastTimestamp,
    stepCount: byStep.size,
    mtimeMs: st.mtimeMs,
    size: st.size,
  };
  transcriptCache.set(transcriptPath, { mtimeMs: st.mtimeMs, size: st.size, data });
  return data;
}

// ---------------------------------------------------------------------------
// Model catalog & quota normalization
// ---------------------------------------------------------------------------

let modelCatalogCache = { ts: 0, data: null };

async function getModelCatalog(force = false) {
  const now = Date.now();
  if (!force && modelCatalogCache.data && now - modelCatalogCache.ts < MODEL_CATALOG_TTL_MS) {
    return modelCatalogCache.data;
  }
  const [availRes, cfgRes] = await Promise.all([
    lsRpc('GetAvailableModels', {}),
    lsRpc('GetCascadeModelConfigData', {}),
  ]);

  const byEnum = new Map();
  const bySlug = new Map();
  const cfgByEnum = new Map();

  for (const cfg of cfgRes?.clientModelConfigs || []) {
    const mEnum = cfg?.modelOrAlias?.model;
    if (mEnum) cfgByEnum.set(mEnum, cfg);
  }

  const rawModels = availRes?.response?.models || {};
  for (const [slug, details] of Object.entries(rawModels)) {
    const mEnum = details?.model || '';
    const cfg = mEnum ? cfgByEnum.get(mEnum) : null;
    const entry = {
      modelKey: slug,
      modelEnum: mEnum,
      displayName: details?.displayName || cfg?.label || prettifyModelName(slug),
      maxTokens: toNum(details?.maxTokens),
      maxOutputTokens: toNum(details?.maxOutputTokens),
      supportsThinking: Boolean(details?.supportsThinking),
      supportsImages: Boolean(details?.supportsImages ?? cfg?.supportsImages),
      isInternal: Boolean(details?.isInternal),
      isRecommended: Boolean(details?.recommended ?? cfg?.isRecommended),
      disabled: Boolean(details?.disabled ?? cfg?.disabled),
      tagTitle: cfg?.tagTitle || details?.tagTitle || '',
      description: details?.description || cfg?.description || '',
      modelProvider: details?.modelProvider || cfg?.provider || '',
      apiProvider: details?.apiProvider || '',
      quotaInfo: details?.quotaInfo || cfg?.quotaInfo || null,
      quotaBucketName: details?.beyondModelInfo?.quotaBucketName || '',
    };
    bySlug.set(slug, entry);
    if (mEnum && !byEnum.has(mEnum)) {
      byEnum.set(mEnum, entry);
    }
  }

  for (const cfg of cfgRes?.clientModelConfigs || []) {
    const mEnum = cfg?.modelOrAlias?.model;
    if (!mEnum || byEnum.has(mEnum)) continue;
    byEnum.set(mEnum, {
      modelKey: mEnum,
      modelEnum: mEnum,
      displayName: cfg.label || prettifyModelName(mEnum),
      maxTokens: 0,
      maxOutputTokens: 0,
      supportsThinking: false,
      supportsImages: Boolean(cfg.supportsImages),
      isInternal: false,
      isRecommended: Boolean(cfg.isRecommended),
      disabled: Boolean(cfg.disabled),
      tagTitle: cfg.tagTitle || '',
      description: cfg.description || '',
      modelProvider: cfg.provider || '',
      apiProvider: '',
      quotaInfo: cfg.quotaInfo || null,
      quotaBucketName: '',
    });
  }

  // Build clean user-facing catalog prioritized by clientModelConfigs order.
  const catalogList = [];
  const added = new Set();
  for (const cfg of cfgRes?.clientModelConfigs || []) {
    const mEnum = cfg?.modelOrAlias?.model;
    const found = mEnum ? byEnum.get(mEnum) : null;
    if (!found || added.has(found.modelKey)) continue;
    added.add(found.modelKey);
    catalogList.push({ ...found, displayName: cfg.label || found.displayName });
  }
  for (const entry of bySlug.values()) {
    if (entry.isInternal || added.has(entry.modelKey)) continue;
    added.add(entry.modelKey);
    catalogList.push(entry);
  }

  const data = { byEnum, bySlug, catalogList };
  modelCatalogCache = { ts: now, data };
  return data;
}

function normalizeQuota(quotaRes, catalogList) {
  const resp = quotaRes?.response || {};
  const groups = (resp.groups || []).map((g) => ({
    displayName: g.displayName || 'Quota Group',
    description: g.description || '',
    buckets: (g.buckets || []).map((b) => ({
      bucketId: b.bucketId || '',
      displayName: b.displayName || b.bucketId || 'Limit',
      description: b.description || '',
      window: b.window || '',
      remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
      remainingAmount: b.remainingAmount ?? null,
      resetTime: b.resetTime || '',
      disabled: Boolean(b.disabled),
    })),
  }));

  const topBuckets = (resp.buckets || []).map((b) => ({
    bucketId: b.bucketId || '',
    displayName: b.displayName || b.bucketId || 'Limit',
    description: b.description || '',
    window: b.window || '',
    remainingFraction: typeof b.remainingFraction === 'number' ? b.remainingFraction : null,
    remainingAmount: b.remainingAmount ?? null,
    resetTime: b.resetTime || '',
    disabled: Boolean(b.disabled),
  }));

  // Group per-model quota pools so users see model-specific reset status too.
  const perModel = [];
  for (const m of catalogList) {
    if (!m.quotaInfo || m.disabled) continue;
    perModel.push({
      modelKey: m.modelKey,
      displayName: m.displayName,
      remainingFraction: typeof m.quotaInfo.remainingFraction === 'number' ? m.quotaInfo.remainingFraction : null,
      resetTime: m.quotaInfo.resetTime || '',
      tagTitle: m.tagTitle || '',
    });
  }

  return {
    description: resp.description || '',
    groups,
    buckets: topBuckets,
    perModel,
  };
}

// ---------------------------------------------------------------------------
// AI Credits status & API cost estimation
// ---------------------------------------------------------------------------

let userStatusCache = { ts: 0, data: null };

async function getUserCreditsStatus(force = false) {
  const now = Date.now();
  if (!force && userStatusCache.data && now - userStatusCache.ts < USER_STATUS_TTL_MS) {
    return userStatusCache.data;
  }
  const res = await lsRpc('GetUserStatus', {});
  const us = res?.userStatus || null;
  const availableCredits = Array.isArray(us?.userTier?.availableCredits)
    ? us.userTier.availableCredits.map((c) => ({
        creditType: c.creditType || 'GOOGLE_ONE_AI',
        creditAmount: toNum(c.creditAmount),
        minimumCreditAmountForUsage: toNum(c.minimumCreditAmountForUsage),
      }))
    : [];
  const totalAvailableCredits = availableCredits.reduce((acc, c) => acc + c.creditAmount, 0);
  const data = {
    planName: us?.userTier?.name || us?.planStatus?.planInfo?.planName || '',
    tierId: us?.userTier?.id || '',
    availableCredits,
    totalAvailableCredits,
    availablePromptCredits: toNum(us?.planStatus?.availablePromptCredits),
    availableFlowCredits: toNum(us?.planStatus?.availableFlowCredits),
  };
  userStatusCache = { ts: now, data };
  return data;
}

const API_RATE_TABLE = [
  { match: /opus/, family: 'Claude Opus', inputPerM: 15.0, cacheReadPerM: 1.5, outputPerM: 75.0 },
  { match: /sonnet/, family: 'Claude Sonnet', inputPerM: 3.0, cacheReadPerM: 0.3, outputPerM: 15.0 },
  { match: /flash/, family: 'Gemini Flash', inputPerM: 0.3, cacheReadPerM: 0.03, outputPerM: 2.5 },
  { match: /gpt-oss|gpt/, family: 'GPT-OSS', inputPerM: 0.5, cacheReadPerM: 0.05, outputPerM: 2.0 },
];

function resolveApiRates(modelId, displayName, contextTokens) {
  const key = `${modelId || ''} ${displayName || ''}`.toLowerCase();
  for (const row of API_RATE_TABLE) {
    if (row.match.test(key)) return row;
  }
  if (contextTokens > 200_000) {
    return { family: 'Gemini Pro-tier (>200K)', inputPerM: 2.5, cacheReadPerM: 0.25, outputPerM: 15.0 };
  }
  return { family: 'Gemini Pro-tier', inputPerM: 1.25, cacheReadPerM: 0.125, outputPerM: 10.0 };
}

function estimateTurnApiCost(modelId, displayName, { inputTokens, cacheReadTokens, outputTokens, contextTokens }) {
  const rates = resolveApiRates(modelId, displayName, contextTokens);
  const estApiCostUsd =
    (inputTokens * rates.inputPerM +
      cacheReadTokens * rates.cacheReadPerM +
      outputTokens * rates.outputPerM) /
    1_000_000;
  const estWithoutCacheUsd =
    ((inputTokens + cacheReadTokens) * rates.inputPerM + outputTokens * rates.outputPerM) /
    1_000_000;
  return {
    rateFamily: rates.family,
    estApiCostUsd,
    estCacheSavingsUsd: Math.max(0, estWithoutCacheUsd - estApiCostUsd),
  };
}

// ---------------------------------------------------------------------------
// Conversation stats computation & caching
// ---------------------------------------------------------------------------

const convStatsCache = new Map();
const convMetaCache = new Map();

async function getConversationMetadataCached(convId) {
  if (convMetaCache.has(convId)) return convMetaCache.get(convId);
  const res = await lsRpc('GetConversationMetadata', { conversationId: convId });
  const meta = res?.metadata || null;
  if (meta) convMetaCache.set(convId, meta);
  return meta;
}

function normalizeTokenBreakdown(tb) {
  if (!tb || (!Array.isArray(tb.groups) && !tb.totalTokens)) return null;
  const mapGroup = (g) => ({
    name: g.name || 'Other',
    type: g.type || '',
    source: g.source || '',
    numTokens: toNum(g.numTokens),
    children: Array.isArray(g.children)
      ? g.children.map((c) => ({
          name: c.name || 'Item',
          numTokens: toNum(c.numTokens),
          children: Array.isArray(c.children) ? c.children.map(mapGroup) : [],
        }))
      : [],
  });
  return {
    totalTokens: toNum(tb.totalTokens),
    groups: Array.isArray(tb.groups) ? tb.groups.map(mapGroup) : [],
  };
}

function resolveModelInfo(chatModel, modelCatalog) {
  const usage = chatModel?.usage || {};
  const rawEnum = usage.model || chatModel?.model || chatModel?.customMetadata?.model_enum || '';
  const rawSlug = chatModel?.responseModel || chatModel?.responseModelFull || chatModel?.plannerConfig?.modelName || '';

  const matched =
    (rawEnum && modelCatalog.byEnum.get(rawEnum)) ||
    (rawSlug && modelCatalog.bySlug.get(rawSlug)) ||
    null;

  const displayName =
    chatModel?.modelDisplayName ||
    matched?.displayName ||
    prettifyModelName(rawSlug || rawEnum);

  const modelId = matched?.modelKey || rawSlug || rawEnum || 'unknown';
  return {
    modelId,
    modelEnum: rawEnum || matched?.modelEnum || '',
    displayName,
    maxTokens: matched?.maxTokens || 0,
    maxOutputTokens: matched?.maxOutputTokens || 0,
    quotaInfo: matched?.quotaInfo || null,
  };
}

async function buildConversationStats(convId, { summary, diskInfo, modelCatalog, fetchMeta = false }) {
  const isRunning = summary?.status === 'CASCADE_RUN_STATUS_RUNNING';
  const ttl = isRunning ? RUNNING_CACHE_TTL_MS : IDLE_CACHE_TTL_MS;
  const sig = `${summary?.stepCount ?? ''}|${diskInfo?.transcriptMtime ?? 0}|${diskInfo?.transcriptSize ?? 0}`;

  const cached = convStatsCache.get(convId);
  if (cached && cached.sig === sig && Date.now() - cached.fetchedAt < ttl) {
    return cached.data;
  }

  const transcript = parseTranscript(diskInfo?.transcriptPath);
  const [gmRes, meta] = await Promise.all([
    lsRpc('GetCascadeTrajectoryGeneratorMetadata', { cascadeId: convId, includeMessages: false }),
    summary?.workspaces?.length ? Promise.resolve(null) : (fetchMeta ? getConversationMetadataCached(convId) : Promise.resolve(null)),
  ]);

  const gmList = Array.isArray(gmRes?.generatorMetadata) ? gmRes.generatorMetadata : [];
  const turns = [];
  const modelsMap = new Map();

  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalResponseTokens = 0;
  let totalTtftMs = 0;
  let ttftCount = 0;
  let totalStreamingMs = 0;
  let totalRetries = 0;
  let totalCreditsUsed = 0;
  let creditBilledTurns = 0;
  let quotaCoveredTurns = 0;
  let estApiCostUsd = 0;
  let estCacheSavingsUsd = 0;

  let latestContextUsed = 0;
  let latestMaxContext = 0;
  let latestUncachedInput = 0;
  let latestCacheRead = 0;
  let latestTruncationReason = '';
  let latestBreakdown = null;
  let lastKnownMaxContext = 0;

  if (gmList.length > 0) {
    for (let i = 0; i < gmList.length; i++) {
      const gm = gmList[i];
      const cm = gm?.chatModel || {};
      const u = cm.usage || {};
      const mInfo = resolveModelInfo(cm, modelCatalog);
      const stepIndices = Array.isArray(gm.stepIndices) ? gm.stepIndices : [];

      const inputTokens = toNum(u.inputTokens);
      const cacheReadTokens = toNum(u.cacheReadTokens);
      const cacheWriteTokens = toNum(u.cacheWriteTokens);
      const outputTokens = toNum(u.outputTokens);
      const thinkingTokens = toNum(u.thinkingOutputTokens);
      const responseTokens = toNum(u.responseOutputTokens) || Math.max(0, outputTokens - thinkingTokens);

      const cwm = cm.chatStartMetadata?.contextWindowMetadata || {};
      const cwmMax = toNum(cwm.maxContextTokens);
      if (cwmMax > 0) lastKnownMaxContext = cwmMax;
      const estimatedUsed = toNum(cwm.estimatedTokensUsed);
      const contextTokens = estimatedUsed > 0 ? estimatedUsed : (inputTokens + cacheReadTokens);
      const maxContext = cwmMax > 0 ? cwmMax : (mInfo.maxTokens || lastKnownMaxContext || 1_000_000);

      const ttftMs = parseDurationMs(cm.timeToFirstToken);
      const streamingMs = parseDurationMs(cm.streamingDuration);
      const retries = toNum(cm.retries);

      const consumedList = Array.isArray(cm.consumedCredits) ? cm.consumedCredits : [];
      let creditsUsed = 0;
      const creditTypeSet = new Set();
      for (const c of consumedList) {
        const amt = toNum(c?.creditAmount);
        if (amt > 0) {
          creditsUsed += amt;
          if (c?.creditType) creditTypeSet.add(c.creditType);
        }
      }
      const creditTypes = [...creditTypeSet];
      const costEst = estimateTurnApiCost(mInfo.modelId, mInfo.displayName, {
        inputTokens,
        cacheReadTokens,
        outputTokens,
        contextTokens,
      });

      // Find step timestamp & tool calls from transcript when available.
      let timestamp = cm.chatStartMetadata?.createdAt || '';
      const tools = [];
      if (transcript) {
        for (const idx of stepIndices) {
          const st = transcript.byStep.get(idx);
          if (!st) continue;
          if (!timestamp && st.created_at) timestamp = st.created_at;
          if (Array.isArray(st.tool_calls)) {
            for (const tc of st.tool_calls) {
              tools.push({
                name: tc?.name || tc?.tool_name || 'tool',
                summary: tc?.arguments?.toolSummary || '',
              });
            }
          }
        }
      }
      if (!timestamp) {
        timestamp = summary?.lastModifiedTime || transcript?.lastTimestamp || '';
      }

      totalInputTokens += inputTokens;
      totalCacheReadTokens += cacheReadTokens;
      totalCacheWriteTokens += cacheWriteTokens;
      totalOutputTokens += outputTokens;
      totalThinkingTokens += thinkingTokens;
      totalResponseTokens += responseTokens;
      if (ttftMs > 0) {
        totalTtftMs += ttftMs;
        ttftCount += 1;
      }
      totalStreamingMs += streamingMs;
      totalRetries += retries;
      totalCreditsUsed += creditsUsed;
      if (creditsUsed > 0) creditBilledTurns += 1;
      else quotaCoveredTurns += 1;
      estApiCostUsd += costEst.estApiCostUsd;
      estCacheSavingsUsd += costEst.estCacheSavingsUsd;

      latestContextUsed = contextTokens;
      latestMaxContext = maxContext;
      latestUncachedInput = inputTokens;
      latestCacheRead = cacheReadTokens;
      if (cwm.truncationReason && cwm.truncationReason !== 'TRUNCATION_REASON_UNSPECIFIED') {
        latestTruncationReason = cwm.truncationReason;
      }
      const tb = normalizeTokenBreakdown(cwm.tokenBreakdown);
      if (tb && tb.groups.length > 0) latestBreakdown = tb;

      const modelAgg = modelsMap.get(mInfo.modelId) || {
        modelId: mInfo.modelId,
        displayName: mInfo.displayName,
        maxTokens: mInfo.maxTokens || maxContext,
        turns: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        responseTokens: 0,
        totalTokens: 0,
        creditsUsed: 0,
        estApiCostUsd: 0,
      };
      modelAgg.turns += 1;
      modelAgg.inputTokens += inputTokens;
      modelAgg.cacheReadTokens += cacheReadTokens;
      modelAgg.cacheWriteTokens += cacheWriteTokens;
      modelAgg.outputTokens += outputTokens;
      modelAgg.thinkingTokens += thinkingTokens;
      modelAgg.responseTokens += responseTokens;
      modelAgg.totalTokens += inputTokens + cacheReadTokens + outputTokens;
      modelAgg.creditsUsed += creditsUsed;
      modelAgg.estApiCostUsd += costEst.estApiCostUsd;
      modelsMap.set(mInfo.modelId, modelAgg);

      turns.push({
        turnNumber: i + 1,
        stepIndices,
        timestamp,
        timestampMs: parseTsMs(timestamp),
        modelId: mInfo.modelId,
        modelDisplayName: mInfo.displayName,
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
        thinkingTokens,
        responseTokens,
        contextTokens,
        maxContextTokens: maxContext,
        ttftMs,
        streamingMs,
        retries,
        creditsUsed,
        creditTypes,
        estApiCostUsd: costEst.estApiCostUsd,
        estCacheSavingsUsd: costEst.estCacheSavingsUsd,
        rateFamily: costEst.rateFamily,
        tools,
      });
    }
  } else if (transcript?.plannerSteps?.length) {
    for (let i = 0; i < transcript.plannerSteps.length; i++) {
      const s = transcript.plannerSteps[i];
      totalInputTokens += s.inputTokens;
      totalCacheReadTokens += s.cacheReadTokens;
      totalOutputTokens += s.outputTokens;
      totalResponseTokens += s.outputTokens;
      quotaCoveredTurns += 1;

      const contextTokens = s.inputTokens + s.cacheReadTokens;
      const costEst = estimateTurnApiCost('unknown', 'Model', {
        inputTokens: s.inputTokens,
        cacheReadTokens: s.cacheReadTokens,
        outputTokens: s.outputTokens,
        contextTokens,
      });
      estApiCostUsd += costEst.estApiCostUsd;
      estCacheSavingsUsd += costEst.estCacheSavingsUsd;

      latestUncachedInput = s.inputTokens;
      latestCacheRead = s.cacheReadTokens;
      latestContextUsed = contextTokens;
      latestMaxContext = 1_000_000;

      turns.push({
        turnNumber: i + 1,
        stepIndices: [s.stepIndex],
        timestamp: s.createdAt,
        timestampMs: parseTsMs(s.createdAt),
        modelId: 'unknown',
        modelDisplayName: 'Model (from transcript)',
        inputTokens: s.inputTokens,
        cacheReadTokens: s.cacheReadTokens,
        cacheWriteTokens: 0,
        outputTokens: s.outputTokens,
        thinkingTokens: 0,
        responseTokens: s.outputTokens,
        contextTokens,
        maxContextTokens: 1_000_000,
        ttftMs: 0,
        streamingMs: 0,
        retries: 0,
        creditsUsed: 0,
        creditTypes: [],
        estApiCostUsd: costEst.estApiCostUsd,
        estCacheSavingsUsd: costEst.estCacheSavingsUsd,
        rateFamily: costEst.rateFamily,
        tools: s.tools,
      });
    }
  }

  const modelsUsed = [...modelsMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  const primaryModel = turns.length ? turns[turns.length - 1].modelDisplayName : (modelsUsed[0]?.displayName || '—');
  const totalInputPlusCache = totalInputTokens + totalCacheReadTokens;
  const totalTokens = totalInputPlusCache + totalOutputTokens;
  const cacheHitRate = totalInputPlusCache > 0 ? totalCacheReadTokens / totalInputPlusCache : 0;
  const contextUtilization = latestMaxContext > 0 ? Math.min(1, latestContextUsed / latestMaxContext) : 0;

  const workspaces = summary?.workspaces || meta?.workspaces || [];
  const createdTime =
    summary?.createdTime ||
    meta?.createdAt ||
    transcript?.firstTimestamp ||
    (diskInfo?.mtimeMs ? new Date(diskInfo.mtimeMs).toISOString() : '');
  const lastModifiedTime =
    summary?.lastModifiedTime ||
    transcript?.lastTimestamp ||
    (diskInfo?.mtimeMs ? new Date(diskInfo.mtimeMs).toISOString() : '');
  const title =
    summary?.summary ||
    summary?.annotations?.title ||
    transcript?.firstUserInput ||
    `Conversation ${convId.slice(0, 8)}`;

  const data = {
    conversationId: convId,
    title,
    status: summary?.status || 'CASCADE_RUN_STATUS_IDLE',
    workspaceName: workspaceDisplayName(workspaces),
    createdTime,
    lastModifiedTime,
    lastModifiedMs: parseTsMs(lastModifiedTime) || diskInfo?.mtimeMs || 0,
    stepCount: toNum(summary?.stepCount) || transcript?.stepCount || 0,
    turnCount: turns.length,
    primaryModel,
    contextTokensUsed: latestContextUsed,
    maxContextTokens: latestMaxContext,
    contextUtilization,
    latestUncachedInputTokens: latestUncachedInput,
    latestCacheReadTokens: latestCacheRead,
    truncationReason: latestTruncationReason,
    tokenBreakdown: latestBreakdown,
    totalInputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalOutputTokens,
    totalThinkingTokens,
    totalResponseTokens,
    totalTokens,
    cacheHitRate,
    avgTtftMs: ttftCount > 0 ? Math.round(totalTtftMs / ttftCount) : 0,
    totalStreamingMs,
    totalRetries,
    totalCreditsUsed,
    creditBilledTurns,
    quotaCoveredTurns,
    estApiCostUsd,
    estCacheSavingsUsd,
    modelsUsed,
    turns,
  };

  convStatsCache.set(convId, { sig, fetchedAt: Date.now(), data });
  return data;
}

function summarizeConversation(conv) {
  return {
    conversationId: conv.conversationId,
    title: conv.title,
    status: conv.status,
    workspaceName: conv.workspaceName,
    createdTime: conv.createdTime,
    lastModifiedTime: conv.lastModifiedTime,
    lastModifiedMs: conv.lastModifiedMs,
    stepCount: conv.stepCount,
    turnCount: conv.turnCount,
    primaryModel: conv.primaryModel,
    contextTokensUsed: conv.contextTokensUsed,
    maxContextTokens: conv.maxContextTokens,
    contextUtilization: conv.contextUtilization,
    totalTokens: conv.totalTokens,
    totalInputTokens: conv.totalInputTokens,
    totalCacheReadTokens: conv.totalCacheReadTokens,
    totalOutputTokens: conv.totalOutputTokens,
    totalThinkingTokens: conv.totalThinkingTokens,
    cacheHitRate: conv.cacheHitRate,
    totalCreditsUsed: conv.totalCreditsUsed,
    creditBilledTurns: conv.creditBilledTurns,
    quotaCoveredTurns: conv.quotaCoveredTurns,
    estApiCostUsd: conv.estApiCostUsd,
    estCacheSavingsUsd: conv.estCacheSavingsUsd,
  };
}

// ---------------------------------------------------------------------------
// Overview & Conversation API builders
// ---------------------------------------------------------------------------

function rangeCutoffMs(range) {
  const now = Date.now();
  if (range === '24h') return now - 24 * 60 * 60 * 1000;
  if (range === '7d') return now - 7 * 24 * 60 * 60 * 1000;
  return 0;
}

async function buildOverviewPayload({ forceRefreshQuota = false, range = 'all' } = {}) {
  const [quotaRes, modelCatalog, trajRes, creditsStatus] = await Promise.all([
    lsRpc('RetrieveUserQuotaSummary', { forceRefresh: forceRefreshQuota }),
    getModelCatalog(forceRefreshQuota),
    lsRpc('GetAllCascadeTrajectories', { excludeSubtrajectories: false }),
    getUserCreditsStatus(forceRefreshQuota),
  ]);

  const diskConvs = discoverBrainConversations();
  const summaries = trajRes?.trajectorySummaries || {};
  const candidateMap = new Map();

  for (const [id, sum] of Object.entries(summaries)) {
    const disk = diskConvs.get(id) || null;
    candidateMap.set(id, {
      convId: id,
      summary: sum,
      diskInfo: disk,
      sortMs: Math.max(parseTsMs(sum?.lastModifiedTime), disk?.mtimeMs || 0),
    });
  }
  for (const [id, disk] of diskConvs.entries()) {
    if (!candidateMap.has(id)) {
      candidateMap.set(id, {
        convId: id,
        summary: null,
        diskInfo: disk,
        sortMs: disk.mtimeMs || 0,
      });
    }
  }

  const candidates = [...candidateMap.values()]
    .sort((a, b) => b.sortMs - a.sortMs)
    .slice(0, MAX_OVERVIEW_CONVERSATIONS);

  const detailedConvs = await Promise.all(
    candidates.map((c) =>
      buildConversationStats(c.convId, {
        summary: c.summary,
        diskInfo: c.diskInfo,
        modelCatalog,
        fetchMeta: true,
      }),
    ),
  );

  const cutoffMs = rangeCutoffMs(range);
  const modelAggMap = new Map();
  let totalTurns = 0;
  let totalInputTokens = 0;
  let totalCacheReadTokens = 0;
  let totalCacheWriteTokens = 0;
  let totalOutputTokens = 0;
  let totalThinkingTokens = 0;
  let totalResponseTokens = 0;
  let totalCreditsUsed = 0;
  let creditBilledTurns = 0;
  let quotaCoveredTurns = 0;
  let estApiCostUsd = 0;
  let estCacheSavingsUsd = 0;
  let activeConversationsInWindow = 0;

  const filteredConversations = [];
  for (const conv of detailedConvs) {
    const turnsInRange = cutoffMs > 0
      ? conv.turns.filter((t) => (t.timestampMs || conv.lastModifiedMs) >= cutoffMs)
      : conv.turns;

    if (cutoffMs > 0 && turnsInRange.length === 0 && conv.lastModifiedMs < cutoffMs) {
      continue;
    }
    if (turnsInRange.length > 0) activeConversationsInWindow += 1;

    const convSeenModels = new Set();
    let cInput = 0;
    let cCacheRead = 0;
    let cCacheWrite = 0;
    let cOutput = 0;
    let cThinking = 0;
    let cResponse = 0;
    let cCredits = 0;
    let cCreditTurns = 0;
    let cQuotaTurns = 0;
    let cEstCost = 0;
    let cEstSavings = 0;

    for (const t of turnsInRange) {
      totalTurns += 1;
      cInput += t.inputTokens;
      cCacheRead += t.cacheReadTokens;
      cCacheWrite += t.cacheWriteTokens;
      cOutput += t.outputTokens;
      cThinking += t.thinkingTokens;
      cResponse += t.responseTokens;
      const tCredits = toNum(t.creditsUsed);
      const tCost = toNum(t.estApiCostUsd);
      const tSavings = toNum(t.estCacheSavingsUsd);
      cCredits += tCredits;
      if (tCredits > 0) cCreditTurns += 1;
      else cQuotaTurns += 1;
      cEstCost += tCost;
      cEstSavings += tSavings;

      const mCatalogEntry = modelCatalog.bySlug.get(t.modelId) || modelCatalog.byEnum.get(t.modelId);
      const mKey = t.modelId || t.modelDisplayName;
      const mAgg = modelAggMap.get(mKey) || {
        modelId: mKey,
        displayName: t.modelDisplayName,
        maxTokens: mCatalogEntry?.maxTokens || t.maxContextTokens || 0,
        quotaInfo: mCatalogEntry?.quotaInfo || null,
        conversationCount: 0,
        turnCount: 0,
        inputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        responseTokens: 0,
        totalTokens: 0,
        creditsUsed: 0,
        estApiCostUsd: 0,
        cacheHitRate: 0,
      };
      if (!convSeenModels.has(mKey)) {
        convSeenModels.add(mKey);
        mAgg.conversationCount += 1;
      }
      mAgg.turnCount += 1;
      mAgg.inputTokens += t.inputTokens;
      mAgg.cacheReadTokens += t.cacheReadTokens;
      mAgg.cacheWriteTokens += t.cacheWriteTokens;
      mAgg.outputTokens += t.outputTokens;
      mAgg.thinkingTokens += t.thinkingTokens;
      mAgg.responseTokens += t.responseTokens;
      mAgg.totalTokens += t.inputTokens + t.cacheReadTokens + t.outputTokens;
      mAgg.creditsUsed += tCredits;
      mAgg.estApiCostUsd += tCost;
      modelAggMap.set(mKey, mAgg);
    }

    totalInputTokens += cInput;
    totalCacheReadTokens += cCacheRead;
    totalCacheWriteTokens += cCacheWrite;
    totalOutputTokens += cOutput;
    totalThinkingTokens += cThinking;
    totalResponseTokens += cResponse;
    totalCreditsUsed += cCredits;
    creditBilledTurns += cCreditTurns;
    quotaCoveredTurns += cQuotaTurns;
    estApiCostUsd += cEstCost;
    estCacheSavingsUsd += cEstSavings;

    if (cutoffMs > 0) {
      const cInCache = cInput + cCacheRead;
      filteredConversations.push({
        ...summarizeConversation(conv),
        turnCount: turnsInRange.length,
        totalInputTokens: cInput,
        totalCacheReadTokens: cCacheRead,
        totalOutputTokens: cOutput,
        totalThinkingTokens: cThinking,
        totalTokens: cInCache + cOutput,
        cacheHitRate: cInCache > 0 ? cCacheRead / cInCache : 0,
        totalCreditsUsed: cCredits,
        creditBilledTurns: cCreditTurns,
        quotaCoveredTurns: cQuotaTurns,
        estApiCostUsd: cEstCost,
        estCacheSavingsUsd: cEstSavings,
      });
    } else {
      filteredConversations.push(summarizeConversation(conv));
    }
  }

  const modelUsage = [...modelAggMap.values()]
    .map((m) => {
      const denom = m.inputTokens + m.cacheReadTokens;
      return { ...m, cacheHitRate: denom > 0 ? m.cacheReadTokens / denom : 0 };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens);

  const totalInputPlusCache = totalInputTokens + totalCacheReadTokens;
  const globalTotals = {
    conversationCount: activeConversationsInWindow,
    discoveredTotalCount: candidateMap.size,
    turnCount: totalTurns,
    totalInputTokens,
    totalCacheReadTokens,
    totalCacheWriteTokens,
    totalOutputTokens,
    totalThinkingTokens,
    totalResponseTokens,
    totalTokens: totalInputPlusCache + totalOutputTokens,
    cacheHitRate: totalInputPlusCache > 0 ? totalCacheReadTokens / totalInputPlusCache : 0,
    totalCreditsUsed,
    creditBilledTurns,
    quotaCoveredTurns,
    estApiCostUsd,
    estCacheSavingsUsd,
  };

  return {
    generatedAt: new Date().toISOString(),
    range,
    creditsStatus,
    quota: normalizeQuota(quotaRes, modelCatalog.catalogList),
    globalTotals,
    modelUsage,
    modelsCatalog: modelCatalog.catalogList,
    conversations: filteredConversations,
  };
}

async function buildConversationPayload(requestedId) {
  const [modelCatalog, trajRes, creditsStatus] = await Promise.all([
    getModelCatalog(false),
    lsRpc('GetAllCascadeTrajectories', { excludeSubtrajectories: false }),
    getUserCreditsStatus(false),
  ]);

  const diskConvs = discoverBrainConversations();
  const summaries = trajRes?.trajectorySummaries || {};
  const allIds = new Set([...Object.keys(summaries), ...diskConvs.keys()]);

  const list = [];
  for (const id of allIds) {
    const sum = summaries[id] || null;
    const disk = diskConvs.get(id) || null;
    const sortMs = Math.max(parseTsMs(sum?.lastModifiedTime), disk?.mtimeMs || 0);
    const transcript = disk?.transcriptPath ? parseTranscript(disk.transcriptPath) : null;
    list.push({
      conversationId: id,
      title: sum?.summary || sum?.annotations?.title || transcript?.firstUserInput || `Conversation ${id.slice(0, 8)}`,
      status: sum?.status || 'CASCADE_RUN_STATUS_IDLE',
      lastModifiedMs: sortMs,
      lastModifiedTime: sum?.lastModifiedTime || (sortMs ? new Date(sortMs).toISOString() : ''),
    });
  }
  list.sort((a, b) => b.lastModifiedMs - a.lastModifiedMs);

  let convId = requestedId && ID_RE.test(requestedId) ? requestedId : '';
  let resolvedFrom = convId ? 'active' : 'none';
  if (!convId && list.length > 0) {
    convId = list[0].conversationId;
    resolvedFrom = 'most_recent';
  }

  if (!convId) {
    return { conversationId: null, resolvedFrom: 'none', creditsStatus, conversation: null, conversations: [] };
  }

  const conversation = await buildConversationStats(convId, {
    summary: summaries[convId] || null,
    diskInfo: diskConvs.get(convId) || null,
    modelCatalog,
    fetchMeta: true,
  });

  return {
    conversationId: convId,
    resolvedFrom,
    creditsStatus,
    conversation,
    conversations: list.slice(0, MAX_OVERVIEW_CONVERSATIONS),
  };
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

const { SidecarApp, Response } = await loadSidecarSdk();
const app = new SidecarApp();

const serveHtml = () => readFileSync(join(__dirname, 'index.html'), 'utf-8');
app.page('/', serveHtml);
app.page('/conversation', serveHtml);

for (const [route, [file, contentType]] of Object.entries(STATIC_ASSETS)) {
  app.api(route, () => new Response(readFileSync(join(__dirname, file), 'utf-8'), { contentType }), 'GET');
}

app.api('/api/overview', async (data) => {
  const range = data.range === '24h' || data.range === '7d' ? data.range : 'all';
  const forceRefreshQuota = data.refresh === '1';
  return buildOverviewPayload({ forceRefreshQuota, range });
}, 'GET');

app.api('/api/conversation', async (data) => {
  const requestedId = data.conversationId || app.config.conversationId || '';
  return buildConversationPayload(requestedId);
}, 'GET');

await app.run();
