"use strict";

const { readJsonBody } = require("../middleware/body-parser");
const { writeJson, CORS_HEADERS } = require("../http");
const {
  detectActiveStorage,
  readGatewayState,
  listSnapshots,
  snapshotActiveCredentials,
  activateSnapshot
} = require("../auth-state");
const { writeAccountToFile } = require("../accounts-file");

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function maskToken(token) {
  if (!token) {
    return null;
  }

  const text = String(token);
  return text.length > 8 ? `${text.slice(0, 8)}***` : "***";
}

async function requestGatewayJson(gatewayManager, pathname, options = {}) {
  const response = await fetch(`${gatewayManager.baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(Number(options.timeoutMs || 8000))
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(`Gateway request failed for ${pathname}: ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

async function buildAdminState(config, authProvider) {
  const gateway = await readGatewayState(config.baseUrl);
  const storage = detectActiveStorage();
  const snapshots = listSnapshots().map((entry) => ({
    alias: entry.alias,
    kind: entry.kind,
    dir: entry.dir,
    capturedAt: entry.metadata && entry.metadata.capturedAt ? entry.metadata.capturedAt : null,
    gatewayUser: entry.metadata && entry.metadata.gatewayUser ? entry.metadata.gatewayUser : null
  }));
  const accounts = authProvider.getConfiguredAccounts().map((account) => ({
    id: account.id,
    name: account.name,
    source: account.source,
    enabled: account.enabled,
    hasToken: Boolean(account.accessToken),
    tokenPreview: maskToken(account.accessToken),
    expiresAt: account.expiresAt || null,
    invalidUntil: authProvider.getInvalidUntil(account.id),
    lastFailure: authProvider.getLastFailure(account.id) || null
  }));

  return {
    ok: true,
    bridge: {
      port: config.port,
      transportMode: config.transportMode,
      authMode: config.authMode,
      accountsPath: config.accountsPath,
      sessionStorePath: config.sessionStorePath,
      appPath: config.appPath
    },
    gateway,
    storage,
    snapshots,
    auth: authProvider.getSummary(),
    accounts
  };
}

function writeHtml(res, statusCode, html) {
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html)
  });
  res.end(html);
}

function renderAdminPage(config) {
  const title = escapeHtml(`Accio Bridge Manager · ${config.port}`);
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>
:root {
  --bg: #f2efe8;
  --ink: #171514;
  --muted: #6d665f;
  --line: rgba(23, 21, 20, 0.12);
  --panel: rgba(255,255,255,0.72);
  --panel-strong: rgba(255,255,255,0.9);
  --accent: #b55233;
  --good: #1e7a52;
  --warn: #9c5a14;
  --bad: #a33131;
  --shadow: 0 18px 60px rgba(44, 34, 24, 0.12);
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  font-family: "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
  color: var(--ink);
  background:
    radial-gradient(circle at top left, rgba(181,82,51,0.18), transparent 30%),
    radial-gradient(circle at top right, rgba(30,122,82,0.12), transparent 26%),
    linear-gradient(180deg, #fbf7f0 0%, var(--bg) 55%, #ece6dc 100%);
}
button, input { font: inherit; }
.main { width: min(1320px, calc(100vw - 40px)); margin: 0 auto; padding: 28px 0 48px; }
.hero { display: grid; grid-template-columns: 1.3fr 0.9fr; gap: 20px; min-height: 280px; }
.heroPrimary, .heroSide, .panel {
  background: var(--panel);
  backdrop-filter: blur(18px);
  border: 1px solid var(--line);
  border-radius: 28px;
  box-shadow: var(--shadow);
}
.heroPrimary { padding: 28px; position: relative; overflow: hidden; }
.heroPrimary::after {
  content: ""; position: absolute; inset: auto -80px -80px auto; width: 240px; height: 240px;
  border-radius: 50%; background: linear-gradient(135deg, rgba(181,82,51,0.18), rgba(181,82,51,0));
}
.eyebrow {
  display: inline-flex; align-items: center; gap: 10px; padding: 8px 12px; border-radius: 999px;
  background: rgba(255,255,255,0.72); color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; font-size: 12px;
}
.hero h1 { margin: 18px 0 10px; font-size: clamp(36px, 5vw, 64px); line-height: 0.95; letter-spacing: -0.04em; max-width: 10ch; }
.hero p { margin: 0; max-width: 44ch; line-height: 1.6; color: var(--muted); font-size: 15px; }
.heroStats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin-top: 28px; }
.stat { padding: 14px 16px; border-radius: 20px; background: rgba(255,255,255,0.86); border: 1px solid rgba(23, 21, 20, 0.08); }
.statLabel { font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.statValue { margin-top: 8px; font-size: 24px; letter-spacing: -0.03em; }
.heroSide { padding: 24px; display: flex; flex-direction: column; justify-content: space-between; }
.stack { display: grid; gap: 18px; }
.statusBadge { display: inline-flex; align-items: center; gap: 8px; padding: 8px 12px; border-radius: 999px; background: rgba(255,255,255,0.92); font-size: 13px; }
.dot { width: 10px; height: 10px; border-radius: 50%; background: var(--muted); }
.dot.good { background: var(--good); }
.dot.warn { background: var(--warn); }
.dot.bad { background: var(--bad); }
.grid { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 20px; margin-top: 20px; }
.panel { padding: 22px; }
.panelHeader { display: flex; align-items: end; justify-content: space-between; gap: 12px; margin-bottom: 18px; }
.panelTitle { font-size: 22px; letter-spacing: -0.03em; margin: 0; }
.panelSub { color: var(--muted); font-size: 14px; margin-top: 6px; }
.toolbar { display: flex; gap: 10px; flex-wrap: wrap; }
.btn {
  border: 0; border-radius: 16px; padding: 12px 16px; background: rgba(23,21,20,0.08); color: var(--ink);
  cursor: pointer; transition: transform .18s ease, background .18s ease, opacity .18s ease;
}
.btn:hover { transform: translateY(-1px); background: rgba(23,21,20,0.12); }
.btn.primary { background: var(--accent); color: white; }
.btn.primary:hover { background: #9d462a; }
.btn.subtle { background: transparent; border: 1px solid var(--line); }
.btn.warn { background: #f6e7cf; color: #73440d; }
.btn:disabled { opacity: .45; cursor: wait; transform: none; }
.formRow { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; margin-top: 12px; }
.input {
  width: 100%; border-radius: 16px; border: 1px solid var(--line); background: rgba(255,255,255,0.88);
  padding: 13px 14px; color: var(--ink);
}
.list { display: grid; gap: 12px; }
.row {
  display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 14px; padding: 16px 18px; border-radius: 22px;
  border: 1px solid rgba(23,21,20,0.08); background: var(--panel-strong);
}
.rowTitle { font-size: 16px; margin: 0 0 6px; }
.meta { color: var(--muted); font-size: 13px; line-height: 1.5; }
.actionRow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.message { margin-top: 12px; padding: 12px 14px; border-radius: 16px; font-size: 14px; line-height: 1.5; display: none; }
.message.show { display: block; }
.message.info { background: rgba(23,21,20,0.06); }
.message.ok { background: rgba(30,122,82,0.12); color: #145237; }
.message.error { background: rgba(163,49,49,0.12); color: #6e1c1c; }
.message.warn { background: rgba(156,90,20,0.12); color: #6f4310; }
.kv { display: grid; grid-template-columns: 140px 1fr; gap: 10px 14px; font-size: 14px; }
.kv dt { color: var(--muted); }
.kv dd { margin: 0; }
.footerNote { margin-top: 18px; color: var(--muted); font-size: 13px; line-height: 1.6; }
@media (max-width: 980px) {
  .hero, .grid { grid-template-columns: 1fr; }
  .heroStats { grid-template-columns: 1fr; }
}
</style>
</head>
<body>
<div class="main">
  <section class="hero">
    <div class="heroPrimary">
      <div class="eyebrow">Accio Bridge Manager</div>
      <h1>把登录态、快照和账号池放到一个操作台里。</h1>
      <p>这个本地管理台直接复用桥接服务里的能力，用于观察当前 Accio 登录状态、保存本机快照、激活历史账号态，以及把当前 token 写回外部账号池。</p>
      <div class="heroStats">
        <div class="stat"><div class="statLabel">Bridge</div><div class="statValue">:${escapeHtml(String(config.port))}</div></div>
        <div class="stat"><div class="statLabel">Transport</div><div class="statValue">${escapeHtml(config.transportMode)}</div></div>
        <div class="stat"><div class="statLabel">Auth Mode</div><div class="statValue">${escapeHtml(config.authMode)}</div></div>
      </div>
    </div>
    <aside class="heroSide">
      <div class="stack">
        <div><div class="statusBadge"><span class="dot" id="gateway-dot"></span><span id="gateway-summary">正在加载网关状态</span></div></div>
        <dl class="kv" id="overview-kv"></dl>
      </div>
      <div class="footerNote">快照针对当前机器生效。若你刚激活某个快照，但 4097 仍在内存里持有旧登录态，需要重启 Accio 或本地网关后再验证。</div>
    </aside>
  </section>
  <section class="grid">
    <div class="stack">
      <section class="panel">
        <div class="panelHeader">
          <div>
            <h2 class="panelTitle">快速动作</h2>
            <div class="panelSub">网页登录、登出、保存快照、写回账号池都在这里。</div>
          </div>
          <div class="toolbar">
            <button class="btn subtle" id="refresh-btn">刷新状态</button>
            <button class="btn warn" id="logout-btn">登出当前 Accio</button>
            <button class="btn primary" id="login-btn">发起网页登录</button>
          </div>
        </div>
        <div class="formRow">
          <input class="input" id="snapshot-alias" placeholder="输入快照别名，例如 acct_primary" />
          <button class="btn primary" id="snapshot-btn">保存本机快照</button>
        </div>
        <div class="formRow">
          <input class="input" id="capture-account-id" placeholder="把当前 token 写入账号池，例如 acct_primary" />
          <button class="btn" id="capture-btn">写入账号池</button>
        </div>
        <div id="action-message" class="message info"></div>
      </section>
      <section class="panel">
        <div class="panelHeader">
          <div>
            <h2 class="panelTitle">本机快照</h2>
            <div class="panelSub">保存和恢复 credentials.enc / credentials.json 快照。</div>
          </div>
        </div>
        <div class="list" id="snapshot-list"></div>
      </section>
    </div>
    <div class="stack">
      <section class="panel">
        <div class="panelHeader">
          <div>
            <h2 class="panelTitle">账号池</h2>
            <div class="panelSub">当前桥接层可见的外部账号配置，不直接暴露完整 token。</div>
          </div>
        </div>
        <div class="list" id="account-list"></div>
      </section>
      <section class="panel">
        <div class="panelHeader">
          <div>
            <h2 class="panelTitle">本地存储</h2>
            <div class="panelSub">查看当前 Accio 登录态文件是否已落盘。</div>
          </div>
        </div>
        <dl class="kv" id="storage-kv"></dl>
      </section>
    </div>
  </section>
</div>
<script>
const els = {
  gatewayDot: document.getElementById('gateway-dot'),
  gatewaySummary: document.getElementById('gateway-summary'),
  overviewKv: document.getElementById('overview-kv'),
  storageKv: document.getElementById('storage-kv'),
  snapshotList: document.getElementById('snapshot-list'),
  accountList: document.getElementById('account-list'),
  actionMessage: document.getElementById('action-message'),
  snapshotAlias: document.getElementById('snapshot-alias'),
  captureAccountId: document.getElementById('capture-account-id'),
  refreshBtn: document.getElementById('refresh-btn'),
  logoutBtn: document.getElementById('logout-btn'),
  loginBtn: document.getElementById('login-btn'),
  snapshotBtn: document.getElementById('snapshot-btn'),
  captureBtn: document.getElementById('capture-btn')
};
function setMessage(type, text) {
  els.actionMessage.className = 'message show ' + type;
  els.actionMessage.textContent = text;
}
function clearMessage() {
  els.actionMessage.className = 'message info';
  els.actionMessage.textContent = '';
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((payload && payload.error && payload.error.message) || payload.error || 'Request failed');
  return payload;
}
function formatTime(value) {
  if (!value) return '—';
  try { return new Date(value).toLocaleString(); } catch { return String(value); }
}
function badgeState(gateway) {
  if (!gateway || !gateway.reachable) return ['bad', '网关不可达'];
  if (gateway.authenticated) return ['good', '网关已登录'];
  return ['warn', '网关在线但未登录'];
}
function renderKv(target, rows) {
  target.innerHTML = rows.map(([k,v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('');
}
function renderAccounts(accounts) {
  if (!accounts || accounts.length === 0) {
    els.accountList.innerHTML = '<div class="row"><div><h3 class="rowTitle">暂无外部账号配置</h3><div class="meta">当前账号池为空，可以先通过“写入账号池”把当前 token 持久化进去。</div></div></div>';
    return;
  }
  els.accountList.innerHTML = accounts.map((account) => {
    const failure = account.lastFailure ? ' 最近失败: ' + account.lastFailure.reason : '';
    const invalid = account.invalidUntil ? ' 冻结到: ' + formatTime(account.invalidUntil) : '';
    return '<div class="row">'
      + '<div><h3 class="rowTitle">' + account.id + '</h3><div class="meta">来源: ' + (account.source || 'unknown')
      + ' · token: ' + (account.tokenPreview || 'missing')
      + ' · enabled: ' + (account.enabled ? 'yes' : 'no')
      + failure + invalid + '</div></div>'
      + '<div class="actionRow"><button class="btn subtle" data-fill-account="' + account.id + '">写入当前 token</button></div>'
      + '</div>';
  }).join('');
}
function renderSnapshots(snapshots) {
  if (!snapshots || snapshots.length === 0) {
    els.snapshotList.innerHTML = '<div class="row"><div><h3 class="rowTitle">还没有快照</h3><div class="meta">先保存一次本机登录态，后面才可以在不同账号间做本地切换。</div></div></div>';
    return;
  }
  els.snapshotList.innerHTML = snapshots.map((item) => {
    const user = item.gatewayUser && item.gatewayUser.id ? ' · user: ' + item.gatewayUser.id + (item.gatewayUser.name ? ' (' + item.gatewayUser.name + ')' : '') : '';
    return '<div class="row">'
      + '<div><h3 class="rowTitle">' + item.alias + '</h3><div class="meta">kind: ' + (item.kind || 'unknown') + ' · captured: ' + formatTime(item.capturedAt) + user + '</div></div>'
      + '<div class="actionRow"><button class="btn" data-activate-snapshot="' + item.alias + '">激活</button></div>'
      + '</div>';
  }).join('');
}
function renderState(data) {
  const [dotClass, summary] = badgeState(data.gateway);
  els.gatewayDot.className = 'dot ' + dotClass;
  els.gatewaySummary.textContent = summary + (data.gateway && data.gateway.user && data.gateway.user.id ? ' · ' + data.gateway.user.id : '');
  renderKv(els.overviewKv, [
    ['当前用户', data.gateway && data.gateway.user ? ((data.gateway.user.id || 'unknown') + (data.gateway.user.name ? ' (' + data.gateway.user.name + ')' : '')) : '未登录'],
    ['快照数量', String((data.snapshots || []).length)],
    ['账号池策略', data.auth && data.auth.strategy ? data.auth.strategy : '—'],
    ['账号池文件', data.bridge && data.bridge.accountsPath ? data.bridge.accountsPath : '—'],
    ['应用路径', data.bridge && data.bridge.appPath ? data.bridge.appPath : '—']
  ]);
  renderKv(els.storageKv, [
    ['活动存储', data.storage && data.storage.kind ? data.storage.kind : 'none'],
    ['加密文件', data.storage && data.storage.encryptedExists ? data.storage.encryptedPath : 'missing'],
    ['明文回退', data.storage && data.storage.plaintextExists ? data.storage.plaintextPath : 'missing'],
    ['网关地址', data.gateway && data.gateway.baseUrl ? data.gateway.baseUrl : '—']
  ]);
  renderSnapshots(data.snapshots || []);
  renderAccounts(data.accounts || []);
}
async function refreshState(message) {
  const payload = await api('/admin/api/state');
  renderState(payload);
  if (message) setMessage('ok', message);
}
async function withAction(button, fn) {
  const prev = button.textContent;
  button.disabled = true;
  try { await fn(); } finally { button.disabled = false; button.textContent = prev; }
}
els.refreshBtn.addEventListener('click', () => withAction(els.refreshBtn, async () => { clearMessage(); await refreshState('状态已刷新。'); }));
els.logoutBtn.addEventListener('click', () => withAction(els.logoutBtn, async () => { clearMessage(); await api('/admin/api/gateway/logout', { method: 'POST', body: {} }); await refreshState(); setMessage('warn', '已请求 Accio 登出。'); }));
els.loginBtn.addEventListener('click', () => withAction(els.loginBtn, async () => { clearMessage(); const payload = await api('/admin/api/gateway/login', { method: 'POST', body: {} }); await refreshState(); if (payload.loginUrl) { window.open(payload.loginUrl, '_blank', 'noopener,noreferrer'); setMessage('ok', '已生成登录链接，并尝试在新窗口打开。登录完成后再点一次“刷新状态”。'); } else { setMessage('warn', '未收到登录链接。'); } }));
els.snapshotBtn.addEventListener('click', () => withAction(els.snapshotBtn, async () => { clearMessage(); const alias = els.snapshotAlias.value.trim(); if (!alias) { setMessage('error', '请先输入快照别名。'); return; } const payload = await api('/admin/api/snapshots', { method: 'POST', body: { alias } }); await refreshState(); els.snapshotAlias.value = payload.alias || alias; setMessage('ok', '快照已保存：' + (payload.alias || alias)); }));
els.captureBtn.addEventListener('click', () => withAction(els.captureBtn, async () => { clearMessage(); const accountId = els.captureAccountId.value.trim(); if (!accountId) { setMessage('error', '请先输入账号池别名。'); return; } const payload = await api('/admin/api/accounts/capture', { method: 'POST', body: { accountId } }); await refreshState(); setMessage('ok', '当前 token 已写入账号池：' + payload.accountId); }));
document.addEventListener('click', async (event) => {
  const activate = event.target.closest('[data-activate-snapshot]');
  if (activate) {
    const alias = activate.getAttribute('data-activate-snapshot');
    await withAction(activate, async () => { clearMessage(); const payload = await api('/admin/api/snapshots/activate', { method: 'POST', body: { alias } }); await refreshState(); setMessage('warn', payload.note || ('已激活快照 ' + alias + '。')); });
    return;
  }
  const fill = event.target.closest('[data-fill-account]');
  if (fill) {
    els.captureAccountId.value = fill.getAttribute('data-fill-account');
    setMessage('info', '已把账号别名填入“写入账号池”输入框。');
  }
});
refreshState().catch((error) => setMessage('error', error.message || String(error)));
</script>
</body>
</html>`;
}

async function handleAdminPage(req, res, config) {
  writeHtml(res, 200, renderAdminPage(config));
}

async function handleAdminState(req, res, config, authProvider) {
  writeJson(res, 200, await buildAdminState(config, authProvider));
}

async function handleAdminSnapshotCreate(req, res, config) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const alias = body && body.alias ? String(body.alias).trim() : "";
  if (!alias) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "alias is required" } });
    return;
  }
  const gateway = await readGatewayState(config.baseUrl);
  const result = snapshotActiveCredentials(alias, { gatewayUser: gateway.user || null });
  writeJson(res, 200, {
    ok: true,
    alias: result.alias,
    dir: result.dir,
    kind: result.metadata.kind,
    capturedAt: result.metadata.capturedAt
  });
}

async function handleAdminSnapshotActivate(req, res, config) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const alias = body && body.alias ? String(body.alias).trim() : "";
  if (!alias) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "alias is required" } });
    return;
  }
  const result = activateSnapshot(alias);
  const gateway = await readGatewayState(config.baseUrl);
  writeJson(res, 200, {
    ok: true,
    alias: result.alias,
    kind: result.kind,
    destination: result.destination,
    note: gateway.reachable
      ? "快照已恢复到磁盘。当前 4097 仍可能持有旧内存态，建议重启 Accio 或本地网关。"
      : "快照已恢复到磁盘，等待 Accio 下次启动时读取。"
  });
}

async function handleAdminGatewayLogin(req, res, gatewayManager) {
  const payload = await requestGatewayJson(gatewayManager, "/auth/login", { method: "POST", body: {} });
  writeJson(res, 200, { ok: true, loginUrl: payload && payload.loginUrl ? String(payload.loginUrl) : null });
}

async function handleAdminGatewayLogout(req, res, gatewayManager) {
  await requestGatewayJson(gatewayManager, "/auth/logout", { method: "POST", body: {} });
  writeJson(res, 200, { ok: true });
}

async function handleAdminCaptureAccount(req, res, config, gatewayManager) {
  const body = await readJsonBody(req, req.bridgeContext && req.bridgeContext.bodyParser ? req.bridgeContext.bodyParser : {});
  const accountId = body && body.accountId ? String(body.accountId).trim() : "";
  if (!accountId) {
    writeJson(res, 400, { error: { type: "invalid_request_error", message: "accountId is required" } });
    return;
  }
  const result = await gatewayManager.waitForGatewayToken();
  const accountsPath = writeAccountToFile(config.accountsPath, accountId, result.token);
  writeJson(res, 200, { ok: true, accountId, accountsPath, tokenPreview: maskToken(result.token) });
}

module.exports = {
  handleAdminPage,
  handleAdminState,
  handleAdminSnapshotCreate,
  handleAdminSnapshotActivate,
  handleAdminGatewayLogin,
  handleAdminGatewayLogout,
  handleAdminCaptureAccount
};
