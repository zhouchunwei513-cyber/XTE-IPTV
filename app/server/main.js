// XTE-IPTV Live Proxy — v4.0.0
// 从零全量重写：默认纯透传 + 可选缓存增强
// 零处理秒开 / 按需 N+3 预拉取 / TTL 时效管理 / 全链路容错 / 120s 会话保活
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const dns = require('dns');
const { URL, domainToASCII } = require('url');
const zlib = require('zlib');

// 中文/国际化域名 -> Punycode（ASCII）。裸域名、URL 都支持。
function toAsciiHost(input) {
  let s = String(input || '').trim();
  if (!s) return s;
  // 完整 URL：用 URL 解析后对 hostname 做转码
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(s)) {
    try {
      const u = new URL(s);
      if (u.hostname && /[^\x00-\x7F]/.test(u.hostname)) {
        u.hostname = domainToASCII(u.hostname) || u.hostname;
      }
      return u.toString();
    } catch { /* fallthrough */ }
  }
  // 拆出 host[:port]，仅对 host 部分转码（保留端口/路径）
  const m = /^([^/:?#]+)(.*)$/.exec(s);
  if (m) {
    let host = m[1];
    const rest = m[2] || '';
    const isV6 = host.startsWith('[');
    if (isV6) return s; // IPv6 无需转码
    if (/[^\x00-\x7F]/.test(host)) {
      host = domainToASCII(host) || host;
    }
    return host + rest;
  }
  return s;
}

const APP_VERSION = '5.0.1';

// ---------------------------------------------------------------------------
// 路径与配置
// ---------------------------------------------------------------------------
const DATA_DIR = process.env.DATA_DIR || path.join(os.tmpdir(), 'xte-data');
const WWW_DIR = path.join(__dirname, '..', 'www');
fs.mkdirSync(DATA_DIR, { recursive: true });

const PORT = parseInt(
  process.env.DEPLOY_RUN_PORT ||
  process.env.TRIM_SERVICE_PORT ||
  process.env.FPK_SERVICE_PORT ||
  process.env.PORT ||
  '34500',
  10
);

const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const CHANNELS_FILE = path.join(DATA_DIR, 'channels.json');
const SOURCES_FILE = path.join(DATA_DIR, 'sources.json');

const DEFAULT_CONFIG = {
  // v4.1.2 面向 8~12Mbps 高清直播（单分片约 10MB）调优。
  // 关键修复（CCTV5 卡顿根因）：
  //  - 首载时「流式回源」与「后台预取」曾同时下载同一个 10MB 分片，双倍带宽争抢使首片耗时≈分片时长，
  //    播放器首屏缓冲跟不上而停播。v4.1.2 用统一的 in-flight 登记表（streaming Map）让按需流与预取复用同一条回源连接。
  //  - 切台后旧频道的保活刷新仍在后台跑（日志中 CCTV6/4/3/2 堆积），挤占真实频道带宽。
  //    v4.1.2 用「最近观众活动窗口」门控后台刷新/预取，切走即停。
  cacheWindow: 12,                // 会话内存缓冲窗口（片）；配合字节上限，避免 4K 大分片把内存撑到 1GB+
  maxCacheBytes: 96 * 1024 * 1024,// 单会话缓存字节上限 96MB（4K 60MB/片≈1.5 片，高清 10MB≈9 片），按 FIFO 淘汰
  prefetchAhead: 3,               // 后台预取深度（片）；经全局调度器以低优先级执行，不与播放器抢带宽
  prefetchMemLimitMB: 1100,       // 预取全局内存闸门(MB)：RSS 超过此值才暂停预取；单会话已有字节上限兜底
                                  //   设过低（如旧值600MB）会让单路4K会话(正常约638MB)的预取被永久饿死，
                                  //   prefetched永远为0，播放器每片都冷启动等5s回源=频繁卡顿。
  prefetchMaxViewers: 1,          // 同时有真实观众的会话数超过此值(>1=多路并发)时，各路关闭预取，
                                  //   把出口带宽全部让给实时流。日志证实：单路4K(54MB/片)预取能消峰填谷，
                                  //   但2-3路4K并发时预取的大分片会与播放器当前片争抢带宽，触发10s超时
                                  //   中断正在播的分片，导致「上版能3路4K、这版只能1路」。单路时仍积极预取。
  refreshMinIntervalMs: 3000,     // m3u8 回源节流：同会话两次刷新至少间隔 3s
  keepAliveIntervalMs: 4000,      // 活跃会话后台保活周期
  activeWindowMs: 20000,          // 观众活动窗口：20s 内无 m3u8/分片请求即视为已切台，立即停止后台预取/刷新并回收
  sessionTtlMs: 30000,            // 会话空闲回收 30s（按真实观众活动 lastClientAt 判定，快速清理切走的僵尸会话）
  stalledRecoverMs: 60000,        // stalled 自动恢复：有连接但超过此时长(ms)无分片送达即断开重连，0=关闭
  segmentTtlMs: 45000,            // 分片缓存有效期 45s
  segRetry: 3,                    // 单分片失败重试次数
  segRetryIntervalMs: 500,        // 重试间隔 500ms
  refreshIntervalMin: 30,         // 源自动刷新周期（分钟）
  logBufferSize: 800,             // 内存日志缓冲条数（v4.1.1 调大，便于排障）
  maxConcurrentUpstreams: 6,      // 全局同时回源的分片连接数上限（v4.1.9 从3提到6，支持5路终端并发不排队）
  segmentUpstreamTimeoutMs: 30000,// 分片回源 socket 无数据静默超时（v4.1.9 从≈10s放宽到30s，避免4K大分片被误杀）
  // 多线路播放列表（对标 xTeVe，PC 客户端依赖）：
  // 内网 IPv4 默认启用（host 留空自动用本机 LAN IP）；IPv6 DDNS / FRP 中转默认关闭
  lineInner: { enabled: true, host: '', port: PORT },
  lineIpv6: { enabled: false, host: '', port: PORT },
  lineFrp: { enabled: false, host: '', port: PORT },
  mergeLines: false,              // 是否生成三线路合并列表 /m3u/all.m3u8
};

let config = loadJson(CONFIG_FILE, DEFAULT_CONFIG);
config = Object.assign({}, DEFAULT_CONFIG, config);
normalizeConfigLines(config);

// 内存日志缓冲
const logs = [];
function log(level, msg, extra) {
  const entry = {
    t: Date.now(),
    level,
    msg,
    extra: extra || undefined,
  };
  logs.push(entry);
  if (logs.length > config.logBufferSize) logs.shift();
  const line = `[${new Date(entry.t).toISOString()}] ${level.toUpperCase()} ${msg}` +
    (extra ? ' ' + safeStringify(extra) : '');
  if (level === 'error') console.error(line);
  else console.log(line);
}
function safeStringify(o) {
  try { return JSON.stringify(o); } catch { return '[unserializable]'; }
}

function loadJson(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const v = JSON.parse(raw);
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(file, data) {
  try {
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
  } catch (e) {
    log('error', '保存数据失败: ' + file + ' ' + e.message);
  }
}

// ---------------------------------------------------------------------------
// 全局回源下载调度器（v4.1.2 卡顿核心修复）
//   根因：日志显示多个会话同时从源站下载（CCTV1 10MB + 北京卫视4K 60MB/片 等），
//   并发占满 NAS 出口带宽（约 20~24Mbps），导致正常观看的频道每片要等 4~5 秒，
//   命中率掉到 10% 以下、持续转圈。
//   策略：
//     1) 全局限流：最多 maxConcurrent 个分片同时回源，其余按优先级排队。
//        v4.1.9：从 3 提到 6——实测 5 路终端(4×4K+1×1080P)同时观看时，每路 4K 大分片
//        (54MB)要占一个槽位下载 10-30s，3 个槽位根本不够，其余流全部排队等槽位，
//        表现为「5 个设备周期性同时卡」。提到 6 保证每路实时流都有独立回源连接；
//        配合多路并发关闭预取 + 背压 pause/resume，不会打爆出口或内存。
//     2) 优先级：播放器「正在等」的按需流优先于后台预取，预取只在有余量时执行。
//     3) 慢客户端保护：播放器持续读不动时暂停上游，不把大分片堆进内存空占带宽。
//     4) 全局可观测：记录活跃下载数/总吞吐/排队长度，写入日志与 /api/status。
// ---------------------------------------------------------------------------
const DOWNLOAD_SCHED = {
  maxConcurrent: (config.maxConcurrentUpstreams > 0 ? config.maxConcurrentUpstreams : 6),
  active: 0,
  queue: [],
  running: [],   // {job, done, abort} 正在执行的任务
  bytesWindow: 0,
  windowStartedAt: Date.now(),
  history: [],
  schedule() {
    while (this.active < this.maxConcurrent && this.queue.length) {
      let best = 0;
      for (let i = 1; i < this.queue.length; i++) {
        if (this.queue[i].priority > this.queue[best].priority) best = i;
      }
      const job = this.queue.splice(best, 1)[0];
      this.active++;
      let doneCalled = false;
      const slot = { job, abort: null };
      const done = () => {
        if (doneCalled) return;
        doneCalled = true;
        this.active--;
        const idx = this.running.indexOf(slot);
        if (idx >= 0) this.running.splice(idx, 1);
        setImmediate(() => this.schedule());
      };
      this.running.push(slot);
      // runner 可接收一个 abortSignal（{aborted}），被抢占时置 aborted=true，
      // fetchSegment 的预取分支据此中止上游、让出带宽给播放器实时流。
      const abortSignal = { aborted: false };
      slot.abort = () => { abortSignal.aborted = true; };
      job.abortSignal = abortSignal;
      Promise.resolve().then(() => job.runner(abortSignal)).then(
        (v) => { done(); job.resolve(v); },
        (e) => { done(); job.reject(e); }
      );
    }
  },
  submit(priority, runner) {
    return new Promise((resolve, reject) => {
      const job = { priority, runner, resolve, reject, abortSignal: null };
      this.queue.push(job);
      // 高优先级（播放器实时流 priority>=10）到来且槽位占满时，抢占一个正在运行的
      // 最低优先级任务（通常是后台预取 priority=1），让播放器首片/下一片立刻获得带宽，
      // 避免「隔一会卡一下」——预取占满 3 个槽位时播放器被迫排队等待。
      if (priority >= 10 && this.active >= this.maxConcurrent) {
        let victim = null;
        for (const r of this.running) {
          if (r.job.priority < priority && (!victim || r.job.priority < victim.job.priority)) {
            victim = r;
          }
        }
        if (victim) {
          try { victim.abort && victim.abort(); } catch {}
        }
      }
      this.schedule();
    });
  },
  recordBytes(n, durationMs) {
    this.bytesWindow += n;
    this.history.push({ bytes: n, ms: durationMs, at: Date.now() });
    if (this.history.length > 80) this.history.shift();
  },
  kbps() {
    const now = Date.now();
    const recent = this.history.filter((h) => now - h.at < 15000 && h.ms > 0);
    if (!recent.length) return 0;
    const bytes = recent.reduce((s, h) => s + h.bytes, 0);
    const span = Math.max(1000, now - recent[0].at);
    return Math.round(bytes / 1024 / (span / 1000));
  },
  queued() { return this.queue.length; },
  activeCount() { return this.active; },
};

// ---------------------------------------------------------------------------
// 数据模型
// ---------------------------------------------------------------------------
// sources: [{ id, name, url, type:'remote'|'local', enabled, autoRefresh, lastRefreshAt, channelCount, error }]
let sources = loadJson(SOURCES_FILE, []);
// channels: [{ id, name, tvgId, logo, group, url, sourceId, enabled }]
let channels = loadJson(CHANNELS_FILE, []);

function persistSources() { saveJson(SOURCES_FILE, sources); }
function persistChannels() { saveJson(CHANNELS_FILE, channels); }
function persistConfig() { saveJson(CONFIG_FILE, config); }

// ---------------------------------------------------------------------------
// 多线路网络工具
// ---------------------------------------------------------------------------
function detectLanIp() {
  try {
    const ifaces = os.networkInterfaces();
    const cands = [];
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) {
          if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ni.address)) cands.unshift(ni.address);
          else cands.push(ni.address);
        }
      }
    }
    return cands[0] || '127.0.0.1';
  } catch { return '127.0.0.1'; }
}

function defaultLine() { return { enabled: false, host: '', port: PORT }; }

function normalizeLine(l, { allowEmptyHost = false, optionalPort = false } = {}) {
  const o = l && typeof l === 'object' ? l : {};
  const host = toAsciiHost(String(o.host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, ''));
  const port = parseInt(o.port, 10);
  // 内网线路允许 host 为空（自动用 LAN IP）；其余线路必须有 host 才视为启用
  const enabled = allowEmptyHost ? (o.enabled !== false) : (o.enabled === true && !!host);
  // FRP 端口由服务商映射给出：可能在 host 中自带，也可能单独填。
  // optionalPort 时保留 0（表示未单独提供），由 lineBase 结合 host 自带端口决定；缺失则该线路不生效。
  const validPort = port > 0 && port < 65536 ? port : (optionalPort ? 0 : PORT);
  return { enabled, host, port: validPort };
}

// 规整化用户输入的 host[:port] / URL，返回 { host, port }
// 若 host 自带端口（FRP 场景）则优先用自带端口，避免双端口 bug
function parseHostPort(raw, fallbackPort) {
  let s = String(raw || '').trim();
  if (!s) return null;
  if (!/^\[/.test(s) && /:.*:/.test(s) && !/^https?:\/\//i.test(s)) s = '[' + s + ']';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'http://' + s;
  let u;
  try { u = new URL(s); } catch {
    const m = /^\[?([0-9a-fA-F:]+)\]?:(\d+)$/.exec(String(raw).trim());
    if (m) return { host: m[1], port: parseInt(m[2], 10) };
    const m2 = /^([^:/?#]+):(\d+)$/.exec(String(raw).trim());
    if (m2) return { host: m2[1], port: parseInt(m2[2], 10) };
    let h = String(raw).trim().replace(/[/?#].*$/, '');
    if (/^[0-9a-fA-F:]+$/.test(h) && h.includes(':')) h = '[' + h + ']';
    return { host: h, port: fallbackPort || 0 };
  }
  let host = u.hostname.replace(/^\[|\]$/g, '');
  const port = u.port ? parseInt(u.port, 10) : (fallbackPort || 0);
  if (!host) return null;
  if (host.includes(':') && !host.startsWith('[')) host = '[' + host + ']';
  return { host, port };
}

// 解析一条线路配置为「不含路径、http:// 开头」的基地址
function lineBase(line, kind) {
  if (!line || line.enabled === false) return '';
  // fallbackPort：0 表示「未提供则线路无效」（FRP 服务商端口必须显式给出）
  const fallbackPort = (kind === 'frp') ? (line.port || 0) : (line.port || PORT);
  if (kind === 'inner') {
    const raw = String(line.host || '').trim();
    if (!raw) {
      const p = fallbackPort || PORT;
      return `http://${detectLanIp()}:${p}`;
    }
    const hp = parseHostPort(raw, fallbackPort || PORT);
    if (!hp || !hp.port) return '';
    return `http://${hp.host}:${hp.port}`;
  }
  if (!line.host) return '';
  const hp = parseHostPort(String(line.host).trim(), fallbackPort);
  if (!hp || !hp.port) return ''; // FRP：服务商端口必须可确定（自带或单独填）
  return `http://${hp.host}:${hp.port}`;
}

function buildChannelExtinf(ch) {
  const meta = ['-1'];
  if (ch.group) meta.push('group-title="' + ch.group.replace(/"/g, '') + '"');
  if (ch.tvgId) meta.push('tvg-id="' + ch.tvgId.replace(/"/g, '') + '"');
  if (ch.logo) meta.push('tvg-logo="' + ch.logo.replace(/"/g, '') + '"');
  const name = ch.name || ch.url;
  meta.push('tvg-name="' + name.replace(/"/g, '') + '"');
  return '#EXTINF:' + meta.join(' ') + ',' + name;
}

// 单线路播放列表：每频道一个 /play/{id}.m3u8
function buildLinePlaylist(base, list, line) {
  const lines = ['#EXTM3U', '#PLAYLIST:XTE-IPTV'];
  let skipped = 0;
  // 把线路显式附加到 /play 地址，避免经 fnOS 网关/反代后 Host 丢失导致线路识别回退成「内网」。
  const lp = line ? '?line=' + encodeURIComponent(line) : '';
  for (const ch of list) {
    if (ch.enabled === false) { skipped++; continue; }
    lines.push(buildChannelExtinf(ch));
    lines.push(`${base}/play/${encodeURIComponent(ch.id)}.m3u8${lp}`);
  }
  return { text: lines.join('\n') + '\n', skipped };
}

// 三线路合并列表：每频道三条线路地址，标注 [内网]/[IPv6]/[FRP]
function buildMergedPlaylist(bases, list) {
  const lines = ['#EXTM3U', '#PLAYLIST:XTE-IPTV-ALL'];
  const labels = { inner: '内网', ipv6: 'IPv6', frp: 'FRP' };
  for (const ch of list) {
    if (ch.enabled === false) continue;
    for (const kind of ['inner', 'ipv6', 'frp']) {
      const base = bases[kind]; if (!base) continue;
      const name = ch.name || ch.url;
      const meta = ['-1'];
      if (ch.group) meta.push('group-title="' + ch.group.replace(/"/g, '') + '"');
      if (ch.tvgId) meta.push('tvg-id="' + ch.tvgId.replace(/"/g, '') + '"');
      if (ch.logo) meta.push('tvg-logo="' + ch.logo.replace(/"/g, '') + '"');
      meta.push('tvg-name="' + name.replace(/"/g, '') + ' [' + labels[kind] + ']"');
      lines.push('#EXTINF:' + meta.join(' ') + ',' + name + ' [' + labels[kind] + ']');
      lines.push(`${base}/play/${encodeURIComponent(ch.id)}.m3u8?line=` + encodeURIComponent(kind));
    }
  }
  return lines.join('\n') + '\n';
}

// 规整化 config 中的线路字段（加载后调用一次）
function normalizeConfigLines(cfg) {
  cfg.lineInner = normalizeLine(
    Object.assign({}, DEFAULT_CONFIG.lineInner, cfg.lineInner || {}),
    { allowEmptyHost: true }
  );
  cfg.lineIpv6 = normalizeLine(Object.assign({}, defaultLine(), cfg.lineIpv6 || {}));
  cfg.lineFrp = normalizeLine(Object.assign({}, defaultLine(), cfg.lineFrp || {}), { optionalPort: true });
  cfg.mergeLines = cfg.mergeLines === true;
}

function getLineBases() {
  return {
    inner: lineBase(config.lineInner, 'inner'),
    ipv6: lineBase(config.lineIpv6, 'ipv6'),
    frp: lineBase(config.lineFrp, 'frp'),
  };
}

// 解析播放列表/分片对外基地址。对齐 v4.1.2「所有终端都能看」的关键行为：
// 播放器用哪个 Host 连上 XTE（内网 IP / FRP 公网域名 / IPv6），分片就指回哪个 Host。
//
// 规则：
// 1) 线路显式配置了 host（bases[kind]）时优先用配置——这是用户明确声明的对外地址；
// 2) 否则用本次请求的 Host（含 x-forwarded-proto），保证经任意网关/反代回连都可达；
// 3) 例外：若配置地址指向 127.0.0.1/localhost（FRP 经 fnOS 网关回连时常见），
//    它对外部播放器不可达，此时也回退到请求 Host，避免「只有直连内网的客户端能播」。
function resolvePlaybackBase(kind, req) {
  const bases = getLineBases();
  const configured = kind ? bases[String(kind).toLowerCase()] : '';
  const host = (req && req.headers && req.headers.host) || ('localhost:' + PORT);
  const proto = ((req && req.headers && req.headers['x-forwarded-proto']) || 'http').toString().split(',')[0];
  const reqBase = proto + '://' + host;
  if (configured) {
    try {
      const u = new URL(configured);
      const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
      if (h === '127.0.0.1' || h === '::1' || h === 'localhost') {
        return reqBase; // 配置的是回环地址，外部不可达，用请求 Host
      }
    } catch (_) {}
    return configured;
  }
  return reqBase;
}

// ---------------------------------------------------------------------------
// HTTP 工具：回源（直连源站，零加工）
// ---------------------------------------------------------------------------
// 跨网/外网访问：足够大的连接池复用 TCP+TLS，避免每片重新握手造成卡顿
const KEEP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: 60000 });
const KEEP_AGENT_S = new https.Agent({ keepAlive: true, maxSockets: 128, maxFreeSockets: 32, timeout: 60000, rejectUnauthorized: false });

const REDIRECT_LIMIT = 5;

// 回源网络日志节流：同一 host 在 netLogThrottleMs 内只记录一次，避免高频分片刷屏。
const netLogThrottleMs = 15000;
const lastNetLog = new Map();
function netLog(level, msg, extra, force) {
  const host = extra && extra.host;
  const now = Date.now();
  const key = msg + '|' + (host || '');
  if (!force && host) {
    const last = lastNetLog.get(key) || 0;
    if (now - last < netLogThrottleMs) return;
  }
  lastNetLog.set(key, now);
  log(level, msg, extra);
}

// 从 URL 中取 host:port 用于日志（脱敏查询串）
function hostLabel(u) {
  try {
    const x = (u instanceof URL) ? u : new URL(u);
    return x.port ? x.hostname + ':' + x.port : x.hostname;
  } catch { return String(u); }
}

function fetchUpstream(targetUrl, { headers, timeoutMs, method } = {}) {
  // 中文域名自动 Punycode 转码  targetUrl = toAsciiHost(targetUrl);
  return new Promise((resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch (e) { return reject(e); }
    const lib = parsed.protocol === 'https:' ? https : http;
    const agent = parsed.protocol === 'https:' ? KEEP_AGENT_S : KEEP_AGENT;
    const reqHeaders = Object.assign({
      'User-Agent': 'Mozilla/5.0 (XTE-IPTV/4.0; +native-hls)',
      'Accept': '*/*',
      // XTE 需要解析/改写 m3u8 文本，强制上游返回未压缩内容（分片走 pipeUpstream 透传不受影响）
      'Accept-Encoding': 'identity',
    }, headers || {});
    delete reqHeaders.host;
    delete reqHeaders.Host;

    const doReq = (urlStr, redirsLeft) => {
      let u;
      try { u = new URL(urlStr); } catch (e) { return reject(e); }
      // IPv6 字面地址：URL.hostname 已去方括号，显式 family:6 避免 getaddrinfo 把它当域名
      let hostname = u.hostname;
      const isV6 = hostname.includes(':') || /^\[.*\]$/.test(hostname);
      if (isV6) hostname = hostname.replace(/^\[|\]$/g, '');
      const reqOpts = {
        method: method || 'GET',
        protocol: u.protocol,
        hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        headers: reqHeaders,
        agent,
        timeout: timeoutMs || 10000,
        lookup: (host, opts, cb) => {
          // 网络环境感知：记录源站 DNS 解析耗时与解析到的边缘 IP，
          // 多 CDN 节点返回不同边缘时可从日志判断是否因节点漂移导致序号回退/404。
          const dns0 = Date.now();
          dns.lookup(host, opts, (err, address, family) => {
            const dnsMs = Date.now() - dns0;
            if (err) {
              netLog('warn', '回源 DNS 解析失败', { host, type: err.code, costMs: dnsMs }, true);
            } else if (redirsLeft === REDIRECT_LIMIT) {
              netLog('info', '回源网络环境', { host, edgeIp: address, family: 'IPv' + family, dnsMs });
            }
            cb(err, address, family);
          });
        },
      };
      if (isV6) reqOpts.family = 6;
      const tConn = Date.now();
      const req = lib.request(reqOpts, (res) => {
        const connectMs = Date.now() - tConn; // 建连+首字节到达的总等待（TTFB 近似）
        const status = res.statusCode;
        if (status >= 300 && status < 400 && res.headers.location && redirsLeft > 0) {
          res.resume();
          const next = new URL(res.headers.location, urlStr).toString();
          netLog('info', '回源重定向', { from: hostLabel(u), to: hostLabel(next), status, connectMs });
          return doReq(next, redirsLeft - 1);
        }
        if (redirsLeft === REDIRECT_LIMIT) {
          netLog('info', '回源响应', { host: hostLabel(u), status, connectMs,
            contentType: res.headers['content-type'] || '', contentLength: res.headers['content-length'] || '' });
        }
        resolve({ res, status, headers: res.headers, url: urlStr, connectMs });
      });
      req.on('timeout', () => {
        netLog('warn', '回源请求超时', { host: hostLabel(u), timeoutMs: timeoutMs || 10000 }, true);
        req.destroy(new Error('upstream timeout'));
      });
      req.on('error', (e) => {
        netLog('warn', '回源连接错误', { host: hostLabel(u), type: e.code || classifyError(e), error: e.message }, true);
        reject(e);
      });
      req.end();
    };
    doReq(targetUrl, REDIRECT_LIMIT);
  });
}

// 纯透传：流式转发，不修改任何字节
function pipeUpstream(targetUrl, req, res, extraLog, onBytes) {
  const fwdHeaders = {};
  for (const k of Object.keys(req.headers)) {
    if (['host', 'connection', 'accept-encoding', 'content-length'].includes(k)) continue;
    fwdHeaders[k] = req.headers[k];
  }
  const startedAt = Date.now();
  let bytes = 0;
  fetchUpstream(targetUrl, { headers: fwdHeaders, timeoutMs: 15000 })
    .then(({ res: up, status, headers: upHeaders }) => {
      res.writeHead(status, upHeaders);
      up.on('data', (c) => { bytes += c.length; });
      up.pipe(res);
      up.on('error', (e) => {
        log('error', '透传流出错 ' + (extraLog || ''), { error: e.message });
        try { res.end(); } catch {}
      });
      res.on('close', () => { try { up.destroy(); } catch {} if (onBytes) onBytes(bytes); });
      log('info', '透传 ' + (extraLog || '') + ' ' + status + ' ' + (Date.now() - startedAt) + 'ms');
    })
    .catch((e) => {
      const cls = classifyError(e);
      log('error', '透传失败 ' + (extraLog || ''), { type: cls, error: e.message });
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'upstream_error', type: cls, message: e.message }));
      if (onBytes) onBytes(bytes);
    });
}

// 整页拉取（用于 m3u8 解析）；自动处理 gzip/deflate/br 压缩
function fetchText(url, headers) {
  return fetchUpstream(url, { headers, timeoutMs: 10000 }).then(({ res, status }) => {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let stream = res;
      const enc = (res.headers['content-encoding'] || '').toLowerCase();
      if (enc === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (status < 200 || status >= 300) {
          return reject(new Error('upstream status ' + status));
        }
        resolve(buf);
      });
      stream.on('error', reject);
      res.on('error', reject);
    });
  });
}

function classifyError(e) {
  const m = (e && e.message) ? e.message : String(e);
  if (/timeout/i.test(m)) return 'timeout';
  if (/status 404/.test(m)) return '404';
  if (/status 403/.test(m)) return '403';
  if (/status (5\d\d)/.test(m)) return '5xx';
  if (/parse|invalid/i.test(m)) return 'parse';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|network|socket/i.test(m)) return 'connection';
  return 'unknown';
}

// ---------------------------------------------------------------------------
// M3U 解析
// ---------------------------------------------------------------------------
function parseM3U(text) {
  const lines = text.split(/\r?\n/);
  const segs = [];
  let attrs = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXTINF')) {
      attrs = parseExtinf(line);
    } else if (line.startsWith('#EXT-X-STREAM-INF')) {
      attrs = parseExtinf(line);
    } else if (line && !line.startsWith('#')) {
      segs.push({ url: line, attrs });
      attrs = {};
    }
  }
  return segs;
}

function parseExtinf(line) {
  const out = {};
  // 兼容三种属性写法：key="v"、key='v'、key=v（无引号，到空白/逗号为止）
  const re = /([a-zA-Z0-9_-]+)=(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let m;
  while ((m = re.exec(line))) out[camel(m[1])] = (m[2] !== undefined ? m[2] : (m[3] !== undefined ? m[3] : m[4])) || '';
  const comma = line.lastIndexOf(',');
  if (comma >= 0) out.title = line.slice(comma + 1).trim();
  return out;
}
function camel(k) {
  const map = {
    'tvg-id': 'tvgId', 'tvg-name': 'tvgName', 'tvg-logo': 'logo',
    'group-title': 'group', 'group-title-letter': 'groupLetter',
  };
  return map[k] || k;
}

function buildM3U(chList) {
  const lines = ['#EXTM3U'];
  for (const c of chList) {
    const name = c.name || c.tvgName || 'Unknown';
    const attr = [];
    if (c.tvgId) attr.push(`tvg-id="${c.tvgId}"`);
    if (c.tvgName || c.name) attr.push(`tvg-name="${c.tvgName || c.name}"`);
    if (c.logo) attr.push(`tvg-logo="${c.logo}"`);
    if (c.group) attr.push(`group-title="${c.group}"`);
    lines.push(`#EXTINF:-1 ${attr.join(' ')},${name}`);
    lines.push(c.url);
  }
  return lines.join('\n') + '\n';
}

// 解析分片 m3u8（含序号、是否直播）
function parseMediaPlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segs = [];
  let targetDuration = 10;
  let mediaSeq = 0;
  let ended = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.split(':')[1], 10) || 10;
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSeq = parseInt(line.split(':')[1], 10) || 0;
    } else if (line === '#EXT-X-ENDLIST') {
      ended = true;
    } else if (line && !line.startsWith('#')) {
      segs.push(absUrl(line, baseUrl));
    }
  }
  return { segs, targetDuration, mediaSeq, ended, raw: text };
}

function absUrl(u, base) {
  try { return new URL(u, base).toString(); } catch { return u; }
}

// 统一改写：把 m3u8 内的分片 / 子列表 / 加密 KEY / MAP 初始化段全部改写为走 XTE 代理。
// - 分片走 /proxy/ts?sid=...（命中会话缓冲/预取）
// - 子多码率 m3u8 走 /proxy/m3u8?url=...（继续由 servePlaylist 处理，sid 透传以便同会话）
// - EXT-X-KEY / EXT-X-MAP 的 URI 走 /proxy/ts（密钥/初始化段也需代理，否则外网取不到）
// baseUrl 用于把源站相对地址解析成绝对地址。
function rewriteMediaPlaylist(raw, proxyBase, sid, badKeys, baseUrl, line) {
  const lines = raw.split(/\r?\n/);
  const out = [];
  let pendingDisc = false;
  const sidParam = '&sid=' + encodeURIComponent(sid);
  // 把线路标识透传到分片/子清单 URL，保证播放器后续 /proxy/ts 请求仍能识别真实线路
  // （否则 /proxy/ts 不带线路信息，detectLine 会退回按 Host/IP 猜测，FRP/IPv6 被误判成内网）
  const lineParam = line ? '&line=' + encodeURIComponent(line.toLowerCase()) : '';
  const rewriteUri = (u) => {
    const abs = baseUrl ? absUrl(u, baseUrl) : u;
    const isNested = /\.m3u8(\?|$)/i.test(abs);
    const ep = isNested ? '/proxy/m3u8' : '/proxy/ts';
    // 子 m3u8 不需要 sid（它是独立频道的另一条流）；分片/KEY/MAP 带 sid 命中会话
    const suffix = (isNested ? '' : sidParam) + lineParam;
    return proxyBase + ep + '?url=' + encodeURIComponent(abs) + suffix;
  };
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) { out.push(line); continue; }
    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#EXT-X-KEY:') || trimmed.startsWith('#EXT-X-MAP:')) {
        line = line.replace(/URI="([^"]+)"/i, (m, u) => 'URI="' + rewriteUri(u) + '"');
      }
      out.push(line);
      continue;
    }
    // 数据行：分片或子 m3u8
    const abs = baseUrl ? absUrl(trimmed, baseUrl) : trimmed;
    const key = segKey(abs);
    if (badKeys && badKeys.has(key)) {
      if (!pendingDisc) { out.push('#EXT-X-DISCONTINUITY'); pendingDisc = true; }
      continue;
    }
    pendingDisc = false;
    const isNested = /\.m3u8(\?|$)/i.test(abs);
    if (isNested) {
      out.push(proxyBase + '/proxy/m3u8?url=' + encodeURIComponent(abs) + lineParam);
    } else {
      out.push(proxyBase + '/proxy/ts?sid=' + encodeURIComponent(sid) +
        '&url=' + encodeURIComponent(abs) + lineParam);
    }
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// 会话与缓冲子系统（v4.1 统一智能缓冲模式）
// ---------------------------------------------------------------------------
class SegmentSession {
  constructor(channelUrl, chan) {
    this.channelUrl = channelUrl;
    this.chan = chan || {};
    this.id = crypto.createHash('sha1').update(channelUrl).digest('hex').slice(0, 12);
    this.segs = new Map();       // segKey -> { buffer, contentType, at, url }
    this.order = [];             // 滑动窗口 segKey 顺序
    this.cacheBytes = 0;         // 当前缓存占用字节（用于 4K 大分片的字节上限淘汰）
    this.streaming = new Map();  // segKey -> InFlight（统一在途下载：按需流+预取共享）
    this.lastSegs = [];          // 最新索引分片绝对URL列表（顺序）
    this.playlistRaw = '';
    this.mediaSeq = 0;
    this.targetDuration = 10;
    this.createdAt = Date.now();
    this.activeAt = Date.now();
    this.active = 0;             // 活跃连接计数
    this.mode = 'smart';         // v4.1 统一智能缓冲模式
    this.consecutiveFail = 0;
    this.badKeys = new Set();
    this.stats = { hit: 0, miss: 0, prefetched: 0, fail: 0, prefetchFail: 0 };
    this.refreshing = null;
    this.lastRefreshAt = 0;       // 上次成功回源 m3u8 的时间戳（节流用）
    this.refreshFails = 0;        // 连续刷新失败次数（退避用）
    this.destroyed = false;
    this.lastClientAt = Date.now(); // 最近一次「观众请求」(m3u8/分片) 时间，用于门控后台活动与判定播放状态
    this.lastSegServedAt = 0;       // 最近一次成功向观众发送分片的时间
    this.lastErrAt = 0;             // 最近一次回源/传输错误时间
    this.lastErrMsg = '';
    this.stalledSince = 0;          // 首次进入 stalled（有连接但长时间无分片送达）的时间戳，用于自动恢复
    // 统一的在途中下载登记表（segKey -> InFlight）。
    // 按需流式回源与后台预取共用同一条上游连接，彻底消除「同一 10MB 分片被下载两次」的带宽争抢。
    this.streaming = new Map();
    this._prefQueue = [];         // 串行化预取队列（URL 列表）
    this._prefRunning = false;    // 预取队列是否正在消费
    this._prefInFlight = null;    // 当前正在下载的预取 URL（去重用）
    this._avgSegBytes = 0;        // 最近分片平均字节数（EWMA），用于判断大小片、自适应预取深度
    // 客户端连接元数据（连接明细）
    this.clientIp = '';
    this.terminal = '';
    this.line = '';
    this.lastSeen = 0;
    this.userAgent = '';
  }

  // 记录客户端信息（每次播放请求更新，取最近一次）
  noteClient(req, lineHint) {
    const ip = clientIp(req);
    if (ip) this.clientIp = ip;
    this.terminal = detectTerminal(req);
    const ua = (req && req.headers && req.headers['user-agent'] || '').toString();
    if (ua) this.userAgent = ua;
    // 线路以播放列表请求（/m3u/frp 等）为权威；分片请求没有 ?line=，
    // 不要用 Host 头回退去覆盖已建立的 FRP/IPv6 线路，否则会显示成内网。
    if (lineHint) {
      this.line = lineHint;
    } else if (req) {
      try {
        const u = new URL(req.url, 'http://x');
        const ql = u.searchParams.get('line');
        if (ql && /^(inner|ipv6|frp)$/i.test(ql)) this.line = ql.toUpperCase();
      } catch (_) {}
    }
    this.lastSeen = Date.now();
  }

  // 标记一次「观众活动」：播放器实际发起了 m3u8 或分片请求。
  // 与 activeAt（任何请求结束都会刷新）不同，lastClientAt 仅在有真实观众请求时刷新，
  // 用于判断切台后该频道是否还有人看、是否还需要后台预取/保活。
  markViewerActivity() {
    this.lastClientAt = Date.now();
    this.activeAt = Date.now();
  }

  // 最近 activeWindowMs 内是否还有观众请求（true=正在被观看/刚切走）
  hasRecentViewer(winMs) {
    return (Date.now() - this.lastClientAt) < (winMs || config.activeWindowMs || 45000);
  }

  // 播放状态判定（供日志/连接明细展示）：
  //  - playing：有活跃连接 或 最近 20s 内成功发过分片
  //  - stalled：有观众但最近一个分片窗口内没取新片（疑似转圈/缓冲）
  //  - idle：观众已切走，只剩后台进程在跑
  //  - error：最近发生过回源错误
  playState() {
    const now = Date.now();
    if (this.lastErrAt && now - this.lastErrAt < 15000) return 'error';
    if (this.active > 0) {
      // 有观众在请求，但超过 1.5 个分片时长没成功发出过分片 → 疑似卡顿（缓冲跟不上）
      if (this.lastSegServedAt && now - this.lastSegServedAt > this.targetDuration * 1500) return 'stalled';
      return 'playing';
    }
    if (this.lastSegServedAt && now - this.lastSegServedAt <= (this.targetDuration * 1000 * 2)) return 'playing';
    if (this.hasRecentViewer()) {
      return this.lastSegServedAt && now - this.lastSegServedAt > (this.targetDuration * 1000 * 2.5) ? 'stalled' : 'playing';
    }
    return 'idle';
  }

  reqStart() { this.active++; this.touch(); }
  reqEnd() { this.active = Math.max(0, this.active - 1); this.touch(); }
  touch() { this.activeAt = Date.now(); }

  isIdle(ttlMs) {
    if (this.active > 0) return false;
    return Date.now() - this.activeAt > ttlMs;
  }

  // 回源刷新最新索引。
  // 关键设计（v4.1.1）：
  //  - 节流：距上次成功刷新不足 refreshMinIntervalMs 且已有索引时，直接复用，不回源（避免播放器高频轮询打爆源站）。
  //  - 序号守护：源站多 CDN 节点可能返回滞后的旧清单（mediaSeq 回退），会导致播放器反复请求已淘汰旧片而卡顿，
  //    这里拒绝比当前更旧的清单。
  //  - 失败退避：连续失败时拉长回源间隔，避免在源站限流时持续重试压垮连接。
  async refresh() {
    if (this.refreshing) return this.refreshing;
    const now = Date.now();
    const hasIndex = !!this.playlistRaw;
    const since = now - this.lastRefreshAt;
    const minGap = config.refreshMinIntervalMs || 0;
    // 失败退避：连续失败 N 次时，最小间隔翻倍（上限 15s），给源站恢复时间
    const backoff = this.refreshFails > 0
      ? Math.min(15000, minGap * Math.pow(2, Math.min(this.refreshFails - 1, 3)))
      : 0;
    if (hasIndex && since < Math.max(minGap, backoff)) {
      // 节流命中：返回当前内存索引，不回源
      return { segs: this.lastSegs, mediaSeq: this.mediaSeq, targetDuration: this.targetDuration, cached: true, throttled: true };
    }
    this.refreshing = (async () => {
      const t0 = Date.now();
      try {
        const buf = await fetchText(this.channelUrl, {
          'User-Agent': 'Mozilla/5.0 (XTE-IPTV/4.1; +native-hls)',
        });
        const text = buf.toString('utf8');
        const pl = parseMediaPlaylist(text, this.channelUrl);
        // 序号守护：只接受不落后于当前的清单
        if (this.playlistRaw && pl.mediaSeq > 0 && this.mediaSeq > 0 && pl.mediaSeq < this.mediaSeq) {
          log('warn', '索引序号回退，已丢弃旧清单 session=' + this.id,
            { gotSeq: pl.mediaSeq, curSeq: this.mediaSeq, ageMs: since, costMs: Date.now() - t0 });
          this.refreshFails = 0;
          this.lastRefreshAt = Date.now();
          return { segs: this.lastSegs, mediaSeq: this.mediaSeq, targetDuration: this.targetDuration, cached: true, stale: true };
        }
        const seqChanged = pl.mediaSeq !== this.mediaSeq;
        this.playlistRaw = text;
        this.lastSegs = pl.segs;
        this.mediaSeq = pl.mediaSeq;
        this.targetDuration = pl.targetDuration;
        this.lastRefreshAt = Date.now();
        this.refreshFails = 0;
        log('info', '索引同步 session=' + this.id,
          { segs: pl.segs.length, seq: pl.mediaSeq, seqChanged, costMs: Date.now() - t0, bytes: buf.length });
        return pl;
      } catch (e) {
        this.refreshFails++;
        log('error', '索引刷新失败 session=' + this.id,
          { type: classifyError(e), error: e.message, fails: this.refreshFails, costMs: Date.now() - t0 });
        throw e;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  get(key) {
    const item = this.segs.get(key);
    if (!item) return null;
    if (Date.now() - item.at > config.segmentTtlMs) {
      this.evict(key);
      log('info', '分片过期剔除 session=' + this.id, { key: shortKey(key) });
      return null;
    }
    return item;
  }

  put(key, url, buffer, contentType) {
    if (this.segs.has(key)) {
      // 覆盖已存在项，先减去旧值字节数
      const old = this.segs.get(key);
      this.cacheBytes -= (old && old.buffer ? old.buffer.length : 0);
    }
    this.segs.set(key, { buffer, contentType, at: Date.now(), url });
    this.cacheBytes += buffer.length;
    if (!this.order.includes(key)) this.order.push(key);
    const maxBytes = config.maxCacheBytes || (96 * 1024 * 1024);
    while ((this.order.length > config.cacheWindow || this.cacheBytes > maxBytes) && this.order.length > 1) {
      const oldKey = this.order.shift();
      if (this.segs.has(oldKey)) {
        const it = this.segs.get(oldKey);
        this.cacheBytes -= (it && it.buffer ? it.buffer.length : 0);
        if (oldKey !== key) this.segs.delete(oldKey);
      }
    }
  }

  evict(key) {
    const it = this.segs.get(key);
    if (it) this.cacheBytes -= (it.buffer ? it.buffer.length : 0);
    this.segs.delete(key);
    const i = this.order.indexOf(key);
    if (i >= 0) this.order.splice(i, 1);
  }

  // 把预取 URL 投入队列。后台预取允许与播放器「当前流式下载」并发（最多 1 路预取），
  // 这样下一片能在播放器消费当前片时提前备好，避免每片都等回源（实测高清片回源 4~5s，
  // 串行预取会永远落在播放后面、每片 miss 转圈圈）。
  // 去重以 streaming（在途下载）为准：若该分片正在被播放器流式回源，预取直接复用、不重复下载。
  _enqueuePrefetch(url) {
    if (!this._prefetchAllowed()) return;
    const key = segKey(url);
    if (this.segs.has(key) || this.streaming.has(key) || this.badKeys.has(key)) return;
    if (this._prefQueue.includes(url) || this._prefInFlight === url) return;
    this._prefQueue.push(url);
    // 队列保持精简：按自适应深度（大分片1片、小分片prefetchAhead片）保留最新待取，丢弃过旧的
    const depth = this._prefetchDepth();
    while (this._prefQueue.length > depth + 1) this._prefQueue.shift();
    this._drainPrefetchQueue();
  }

  // 单路后台预取：_prefRunning 作为「是否有预取在跑」的闸门，保证同一时刻最多 1 路预取回源，
  // 不会与播放器流形成多路 10MB 突发；而在途去重(streaming Map)保证同一片绝不重复下载。
  // v5.0.1 回退对齐 v4.1.2：只要本会话有最近观众就积极预取，不再按「全局同时观看会话数」门控。
  //   v4.1.3+ 曾加 prefetchMaxViewers(>1 路并发就关预取)，但日志(log28)显示在某些场景该计数
  //   会把唯一真实会话也误判为多路，导致 prefetched 永远为 0、每片冷启动转圈。v4.1.2 无此门控、
  //   单/多路都流畅，故移除。大分片自适应深度(4K 只预取1片)保留，避免 54MB 分片额外占带宽。
  _prefetchAllowed() {
    if (this.destroyed || !this.hasRecentViewer()) return false;
    return true;
  }
  _prefetchDepth() {
    // 以最近分片平均体积判断大小片：>20MB 视为 4K 大分片，只预取 1 片；否则用配置深度。
    const big = (this._avgSegBytes || 0) > 20 * 1024 * 1024;
    return big ? 1 : (config.prefetchAhead || 3);
  }
  async _drainPrefetchQueue() {
    if (this._prefRunning || !this._prefetchAllowed()) return;
    this._prefRunning = true;
    try {
      while (this._prefQueue.length) {
        const url = this._prefQueue.shift();
        const key = segKey(url);
        if (this.segs.has(key) || this.streaming.has(key) || this.badKeys.has(key)) continue;
        // 每取一片都重新评估：观众可能已切走
        if (!this._prefetchAllowed()) { this._prefQueue = []; break; }
        // 全局保护：内存过高（多为 4K 大分片堆积）时暂停预取，避免 OOM。
        // 闸门用可配置的 prefetchMemLimitMB（默认1100MB）。
        // v5.0.1：移除「播放器流占满并发槽位就退让」的判断——fetchSegment 已不再经过
        // DOWNLOAD_SCHED，activeCount 不再反映回源负载；该判断在单路场景会误饿预取。
        const memMB = process.memoryUsage().rss / 1024 / 1024;
        const memLimit = (config.prefetchMemLimitMB > 0 ? config.prefetchMemLimitMB : 1100);
        if (memMB > memLimit) {
          this._prefQueue.unshift(url); // 放回队首，稍后重试
          break;
        }
        this._prefInFlight = url;
        try {
          await this.fetchSegment(url, true);
        } catch {
          // 预取失败已在 fetchSegment 内统计；继续取下一个，不阻塞队列
        } finally {
          this._prefInFlight = null;
        }
      }
    } finally {
      this._prefRunning = false;
      this._prefInFlight = null;
    }
  }

  // 预热：从索引第 startFrom 片开始预取前 N 片（用于首载/刷新后补 buffer）
  warmPrefetch(startFrom) {
    if (!this._prefetchAllowed()) return; // 多路并发时不预取，把带宽让给实时流
    const list = this.lastSegs;
    if (!list.length) return;
    const n = this._prefetchDepth();
    for (let k = 0; k < n; k++) {
      const u = list[startFrom + k];
      if (!u) break;
      this._enqueuePrefetch(u);
    }
  }

  // 按需预拉取：定位当前分片在最新索引中的位置，续拉后 N 片（串行）
  prefetchAhead(currentUrl) {
    if (!this._prefetchAllowed()) return; // 切台/多路并发时停止预取，把带宽让给当前频道
    const curKey = segKey(currentUrl);
    const list = this.lastSegs;
    if (!list.length) return;
    let idx = -1;
    for (let i = list.length - 1; i >= 0; i--) {
      if (segKey(list[i]) === curKey) { idx = i; break; }
    }
    if (idx < 0) {
      // 当前片不在最新索引（可能是旧序号）：从索引开头预热
      this.warmPrefetch(0);
      return;
    }
    const n = this._prefetchDepth();
    for (let k = 1; k <= n; k++) {
      const u = list[idx + k];
      if (!u) break;
      this._enqueuePrefetch(u);
    }
  }

  // 统一的「在途下载」入口：按需流(streamSegmentToClient)与后台预取都走这里，
  // 用 streaming Map 按 key 去重，保证同一个分片全局只有一条回源连接，
  // 彻底修复 v4.1.1 首载时「流式回源」与「预取」各下一遍 10MB 分片、双倍争抢带宽导致 CCTV5 卡顿的问题。
  // prefetch=true 仅作为后台等待者（不向播放器推流），下载完成即缓存命中。
  fetchSegment(url, prefetch) {
    const key = segKey(url);
    const existing = this.streaming.get(key);
    // v5.0.1 关键修复（回退对齐 v4.1.2）：播放器请求命中一条在途下载（无论是预取还是实时流）
    // 时，一律复用同一条回源连接，由 streamSegmentToClient 的 catch-up 补发已缓冲数据。
    // 绝不能 abort 重启——v5.0 曾在这里对「纯预取在途」做优先级提权（destroy 上游再以高优先级
    // 重建），结果每个预取分片在播放器请求时被销毁、已下载的几 MB 全部丢弃，prefetched 永远
    // 为 0、每片都冷启动等 5~8s 回源，导致所有终端转圈卡顿（log28 铁证）。v4.1.2 无调度器、
    // 所有回源直接 fetchUpstream 同优先级，靠在途复用 + catch-up 即流畅（log27）。
    if (existing) return existing.promise;
    const t0 = Date.now();
    const inflight = {
      streamers: 0, chunks: [], bytes: 0, aborted: false, finished: false,
      clients: [], contentType: 'video/mp2t', startedAt: t0, slowClient: false,
      resolve: null, reject: null, promise: null, upstream: null,
    };
    inflight.promise = new Promise((resolve, reject) => {
      inflight.resolve = resolve;
      inflight.reject = reject;
    });
    this.streaming.set(key, inflight);

    // 对齐 v4.1.2：所有回源（播放器实时流 + 后台预取）直接 fetchUpstream，不经全局优先级
    // 调度器排队/抢占。调度器在单路/少量终端场景会让预取在 6 槽位逻辑中被反复抢占/中止，
    // 反而把预取饿死（prefetched=0）。同一会话内串行预取 + 在途去重已足够控制带宽突发。
    // 超时同样对齐 v4.1.2：targetDuration*1000（约 10s），有数据持续到达会自动重置。
    fetchUpstream(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (XTE-IPTV/4.1; +native-hls)' },
      timeoutMs: (this.targetDuration * 1000) || 12000,
    }).then(({ res: up, status, headers: h }) => {
      if (status < 200 || status >= 300) {
        up.resume();
        throw new Error('upstream status ' + status);
      }
      inflight.contentType = h['content-type'] || 'video/mp2t';
      inflight.upstream = up;
      inflight.startedAt = Date.now();
      let backpressureSince = 0;

      // 注意：v4.1.3 曾在这里对「持续背压 8s」的客户端强杀上游，实测会误杀正常按 HLS 节奏消费的播放器
      // （尤其 4K 大分片，播放器边下边解，write() 返回 false 是常态而非异常），导致分片被截断、
      // 播放器报「无法播放」。v4.1.4 改为：背压时仅暂停上游（内存与带宽都被约束在一个缓冲内），
      // 客户端断开由 streamSegmentToClient 的 res 'close' 中止上游，不再按时间强杀。

      const onDrain = () => {
        if (inflight.aborted) return;
        const backpressured = inflight.clients.some((c) => c.paused);
        if (!backpressured) {
          if (backpressureSince) {
            const waited = Date.now() - backpressureSince;
            if (waited >= 1000 && !inflight.slowClient) {
              inflight.slowClient = true;
              log('warn', '客户端接收缓慢（疑似弱网/解码跟不上），已背压暂停回源 session=' + this.id,
                { key: shortKey(key), waitedMs: waited, bytesBuffered: inflight.bytes,
                  channel: (this.chan && this.chan.name) || '', terminal: this.terminal,
                  globalKbps: DOWNLOAD_SCHED.kbps() });
            }
            backpressureSince = 0;
            try { up.resume(); } catch {}
          }
        }
      };

      up.on('data', (chunk) => {
        if (inflight.aborted) return;
        inflight.bytes += chunk.length;
        inflight.chunks.push(chunk);
        for (const c of inflight.clients) {
          try {
            if (!c.headerSent) {
              c.res.writeHead(200, {
                'Content-Type': inflight.contentType,
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'no-cache',
              });
              c.headerSent = true;
              c.firstByteMs = Date.now() - t0;
              log('info', '分片首包到达 session=' + this.id,
                { key: shortKey(key), ttfbMs: c.firstByteMs, shared: inflight.streamers > 1,
                  globalKbps: DOWNLOAD_SCHED.kbps() });
            }
            if (!c.res.write(chunk)) {
              c.paused = true;
              if (!backpressureSince) backpressureSince = Date.now();
              c.res.once('drain', () => { c.paused = false; onDrain(); });
            }
          } catch (e) {
            c.done = true;
          }
        }
        const anyPaused = inflight.clients.some((c) => c.paused);
        if (anyPaused) {
          // 背压即暂停上游：客户端能消费多少就回源多少，内存与出口带宽都被约束在一个缓冲内，
          // 不再把整段 60MB 大分片堆进内存。客户端断开会由 removeClient 中止上游。
          up.pause();
        }
      });

      up.on('end', () => {
        if (inflight.aborted) return;
        inflight.finished = true;
        const buffer = Buffer.concat(inflight.chunks);
        // EWMA 记录最近分片体积，用于自适应预取深度（>20MB 视为 4K 大分片，只预取1片）
        this._avgSegBytes = this._avgSegBytes ? this._avgSegBytes * 0.7 + inflight.bytes * 0.3 : inflight.bytes;
        this.put(key, url, buffer, inflight.contentType);
        const cost = Date.now() - t0;
        DOWNLOAD_SCHED.recordBytes(inflight.bytes, cost);
        for (const c of inflight.clients) {
          try { if (!c.headerSent) c.res.writeHead(200, { 'Content-Type': inflight.contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' }); c.res.end(); } catch {}
        }
        this.streaming.delete(key);
        if (prefetch) {
          this.stats.prefetched++;
          log('info', '预拉取成功 session=' + this.id,
            { key: shortKey(key), size: inflight.bytes, costMs: cost,
              rate: cost ? Math.round(inflight.bytes * 1000 / cost / 1024) + 'KB/s' : '-',
              globalKbps: DOWNLOAD_SCHED.kbps() });
        } else {
          this.consecutiveFail = 0;
          log('info', '分片流式回源完成 session=' + this.id,
            { channel: (this.chan && this.chan.name) || '', key: shortKey(key),
              size: inflight.bytes, costMs: cost,
              rate: cost ? Math.round(inflight.bytes * 1000 / cost / 1024) + 'KB/s' : '-',
              shared: inflight.streamers, slowClient: inflight.slowClient,
              buffered: this.segs.size, hit: this.stats.hit, miss: this.stats.miss,
              activeDl: DOWNLOAD_SCHED.activeCount(), queuedDl: DOWNLOAD_SCHED.queued(),
              globalKbps: DOWNLOAD_SCHED.kbps(),
              memMB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
        }
        inflight.resolve(buffer);
      });

      up.on('error', (e) => {
        if (inflight.finished) return;
        inflight.aborted = true;
        this.streaming.delete(key);
        inflight.reject(e);
      });
    }).catch((e) => {
      const cost = Date.now() - t0;
      // 关键：只销毁「已经开始流式发送（响应头已发）」的客户端连接。
      // 对于尚未发头的客户端（如 serveSegment 还在等首包、准备走重试/204兜底），
      // 不能销毁它的 res，否则调用方后续 writeHead(204) 会抛 ECONNRESET/socket hang up。
      const pending = [];
      for (const c of inflight.clients) {
        if (c.headerSent) { try { c.res.destroy(); } catch {} }
        else pending.push(c);
      }
      inflight.clients = pending;
      this.streaming.delete(key);
      const preempted = prefetch && /preempt/i.test(e.message || '');
      if (prefetch) {
        if (!preempted) {
          this.stats.prefetchFail++;
          log('warn', '预拉取失败 session=' + this.id,
            { key: shortKey(key), type: classifyError(e), error: e.message, costMs: cost });
        }
        // 预取被抢占属正常调度（为播放器实时流让路），不计失败、不打日志；
        // 它不向任何播放器推流，直接 reject 即可。
      } else {
        this.stats.fail++;
        this.consecutiveFail++;
        this.lastErrAt = Date.now();
        this.lastErrMsg = e.message;
        log('error', '分片回源失败 session=' + this.id,
          { key: shortKey(key), type: classifyError(e), error: e.message, costMs: cost, fails: this.consecutiveFail });
      }
      inflight.reject(e);
    });

    return inflight.promise;
  }

  // 按需流式回源单个分片给播放器：加入在途下载的广播列表（多客户端共享同一条回源流），
  // 收到上游数据立即写出（低 TTFB），边收边缓存。播放器提前断开则移除该消费者，
  // 仅当没有其它播放器消费者时才中止上游（预取等待者不持有连接，不影响中止决策）。
  //
  // 关键：若该分片已在下载中（常见于首载 warmPrefetch 已先发起、播放器随后请求同片），
  // 新客户端必须先补发「挂载前已缓冲的全部数据」，再续接后续数据，否则会得到截断分片而播放失败。
  streamSegmentToClient(targetUrl, res) {
    const key = segKey(targetUrl);
    // 启动或复用在途下载：fetchSegment 内部按 key 去重，返回同一个 Promise。
    const promise = this.fetchSegment(targetUrl, false);
    const inflight = this.streaming.get(key);
    if (!inflight) {
      // 理论上不会发生（fetchSegment 同步登记 inflight）；兜底为纯等待
      return promise.then(() => {});
    }

    const client = { res, headerSent: false, paused: false, done: false, firstByteMs: 0 };
    inflight.streamers++;
    // 先登记到广播列表，确保上游 'data' 循环的背压判断包含本客户端；
    // 当前是同步代码、data 事件不会在补发过程中插入，因此无重复发送风险。
    inflight.clients.push(client);

    // 同步补发挂载前已到达的数据块（catch-up）：
    // 常见于首载 warmPrefetch 已先发起、播放器随后请求同片的情况。若不补发，
    // 新客户端只会收到挂载之后的字节，得到截断分片而播放失败。
    const sendHeaderForClient = () => {
      if (client.headerSent) return;
      client.headerSent = true;
      res.writeHead(200, {
        'Content-Type': inflight.contentType || 'video/mp2t',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-cache',
      });
      client.firstByteMs = Date.now() - inflight.startedAt;
      const catchupBytes = inflight.chunks.reduce((n, c) => n + c.length, 0);
      log('info', '分片首包到达 session=' + this.id,
        { key: shortKey(key), ttfbMs: client.firstByteMs,
          catchupBytes, shared: inflight.clients.length > 1 });
    };
    if (inflight.chunks.length > 0) {
      sendHeaderForClient();
      for (const c of inflight.chunks) {
        if (client.done) break;
        if (!res.write(c)) {
          client.paused = true;
          res.once('drain', () => {
            client.paused = false;
            // 补发期间的 drain 也要尝试恢复上游（上游可能因本客户端背压而暂停）
            if (inflight.upstream && !inflight.clients.some((x) => x.paused)) {
              try { inflight.upstream.resume(); } catch {}
            }
          });
        }
      }
    }

    // 注册断开处理：必须在 await 之前挂上，避免漏监听
    const removeClient = () => {
      if (client.done) return;
      client.done = true;
      const idx = inflight.clients.indexOf(client);
      if (idx >= 0) inflight.clients.splice(idx, 1);
      inflight.streamers = Math.max(0, inflight.streamers - 1);
      // 没有其它播放器在看了：立即中止上游，避免切台后继续白下整片（省带宽/防限流）
      if (inflight.streamers === 0 && inflight.upstream && !inflight.finished) {
        inflight.aborted = true;
        try { inflight.upstream.destroy(); } catch {}
        this.streaming.delete(key);
      }
    };
    res.on('close', removeClient);

    return new Promise((resolve, reject) => {
      promise.then(() => {
        if (!client.done) {
          client.done = true;
          resolve({ bytes: inflight.bytes, firstByteMs: client.firstByteMs });
        }
      }).catch((e) => {
        removeClient();
        reject(e);
      });
    });
  }

  // 分片失败重试：2 次重试(间隔500ms) + 刷新索引 + 1 次重试
  async fetchSegmentWithRetry(url) {
    const key = segKey(url);
    let lastErr;
    for (let attempt = 0; attempt <= config.segRetry; attempt++) {
      try {
        return await this.fetchSegment(url, false);
      } catch (e) {
        lastErr = e;
        log('warn', '分片失败 session=' + this.id + ' attempt=' + (attempt + 1),
          { key: shortKey(key), type: classifyError(e), error: e.message });
        if (attempt < config.segRetry) await sleep(config.segRetryIntervalMs);
      }
    }
    // 刷新最新索引后再试一次
    try {
      await this.refresh();
      const fresh = this.lastSegs.find((u) => segKey(u) === key);
      if (fresh && fresh !== url) {
        log('info', '索引更新后重试分片 session=' + this.id, { key: shortKey(key) });
        return await this.fetchSegment(fresh, false);
      }
    } catch (e) {
      log('error', '重试前刷新索引失败 session=' + this.id, { error: e.message });
    }
    throw lastErr || new Error('segment fetch failed');
  }

  // 连续失败自适应：不清缓存、不切模式，仅记录并退避，避免在源站抖动时持续打爆回源。
  // 后续成功会自动把 consecutiveFail 归零。
  noteFailure() {
    this.consecutiveFail++;
    if (this.consecutiveFail >= 3) {
      log('warn', '分片连续失败，短暂退避后继续重试 session=' + this.id,
        { consecutiveFail: this.consecutiveFail, channel: this.chan.name || '' });
    }
  }
  noteSuccess() { this.consecutiveFail = 0; }

  destroy({ closeClients = false } = {}) {
    this.destroyed = true;
    this.segs.clear();
    this.order = [];
    this.cacheBytes = 0;
    for (const inf of this.streaming.values()) {
      try { inf.upstream && inf.upstream.destroy(); } catch {}
      if (closeClients) {
        // stalled 自动恢复：主动断开挂死的播放器连接，触发播放器重连重建会话
        for (const c of inf.clients || []) {
          try { c.res && c.res.destroy(); } catch {}
        }
      }
    }
    this.streaming.clear();
    this._prefQueue = [];
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function shortKey(k) { return k.length > 48 ? '…' + k.slice(-46) : k; }

// 分片稳定标识：用 pathname（去掉查询串中的动态 token/时间戳/签名），
// 让带时效参数的同一分片在不同请求间能命中缓存。path 为空时回退到完整 URL。
function segKey(url) {
  try {
    const u = new URL(url, 'http://x');
    return u.pathname || url;
  } catch {
    return url;
  }
}

// 把 IPv4-mapped IPv6 地址（双栈监听下 ::ffff:1.2.3.4）还原成 IPv4，
// 否则会被误判成 IPv6 线路、且 IP 显示带 ::ffff: 前缀。
function normalizeIp(ip) {
  if (!ip) return '';
  let s = String(ip).trim();
  if (s.startsWith('::ffff:')) s = s.slice(7);
  // 去掉 IPv6 字面量方括号
  s = s.replace(/^\[|\]$/g, '');
  return s;
}

// 判断是否为真实 IPv6 地址（排除 IPv4 与 IPv4-mapped）
function isIPv6(ip) {
  const s = normalizeIp(ip);
  return s.includes(':') && !/^\d+\.\d+\.\d+\.\d+$/.test(s);
}

// 是否为内网/本机地址（用于 XFF 真实客户端判定）
function isPrivateIp(ip) {
  const s = normalizeIp(ip);
  if (s === '127.0.0.1' || s === '::1' || s === 'localhost') return true;
  if (/^10\./.test(s)) return true;
  if (/^192\.168\./.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(s)) return true;
  if (/^169\.254\./.test(s)) return true;          // link-local
  if (/^fe80:/i.test(s)) return true;              // IPv6 link-local
  if (/^f[cdf][0-9a-f]{2}:/i.test(s)) return true; // IPv6 ULA
  if (/^::ffff:(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(s)) return true;
  return false;
}

// 频道台标：优先用源自带 logo；否则按频道名拼 Gitee 台标库（用户提供的 SXYD.m3u 使用同一套命名）。
// 中文/特殊字符做 URL 编码，空格等统一处理。返回空串表示无台标，前端用占位。
function logoForChannel(chan) {
  if (!chan) return '';
  if (chan.logo) return chan.logo;
  const name = (chan.name || chan.tvgName || '').trim();
  if (!name) return '';
  return 'https://gitee.com/sxlgys/logo/raw/master/' + encodeURIComponent(name) + '.png';
}

// 客户端 IP 归属地：无离线 IP 库时做网络位置归类（内网/本机/公网），避免显示空白。
// 不做外部网络查询，避免把观众 IP 发给第三方；后续可在 DATA_DIR 放离线库扩展。
function ipLocation(ip) {
  if (!ip) return '';
  const s = normalizeIp(ip);
  if (s === '127.0.0.1' || s === '::1') return '本机';
  const m = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 10) return '内网';
    if (a === 172 && b >= 16 && b <= 31) return '内网';
    if (a === 192 && b === 168) return '内网';
    if (a === 169 && b === 254) return '内网(链路本地)';
    return '外网';
  }
  if (s.startsWith('fe80:')) return '内网(IPv6链路本地)';
  if (s.includes(':')) return '外网(IPv6)';
  return '外网';
}

// 客户端真实 IP（规范化）
function clientIp(req) {
  // 反向代理 / FRP / fnOS 网关会在本机回连到服务，真实客户端 IP 需从转发头取。
  // X-Forwarded-For 可能是 "client, proxy1, proxy2"，取第一个非内网的公网/真实地址。
  const raw = [];
  const xff = req.headers['x-forwarded-for'];
  if (xff) raw.push(...xff.toString().split(','));
  const xr = req.headers['x-real-ip'];
  if (xr) raw.push(xr.toString());
  const norm = raw.map(v => normalizeIp(v)).filter(Boolean);
  // 1) 优先返回转发头里的公网 IP（FRP/反代透传的真实外网客户端）
  for (const ip of norm) {
    if (ip === '127.0.0.1' || ip === '::1') continue;
    if (isPrivateIp(ip)) continue;
    return ip;
  }
  // 2) 其次返回转发头里的内网 IP（本机 fnOS 网关/FRP 回连时，socket 是 127.0.0.1，
  //    真实客户端其实在 X-Forwarded-For 里，比如 192.168.31.1）
  for (const ip of norm) {
    if (ip !== '127.0.0.1' && ip !== '::1') return ip;
  }
  // 3) 最后才用 TCP 对端地址（直连场景）
  return normalizeIp(req.socket?.remoteAddress || '');
}

// 终端类型识别（细分：内置播放器 / TV / 手机(安卓/鸿蒙/iOS) / 浏览器(Win/Mac/Linux) / 播放器内核）
function detectTerminal(req) {
  const ua = (req && req.headers && req.headers['user-agent'] || '').toString();
  if (!ua) return '未知';
  const lc = ua.toLowerCase();
  // 1) 独立播放器内核
  if (/vlc|libvlc|mpv|ffplay|ffmpeg|iina|potplayer|infuse|kodi|gses|nplayer|mxplayer|Dalvik/i.test(ua)) return '独立播放器';
  // 2) TV / 盒子 / 大屏（Android TV、鸿蒙 TV、Apple TV、WebOS 等）。
  //    注意：飞牛手机 APP 的 UA 可能也含 Android，必须先于「手机飞牛APP」之外的安卓判断；
  //    用 TV 专属标记（AndroidTV/BRAVIA/NetRange/HbbTV 等）与缺失手机特征来识别。
  if (/smart-?tv|appletv|crkey|googletv|android ?tv|bravia|nettv|netrange|hbbtv|web0s|netcast|vidaa|hisense|skyworth|mitv|letv|harmonyos.*tv|; ?tv\b/i.test(ua) ||
      (/android/i.test(ua) && !/mobile|mobi/i.test(ua) && /tv|set-?top|box|大屏/i.test(ua))) {
    return 'TV端';
  }
  // 3) 飞牛 fnOS 客户端。桌面端为 Electron（PC客户端内置浏览器），手机端为飞牛 APP/飞牛影视 WebView。
  const isFn = /fnos|feiniu|飞牛|fnclient|trimui|trim-?ui|fnplayer/i.test(ua);
  if (isFn || /electron/i.test(ua)) {
    if (/android|harmonyos|openharmony|mobile|mobi|iphone|ipad|ipod/i.test(ua)) return '手机飞牛APP(飞牛影视)';
    return 'PC客户端内置浏览器';
  }
  // 4) 手机/平板系统浏览器或普通 APP
  if (/iphone|ipod/i.test(ua)) return 'iOS手机';
  if (/ipad/i.test(ua) || (/macintosh/i.test(ua) && /mobile\/\w+/i.test(ua))) return 'iPad';
  if (/harmonyos|openharmony|arkweb/i.test(ua)) return /mobile|mobi|phone/i.test(ua) ? '鸿蒙手机' : '鸿蒙平板';
  if (/android/i.test(ua)) {
    // 安卓但没有 TV 特征：按是否含 Mobile 区分手机/平板；移动版飞牛 APP 若未带 fnos 关键字，也归为手机APP
    if (/mobile|mobi/i.test(ua)) return '安卓手机';
    return '安卓平板';
  }
  // 5) 桌面浏览器
  if (/windows/i.test(ua)) return 'Windows浏览器';
  if (/macintosh|mac os x/i.test(ua)) return 'Mac浏览器';
  if (/linux/i.test(ua)) return 'Linux浏览器';
  // 6) HTTP 客户端
  if (/okhttp|dalvik|dart|go-http|python-requests|curl|wget|axios|node-fetch/i.test(ua)) return 'HTTP客户端';
  void lc;
  return '其他';
}

// 线路识别：以播放列表路径（/m3u/inner|ipv6|frp）为权威来源；
// 兜底时用 Host 与客户端 IP 判断。注意必须用 normalizeIp 排除 ::ffff: 误判。
function detectLine(req, ip) {
  // 优先：由调用方从路由 /m3u/{kind} 或 ?line= 查询参数传入（权威）
  if (req && req._xteLine) return req._xteLine;
  if (req) {
    try {
      const u = new URL(req.url, 'http://x');
      const ql = u.searchParams.get('line');
      if (ql && /^(inner|ipv6|frp)$/i.test(ql)) return ql.toUpperCase();
    } catch (_) {}
  }
  const host = (req.headers.host || '').toString().toLowerCase();
  if (host.includes('frp') || host.includes('proxy') || host.includes('nat')) return 'FRP';
  const h = host.split(':')[0].replace(/^\[|\]$/g, '');
  if (h.includes(':')) return 'IPv6';
  // 客户端真实 IP 是 IPv6 才算 IPv6 链路；IPv4-mapped 已被 normalizeIp 还原，不会误判
  if (ip && isIPv6(ip)) return 'IPv6';
  return '内网';
}

const sessions = new Map(); // channelUrl -> SegmentSession

function getOrCreateSession(channelUrl, chan) {
  let s = sessions.get(channelUrl);
  if (!s) {
    s = new SegmentSession(channelUrl, chan);
    sessions.set(channelUrl, s);
    log('info', '会话创建 session=' + s.id, { channel: (chan && chan.name) || '' });
  }
  return s;
}

// 当前正在被真实观众观看的会话数（20s 窗口内有 m3u8/分片请求）。
// 用于多路并发时关闭后台预取，把出口带宽全部让给实时流（见 prefetchMaxViewers）。
function countActiveViewers() {
  const now = Date.now();
  const win = config.activeWindowMs || 20000;
  let n = 0;
  for (const s of sessions.values()) {
    if (!s.destroyed && (now - s.lastClientAt) < win) n++;
  }
  return n;
}

// 会话回收：以「真实观众活动」(lastClientAt) 为准，而非 activeAt（后者会被后台
// refresh/prefetch 自身刷新，导致切台后僵尸会话长期驻留、抢占带宽）。
function reapSessions() {
  const now = Date.now();
  const win = config.activeWindowMs || 20000;
  // stalled 自动恢复：有连接挂着(active>0)但长时间没有任何分片送达（播放器已卡死/
  // 弱网读不动、TCP 却未断开），普通回收因 active>0 永远不会触发，会让这种「假活」
  // 会话死占内存与缓冲数十分钟。超过阈值即强制销毁并断开挂死的客户端连接，
  // 触发播放器重连重建会话。阈值取 60s（≈6 个分片时长），正常播放不会命中。
  const stalledLimit = (config.stalledRecoverMs > 0 ? config.stalledRecoverMs : 60000);
  for (const [url, s] of sessions) {
    const idleMs = now - s.lastClientAt;
    if (idleMs > win && s.active <= 0) {
      log('info', '会话回收（观众已离开） session=' + s.id,
        { idleMs, active: s.active, buffered: s.segs.size });
      s.destroy();
      sessions.delete(url);
      continue;
    }
    if (s.active > 0 && s.lastSegServedAt && s.targetDuration > 0) {
      const noSegMs = now - s.lastSegServedAt;
      if (noSegMs > stalledLimit) {
        log('warn', '会话长期 stalled，自动断开以触发播放器重连 session=' + s.id,
          { channel: (s.chan && s.chan.name) || '', noSegMs, active: s.active,
            buffered: s.segs.size, terminal: s.terminal, ip: s.clientIp,
            memMB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
        s.destroy({ closeClients: true });
        sessions.delete(url);
      }
    }
  }
}
setInterval(reapSessions, 8000).unref?.();

// 活跃直播会话后台保活：周期性刷新索引，让播放器拿到最新清单。
// v4.1.1：refresh 内部已有节流（refreshMinIntervalMs），保活只负责维持索引新鲜，
// 不再主动预取——分片由「播放器请求命中后 prefetchAhead」和「首载 warmPrefetch」驱动，
// 避免空闲时无意义地持续回源下载大分片导致被 CDN 限流。
function keepAliveTick() {
  for (const s of sessions.values()) {
    if (s.destroyed) continue;
    // 只对「最近还有观众在看」的会话刷新索引（20s 窗口）。切台后无人观看的频道
    // 立即停止后台回源，把出口带宽让给当前频道，避免多频道并发下载大分片互相抢速、
    // 也降低被源站 CDN 限流的概率。
    if (!s.hasRecentViewer()) continue;
    s.refresh().catch(() => {});
  }
}
setInterval(keepAliveTick, config.keepAliveIntervalMs || 4000).unref?.();

// 每 30s 输出一次播放状态汇总：逐频道列出缓冲/命中/失败，以及内存占用。
// 用于长时播放时从日志判断是回源慢、被限流，还是内存/缓冲异常。
setInterval(() => {
  if (!sessions.size) return;
  const mem = process.memoryUsage();
  const rows = [];
  let totBuf = 0, totHit = 0, totMiss = 0, totPre = 0, totFail = 0;
  const now = Date.now();
  let shown = 0;
  for (const s of sessions.values()) {
    if (s.destroyed) continue;
    const buf = s.segs.size;
    const state = s.playState();
    const sinceClient = Math.round((now - s.lastClientAt) / 1000);
    // 汇总只展示「正在播放/疑似卡顿/出错」或最近有观众的会话，纯后台僵尸会话不刷屏
    const visible = s.active > 0 || sinceClient <= 120 || state === 'error';
    if (!visible) continue;
    shown++;
    totBuf += buf; totHit += s.stats.hit; totMiss += s.stats.miss;
    totPre += s.stats.prefetched; totFail += s.stats.fail;
    rows.push({
      channel: (s.chan && s.chan.name) || '',
      sid: s.id,
      state,
      line: s.line || '',
      ip: s.clientIp || '',
      loc: ipLocation(s.clientIp),
      terminal: s.terminal,
      active: s.active,
      sinceClientSec: sinceClient,
      buffered: buf,
      seq: s.mediaSeq,
      hit: s.stats.hit, miss: s.stats.miss, pre: s.stats.prefetched,
      fail: s.stats.fail, bad: s.badKeys.size,
      refreshFails: s.refreshFails || 0,
      lastErr: s.lastErrAt ? (s.lastErrMsg + '(' + Math.round((now - s.lastErrAt) / 1000) + 's前)') : '',
    });
  }
  if (!shown) return;
  log('info', '播放状态汇总 activeSessions=' + shown + '/' + sessions.size,
    { memRSS_MB: Math.round(mem.rss / 1024 / 1024), memHeap_MB: Math.round(mem.heapUsed / 1024 / 1024),
      buffered: totBuf, hit: totHit, miss: totMiss, prefetched: totPre, fail: totFail,
      dlActive: DOWNLOAD_SCHED.activeCount(), dlQueued: DOWNLOAD_SCHED.queued(),
      globalKbps: DOWNLOAD_SCHED.kbps(),
      channels: rows });
}, 30000).unref?.();

// ---------------------------------------------------------------------------
// 源管理：加载 M3U（远程 URL 或本地文件），解析频道
// ---------------------------------------------------------------------------
async function refreshSource(src) {
  const startedAt = Date.now();
  try {
    let text;
    if (src.type === 'local') {
      text = fs.readFileSync(src.url, 'utf8');
    } else {
      const buf = await fetchText(src.url, {
        'User-Agent': 'Mozilla/5.0 (XTE-IPTV/4.0)',
      });
      text = buf.toString('utf8');
    }
    const segs = parseM3U(text);
    const newChannels = segs.map((seg, i) => ({
      id: crypto.createHash('sha1')
        .update(src.id + '|' + seg.url + '|' + i).digest('hex').slice(0, 16),
      sourceId: src.id,
      name: (seg.attrs.tvgName || seg.attrs.title || '频道' + (i + 1)).trim(),
      tvgId: seg.attrs.tvgId || '',
      tvgName: seg.attrs.tvgName || seg.attrs.title || '',
      logo: seg.attrs.logo || '',
      group: seg.attrs.group || '',
      url: seg.url.trim(),
      enabled: true,
    }));

    // 合并：保留用户对同 URL 频道的编辑（名称/台标/分组/启用状态等）
    const byUrl = new Map();
    for (const c of channels) byUrl.set(c.url, c);
    const merged = newChannels.map((nc) => {
      const old = byUrl.get(nc.url);
      if (old) {
        return Object.assign({}, nc, {
          id: old.id,
          name: old.name || nc.name,
          tvgId: old.tvgId || nc.tvgId,
          tvgName: old.tvgName || nc.tvgName,
          logo: old.logo || nc.logo,
          group: old.group || nc.group,
          enabled: old.enabled !== false,
        });
      }
      return nc;
    });

    // 替换属于该 source 的频道，追加其它 source 的
    channels = channels.filter((c) => c.sourceId !== src.id).concat(merged);
    // 去重（同 URL 保留一个）
    const seen = new Set();
    channels = channels.filter((c) => {
      if (seen.has(c.url)) return false;
      seen.add(c.url); return true;
    });

    src.lastRefreshAt = Date.now();
    src.channelCount = newChannels.length;
    src.error = '';
    persistSources();
    persistChannels();
    log('info', '源刷新完成 ' + src.name,
      { count: newChannels.length, costMs: Date.now() - startedAt });
    return { count: newChannels.length };
  } catch (e) {
    src.error = e.message;
    src.lastRefreshAt = Date.now();
    persistSources();
    log('error', '源刷新失败 ' + src.name, { type: classifyError(e), error: e.message });
    throw e;
  }
}

async function refreshAllSources() {
  const enabled = sources.filter((s) => s.enabled !== false);
  for (const s of enabled) {
    try { await refreshSource(s); } catch {}
  }
}

// 自动刷新定时器
let refreshTimer = null;
function scheduleAutoRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const min = config.refreshIntervalMin || 0;
  if (min > 0) {
    refreshTimer = setInterval(() => { refreshAllSources().catch(() => {}); }, min * 60 * 1000);
    refreshTimer.unref?.();
  }
}
scheduleAutoRefresh();


// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// 管理 API
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function sendText(res, code, contentType, text, extraHeaders) {
  res.writeHead(code, Object.assign({
    'Content-Type': contentType,
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  }, extraHeaders || {}));
  res.end(text);
}

function urlParse(reqUrl) {
  const u = new URL(reqUrl, 'http://localhost');
  const query = {};
  for (const [k, v] of u.searchParams) query[k] = v;
  return { pathname: u.pathname, query };
}

async function handleApi(req, res, parsed) {
  const p = parsed.pathname;
  const method = req.method;

  // 概览仪表盘
  if (p === '/api/status' && method === 'GET') {
    return sendJson(res, 200, {
      version: APP_VERSION,
      mode: 'smart',
      channelCount: channels.length,
      sourceCount: sources.length,
      sessionCount: sessions.size,
      uptimeSec: Math.round(process.uptime()),
      memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      downloads: {
        active: DOWNLOAD_SCHED.activeCount(),
        queued: DOWNLOAD_SCHED.queued(),
        maxConcurrent: DOWNLOAD_SCHED.maxConcurrent,
        globalKbps: DOWNLOAD_SCHED.kbps(),
      },
    });
  }

  // 会话列表
  if (p === '/api/sessions' && method === 'GET') {
    const now = Date.now();
    const list = [...sessions.values()].map((s) => ({
      id: s.id,
      channel: s.chan.name || '',
      logo: logoForChannel(s.chan),
      group: s.chan.group || '',
      mode: 'smart',
      active: s.active,
      state: s.playState(),
      idleSec: Math.round((now - s.lastClientAt) / 1000),
      sinceClientSec: Math.round((now - s.lastClientAt) / 1000),
      cached: s.segs.size,
      cacheMB: Math.round((s.cacheBytes || 0) / 1024 / 1024),
      bad: s.badKeys.size,
      hit: s.stats.hit,
      miss: s.stats.miss,
      prefetched: s.stats.prefetched,
      fail: s.stats.fail,
      seq: s.mediaSeq,
      lastError: s.lastErrAt ? { msg: s.lastErrMsg, ageSec: Math.round((now - s.lastErrAt) / 1000) } : null,
      clientIp: s.clientIp,
      clientLocation: ipLocation(s.clientIp),
      terminal: s.terminal,
      line: s.line,
      ua: s.userAgent,
    }));
    // 只把「仍有活跃连接」或「最近有观众活动(活动窗口内)」的会话展示在连接明细里。
    // 切台后无观众的会话最多再显示 activeWindowMs 秒即消失，不再堆积多个旧频道。
    const winSec = Math.round((config.activeWindowMs || 20000) / 1000);
    const visible = list.filter((x) => x.active > 0 || x.sinceClientSec <= winSec);
    return sendJson(res, 200, visible);
  }

  // 多线路播放地址（管理页卡片使用）
  if (p === '/api/playurls' && method === 'GET') {
    const bases = getLineBases();
    const enabled = channels.filter((c) => c.enabled !== false).length;
    return sendJson(res, 200, {
      inner: bases.inner ? { enabled: true, url: bases.inner + '/m3u/inner.m3u8' } : { enabled: false, url: '' },
      ipv6: bases.ipv6 ? { enabled: true, url: bases.ipv6 + '/m3u/ipv6.m3u8' } : { enabled: false, url: '' },
      frp: bases.frp ? { enabled: true, url: bases.frp + '/m3u/frp.m3u8' } : { enabled: false, url: '' },
      all: config.mergeLines ? { enabled: true, url: (bases.inner || bases.ipv6 || bases.frp || '') + '/m3u/all.m3u8' } : { enabled: false, url: '' },
      channelCount: enabled,
    });
  }

  // 配置
  if (p === '/api/config' && method === 'GET') return sendJson(res, 200, config);
  if (p === '/api/config' && method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const allowed = ['cacheWindow', 'prefetchAhead', 'sessionTtlMs',
      'segmentTtlMs', 'segRetry', 'segRetryIntervalMs',
      'refreshIntervalMin', 'logBufferSize'];
    for (const k of allowed) {
      if (body[k] !== undefined) config[k] = body[k];
    }
    if (body.lineInner) config.lineInner = normalizeLine(body.lineInner, { allowEmptyHost: true });
    if (body.lineIpv6) config.lineIpv6 = normalizeLine(body.lineIpv6);
    if (body.lineFrp) config.lineFrp = normalizeLine(body.lineFrp, { optionalPort: true });
    if (body.mergeLines !== undefined) config.mergeLines = body.mergeLines === true;
    persistConfig();
    scheduleAutoRefresh();
    log('info', '配置更新', { mergeLines: config.mergeLines });
    return sendJson(res, 200, config);
  }

  // 源 CRUD
  if (p === '/api/sources' && method === 'GET') return sendJson(res, 200, sources);
  if (p === '/api/sources' && method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (!body.name) return sendJson(res, 400, { error: 'name required' });
    // 三种来源：remote(远程URL) / local(服务器本地路径) / text(粘贴或上传的 M3U 文本)
    const origin = ['url', 'upload', 'text'].includes(body.origin) ? body.origin : 'url';
    let srcType = body.type === 'local' ? 'local' : 'remote';
    let srcUrl = (body.url || '').trim();
    let content = '';
    if (origin === 'upload' || origin === 'text') {
      content = (body.content || '').toString();
      if (!content || !/^#EXTM3U/i.test(content.trim())) {
        return sendJson(res, 400, { error: 'M3U 内容无效（需以 #EXTM3U 开头）' });
      }
      srcType = 'local'; // 落盘后按本地文件读取，刷新无需重新上传
    } else if (!srcUrl) {
      return sendJson(res, 400, { error: 'url required' });
    }
    const id = crypto.createHash('sha1')
      .update((srcUrl || content) + Date.now()).digest('hex').slice(0, 12);
    if (origin === 'upload' || origin === 'text') {
      const uploadDir = path.join(DATA_DIR, 'sources');
      fs.mkdirSync(uploadDir, { recursive: true });
      srcUrl = path.join(uploadDir, 'src_' + id + '.m3u');
      fs.writeFileSync(srcUrl, content, 'utf8');
    }
    const src = {
      id,
      name: body.name,
      url: srcUrl,
      type: srcType,
      origin,
      enabled: body.enabled !== false,
      autoRefresh: origin === 'url' ? body.autoRefresh !== false : false,
      createdAt: Date.now(),
      lastRefreshAt: 0,
      channelCount: 0,
      error: '',
    };
    sources.push(src);
    persistSources();
    try {
      await refreshSource(src);
    } catch {}
    return sendJson(res, 200, src);
  }
  if (p === '/api/sources/refresh' && method === 'POST') {
    const body = JSON.parse((await readBody(req)).catch(() => '{}') || '{}');
    if (body.id) {
      const src = sources.find((s) => s.id === body.id);
      if (!src) return sendJson(res, 404, { error: 'source not found' });
      try { await refreshSource(src); return sendJson(res, 200, src); }
      catch (e) { return sendJson(res, 502, { error: e.message }); }
    }
    await refreshAllSources();
    return sendJson(res, 200, { ok: true });
  }
  let sm = p.match(/^\/api\/sources\/([^/]+)$/);
  if (sm && method === 'DELETE') {
    const id = sm[1];
    const src = sources.find((s) => s.id === id);
    channels = channels.filter((c) => c.sourceId !== id);
    sources = sources.filter((s) => s.id !== id);
    persistSources(); persistChannels();
    // 删除上传/粘贴落盘的 m3u 备份文件
    if (src && (src.origin === 'upload' || src.origin === 'text')) {
      try { if (src.url && fs.existsSync(src.url)) fs.unlinkSync(src.url); } catch {}
    }
    return sendJson(res, 200, { ok: true });
  }
  if (sm && method === 'PATCH') {
    const id = sm[1];
    const src = sources.find((s) => s.id === id);
    if (!src) return sendJson(res, 404, { error: 'not found' });
    const body = JSON.parse(await readBody(req));
    for (const k of ['name', 'url', 'enabled', 'autoRefresh', 'type']) {
      if (body[k] !== undefined) src[k] = body[k];
    }
    persistSources();
    return sendJson(res, 200, src);
  }

  // 频道
  if (p === '/api/channels' && method === 'GET') {
    const page = parseInt(parsed.query.page || '1', 10);
    const size = parseInt(parsed.query.size || '2000', 10);
    const q = (parsed.query.q || '').toLowerCase();
    let list = channels;
    if (q) list = list.filter((c) =>
      (c.name || '').toLowerCase().includes(q) ||
      (c.group || '').toLowerCase().includes(q));
    const total = list.length;
    const start = (page - 1) * size;
    return sendJson(res, 200, { total, page, size, items: list.slice(start, start + size) });
  }
  // 批量操作：{ ids?: string[], all?: boolean, q?: string, action: 'enable'|'disable'|'delete'|'group', group?: string }
  if (p === '/api/channels/batch' && method === 'POST') {
    const body = JSON.parse(await readBody(req));
    let targets = channels;
    if (!body.all) {
      const idSet = new Set(Array.isArray(body.ids) ? body.ids : []);
      targets = channels.filter((c) => idSet.has(c.id));
    } else if (body.q) {
      const q = String(body.q).toLowerCase();
      targets = channels.filter((c) =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.group || '').toLowerCase().includes(q));
    }
    const count = targets.length;
    if (body.action === 'enable') {
      targets.forEach((c) => { c.enabled = true; });
    } else if (body.action === 'disable') {
      targets.forEach((c) => { c.enabled = false; });
    } else if (body.action === 'group') {
      const g = typeof body.group === 'string' ? body.group.trim() : '';
      targets.forEach((c) => { c.group = g; });
    } else if (body.action === 'delete') {
      const delIds = new Set(targets.map((c) => c.id));
      for (let i = channels.length - 1; i >= 0; i--) {
        if (delIds.has(channels[i].id)) channels.splice(i, 1);
      }
    } else {
      return sendJson(res, 400, { error: 'unknown action' });
    }
    persistChannels();
    log('info', `频道批量操作 action=${body.action} affected=${count} all=${!!body.all}`);
    return sendJson(res, 200, { affected: count, total: channels.length });
  }

  // 频道导出：GET /api/channels/export
  //   scope=all(默认全部) | selected(按 ids，逗号分隔) | search(按 q)
  //   includeDisabled=1 时包含已禁用频道
  //   line=inner(默认)|ipv6|frp|all  决定分片走哪条线路的 XTE 代理地址（播放器可直接播放）
  //   raw=1 时导出频道原始流地址（备份/迁移用，不经过 XTE）
  if (p === '/api/channels/export' && method === 'GET') {
    const scope = parsed.query.scope || 'all';
    const includeDisabled = parsed.query.includeDisabled === '1';
    const line = ['inner', 'ipv6', 'frp', 'all'].includes(parsed.query.line) ? parsed.query.line : 'inner';
    const raw = parsed.query.raw === '1';
    let list = channels.slice();
    if (scope === 'selected' && parsed.query.ids) {
      const idSet = new Set(String(parsed.query.ids).split(',').map(s => s.trim()).filter(Boolean));
      list = list.filter(c => idSet.has(c.id));
    } else if (scope === 'search' && parsed.query.q) {
      const q = String(parsed.query.q).toLowerCase();
      list = list.filter(c =>
        (c.name || '').toLowerCase().includes(q) ||
        (c.group || '').toLowerCase().includes(q));
    }
    if (!includeDisabled) list = list.filter(c => c.enabled !== false);

    const lines = ['#EXTM3U', '#PLAYLIST:XTE-IPTV 频道导出 (' + list.length + ')'];
    const labels = { inner: '内网', ipv6: 'IPv6', frp: 'FRP' };
    // raw 模式不需要基地址；代理模式用请求 Host 作为播放基地址（与实际可达性一致）
    const base = raw ? '' : resolvePlaybackBase(line, req);
    for (const ch of list) {
      const name = ch.name || ch.url || '频道';
      if (raw) {
        // 原始流地址：直接导出频道的真实 m3u8 地址
        lines.push(buildChannelExtinf(ch));
        lines.push(ch.url || '');
      } else if (line === 'all') {
        for (const kind of ['inner', 'ipv6', 'frp']) {
          const b = resolvePlaybackBase(kind, req); if (!b) continue;
          const meta = ['-1'];
          if (ch.group) meta.push('group-title="' + ch.group.replace(/"/g, '') + '"');
          if (ch.tvgId) meta.push('tvg-id="' + ch.tvgId.replace(/"/g, '') + '"');
          if (ch.logo) meta.push('tvg-logo="' + ch.logo.replace(/"/g, '') + '"');
          meta.push('tvg-name="' + name.replace(/"/g, '') + ' [' + labels[kind] + ']"');
          lines.push('#EXTINF:' + meta.join(' ') + ',' + name + ' [' + labels[kind] + ']');
          lines.push(`${b}/play/${encodeURIComponent(ch.id)}.m3u8?line=` + encodeURIComponent(kind));
        }
      } else {
        lines.push(buildChannelExtinf(ch));
        lines.push(`${base}/play/${encodeURIComponent(ch.id)}.m3u8?line=` + encodeURIComponent(line));
      }
    }
    const m3u = lines.join('\n') + '\n';
    const stamp = new Date().toISOString().slice(0, 10);
    const scopeTag = scope === 'selected' ? 'selected' : scope === 'search' ? 'search' : 'all';
    const fname = `xte-channels-${stamp}-${scopeTag}-${list.length}.m3u`;
    log('info', '频道导出', { scope, line, raw, count: list.length, includeDisabled });
    return sendText(res, 200, 'application/vnd.apple.mpegurl; charset=utf-8', m3u, {
      'Content-Disposition': `attachment; filename="${fname}"`,
    });
  }

  let cm = p.match(/^\/api\/channels\/([^/]+)$/);
  if (cm && method === 'PATCH') {
    const id = cm[1];
    const ch = channels.find((c) => c.id === id);
    if (!ch) return sendJson(res, 404, { error: 'not found' });
    const body = JSON.parse(await readBody(req));
    for (const k of ['name', 'tvgId', 'tvgName', 'logo', 'group', 'url', 'enabled']) {
      if (body[k] !== undefined) ch[k] = body[k];
    }
    persistChannels();
    return sendJson(res, 200, ch);
  }

  // 日志
  if (p === '/api/logs' && method === 'GET') {
    const level = parsed.query.level;
    let out = logs;
    if (level) out = out.filter((l) => l.level === level);
    return sendJson(res, 200, out.slice(-parseInt(parsed.query.limit || '200', 10)));
  }
  if (p === '/api/logs/export' && method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="xte-logs.txt"',
    });
    res.end(logs.map((l) => {
      const ts = new Date(l.t).toISOString();
      let line = `[${ts}] ${l.level.toUpperCase()} ${l.msg}`;
      if (l.extra) line += ' ' + safeStringify(l.extra);
      return line;
    }).join('\n'));
    return;
  }

  return sendJson(res, 404, { error: 'not found' });
}

// 主播放列表（/playlist.m3u 等兼容路径）：每频道一个 /proxy/m3u8?url=...，统一智能缓冲
function serveMainPlaylist(req, res, parsed) {
  const host = req.headers.host || ('localhost:' + PORT);
  const proto = (req.headers['x-forwarded-proto'] || 'http').toString().split(',')[0];
  const base = proto + '://' + host;

  const out = ['#EXTM3U', '#PLAYLIST:XTE-IPTV'];
  for (const c of channels) {
    if (c.enabled === false) continue;
    const name = c.name || c.tvgName || 'Unknown';
    const attr = [];
    if (c.tvgId) attr.push(`tvg-id="${c.tvgId}"`);
    attr.push(`tvg-name="${name}"`);
    if (c.logo) attr.push(`tvg-logo="${c.logo}"`);
    if (c.group) attr.push(`group-title="${c.group}"`);
    out.push(`#EXTINF:-1 ${attr.join(' ')},${name}`);
    out.push(base + '/proxy/m3u8?url=' + encodeURIComponent(c.url));
  }
  res.writeHead(200, {
    'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'no-cache',
  });
  res.end(out.join('\n') + '\n');
  log('info', '主播放列表请求 ' + out.filter((l) => l.startsWith('#EXTINF')).length + ' 频道');
}

async function servePlaylist(req, res, parsed, lineHint) {
  const q = parsed.query || {};
  const targetUrl = q.url;
  if (!targetUrl) return sendJson(res, 400, { error: 'missing url' });
  const chan = channels.find((c) => c.url === targetUrl) || null;

  // v4.1 统一智能缓冲：所有播放都经会话预取/容错，m3u8 分片地址改写为带 sid 的代理地址，
  // 既保证外网/跨网客户端可达，又靠后台预取维持长时间流畅。
  const session = getOrCreateSession(targetUrl, chan);
  session.noteClient(req, lineHint);
  session.reqStart();
  session.markViewerActivity();
  res.on('close', () => session.reqEnd());
  try {
    // 非阻塞刷新：已有索引立即返回，后台同步源站，把回源延迟移出播放器关键路径。
    let pl;
    const hasIndex = !!session.playlistRaw;
    if (hasIndex) {
      pl = { segs: session.lastSegs, mediaSeq: session.mediaSeq, targetDuration: session.targetDuration };
      session.refresh().catch(() => {});
    } else {
      pl = await session.refresh();
      session.warmPrefetch(0); // 首载即预热前 N 片
    }
    // 分片/子清单基地址：对齐 v4.1.2 行为——播放器用哪个 Host 连上 XTE，
    // 分片就指回哪个 Host。显式配置的线路地址优先；未配置或配置指向回环
    // （FRP/fnOS 网关下常见的 127.0.0.1）时回退到本次请求 Host，保证外网终端可达。
    const base = resolvePlaybackBase(session.line || lineHint, req);
    const rewritten = rewriteMediaPlaylist(
      session.playlistRaw, base, session.id, session.badKeys, targetUrl,
      session.line || lineHint
    );
    res.writeHead(200, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
    });
    res.end(rewritten);
    log('info', 'm3u8 索引返回 session=' + session.id,
      { channel: (chan && chan.name) || '', line: session.line || lineHint || '',
        base, host: req.headers.host || '', ip: session.clientIp,
        terminal: session.terminal, segs: pl.segs.length, seq: session.mediaSeq,
        bad: session.badKeys.size, cached: hasIndex,
        buffered: session.segs.size, hit: session.stats.hit, miss: session.stats.miss,
        prefetched: session.stats.prefetched, fail: session.stats.fail,
        memMB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
  } catch (e) {
    log('error', 'm3u8 处理失败，流式兜底 session=' + session.id,
      { channel: (chan && chan.name) || '', type: classifyError(e), error: e.message });
    if (!res.headersSent) pipeUpstream(targetUrl, req, res, 'm3u8-fallback');
  }
}

async function serveSegment(req, res, parsed) {
  const q = parsed.query || {};
  const targetUrl = q.url;
  const sid = q.sid;
  if (!targetUrl) return sendJson(res, 400, { error: 'missing url' });

  // 通过 sid 找会话；找不到（服务重启后播放器沿用旧 sid、或会话已被回收）时，
  // 按分片 URL 反查频道并重建会话，继续走缓冲链路；只有实在匹配不到频道才纯透传兜底。
  let session = null;
  if (sid) {
    for (const s of sessions.values()) {
      if (s.id === sid) { session = s; break; }
    }
  }
  if (!session) {
    const chanByUrl = channels.find((c) => c.url === targetUrl);
    if (chanByUrl) {
      session = getOrCreateSession(targetUrl, chanByUrl);
      log('warn', '分片请求未找到 sid 会话，已按 URL 重建 session',
        { sid: sid || '', channel: chanByUrl.name || '', newSid: session.id });
    }
  }
  if (!session) {
    log('warn', '分片请求无对应会话且未匹配频道，纯透传兜底', { sid: sid || '', url: shortKey(targetUrl) });
    return pipeUpstream(targetUrl, req, res, 'ts-fallback');
  }

  session.noteClient(req);
  session.reqStart();
  session.markViewerActivity();
  res.on('close', () => session.reqEnd());
  const key = segKey(targetUrl);

  // 命中缓存：立即返回，零等待
  const cached = session.get(key);
  if (cached) {
    session.stats.hit++;
    session.touch();
    session.lastSegServedAt = Date.now();
    res.writeHead(200, {
      'Content-Type': cached.contentType || 'video/mp2t',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache',
      'Content-Length': cached.buffer.length,
    });
    res.end(cached.buffer);
    session.prefetchAhead(targetUrl);
    log('info', '分片命中 session=' + session.id,
      { channel: (session.chan && session.chan.name) || '', key: shortKey(key),
        size: cached.buffer.length, buffered: session.segs.size,
        hit: session.stats.hit, miss: session.stats.miss, prefetched: session.stats.prefetched,
        ip: session.clientIp, terminal: session.terminal });
    return;
  }

  // 未命中：流式回源——收到首个数据块立即写给播放器（降低 TTFB，避免转圈圈），
  // 同时边下边缓存，供下一次命中/预取使用。失败则走重试。
  session.stats.miss++;
  const t0 = Date.now();
  try {
    await session.streamSegmentToClient(targetUrl, res);
    session.lastSegServedAt = Date.now();
    // 走到这里说明响应头已发送且流式成功（缓存写入在 streamSegmentToClient 内完成）
    session.noteSuccess();
    session.touch();
    session.prefetchAhead(targetUrl);
    log('info', '分片流式回源完成 session=' + session.id,
      { channel: (session.chan && session.chan.name) || '', key: shortKey(key),
        costMs: Date.now() - t0, ip: session.clientIp, terminal: session.terminal,
        buffered: session.segs.size, hit: session.stats.hit, miss: session.stats.miss,
        fail: session.stats.fail, memMB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
  } catch (e) {
    if (!res.headersSent) {
      // 流式还没发头：走重试（miss 已计一次，重试内只计 fail/success）
      try {
        const buffer = await session.fetchSegmentWithRetry(targetUrl);
        if (!res.headersSent) {
          res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-cache',
            'Content-Length': buffer.length,
          });
          res.end(buffer);
        }
        session.noteSuccess();
        session.touch();
        session.prefetchAhead(targetUrl);
        log('warn', '分片流式失败后重试成功 session=' + session.id,
          { channel: (session.chan && session.chan.name) || '', key: shortKey(key),
            costMs: Date.now() - t0, size: buffer.length, error: e.message });
      } catch (e2) {
        session.stats.fail++;
        session.noteFailure();
        session.badKeys.add(key);
        log('error', '分片彻底失败，标记坏片并插 discontinuity session=' + session.id,
          { channel: (session.chan && session.chan.name) || '', key: shortKey(key),
            type: classifyError(e2), error: e2.message, costMs: Date.now() - t0,
            fails: session.consecutiveFail, ip: session.clientIp,
            memMB: Math.round(process.memoryUsage().rss / 1024 / 1024) });
        if (!res.headersSent) {
          res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
          res.end();
        }
      }
    } else {
      // 头已发但流出错：只能结束连接，让播放器自行重试
      session.stats.fail++;
      session.noteFailure();
      log('error', '分片流式传输中断 session=' + session.id,
        { channel: (session.chan && session.chan.name) || '', key: shortKey(key),
          type: classifyError(e), error: e.message, costMs: Date.now() - t0 });
      try { res.end(); } catch {}
    }
  }
}





// ---------------------------------------------------------------------------
// 静态文件服务（管理界面）
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, parsed) {
  let rel = parsed.pathname === '/' ? '/index.html' : parsed.pathname;
  // 防目录穿越
  rel = decodeURIComponent(rel).replace(/\.\./g, '');
  const filePath = path.join(WWW_DIR, rel);
  if (!filePath.startsWith(WWW_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end('<h1>404</h1>');
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// HTTP 服务器与路由
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsed = urlParse(req.url);
  const p = parsed.pathname;
  res.setHeader('Server', 'XTE-IPTV/' + APP_VERSION);

  // CORS 预检
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': '*',
    });
    return res.end();
  }

  try {
    // 健康检查
    if (p === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      return res.end('ok');
    }

    // 多线路固定路径（对标 xTeVe，PC 客户端依赖）：/m3u/inner|ipv6|frp|all.m3u8
    const lineMatch = /^\/m3u\/(inner|ipv6|frp|all)\.m3u8?$/i.exec(p);
    if (lineMatch && req.method === 'GET') {
      const kind = lineMatch[1].toLowerCase();
      const bases = getLineBases();
      let text = '';
      if (kind === 'all') {
        if (!config.mergeLines) return sendText(res, 404, 'text/plain; charset=utf-8', '合并列表未启用');
        text = buildMergedPlaylist(bases, channels);
      } else {
        const base = resolvePlaybackBase(kind, req);
        const bases = getLineBases();
        if (!bases[kind]) {
          log('info', '/m3u/' + kind + ' 线路未配置，回退使用请求 Host 生成列表',
            { line: kind, host: req.headers.host || '', ip: clientIp(req) });
        }
        const item = buildLinePlaylist(base, channels, kind);
        if (item.skipped > 0) log('info', '/m3u/' + kind + ' 跳过 ' + item.skipped + ' 个停用频道');
        text = item.text;
      }
      log('info', '多线路列表请求 /m3u/' + kind, { channels: channels.filter((c) => c.enabled !== false).length });
      return sendText(res, 200, 'audio/x-mpegurl; charset=utf-8', text,
        { 'Content-Disposition': `inline; filename="${kind}.m3u8"` });
    }

    // 兼容旧路径：/playlist.m3u、/m3u（按当前请求 Host 生成单线路）
    if ((p === '/playlist.m3u' || p === '/m3u' || p === '/m3u8' || p === '/m3u/playlist.m3u') && req.method === 'GET') {
      const host = req.headers.host || ('localhost:' + PORT);
      const base = 'http://' + host;
      const item = buildLinePlaylist(base, channels);
      return sendText(res, 200, 'audio/x-mpegurl; charset=utf-8', item.text);
    }

    // 单频道播放：/play/{id}.m3u8（PC 客户端按此路径请求）
    const playMatch = /^\/play\/([A-Za-z0-9_-]+)\.m3u8?$/i.exec(p);
    if (playMatch && req.method === 'GET') {
      const ch = channels.find((c) => c.id === playMatch[1]);
      if (!ch) return sendText(res, 404, 'text/plain; charset=utf-8', 'channel not found');
      // 复用 servePlaylist，构造 url 参数；优先用播放列表里携带的 ?line=
      parsed.query.url = ch.url;
      const qLine = parsed.query.line ? String(parsed.query.line).toLowerCase() : '';
      const line = (qLine === 'inner' || qLine === 'ipv6' || qLine === 'frp') ? qLine : detectLine(req);
      req._xteLine = line;
      return await servePlaylist(req, res, parsed, line);
    }
    if (p === '/play' && req.method === 'GET') {
      const id = parsed.query.ch;
      const ch = channels.find((c) => c.id === id);
      if (!ch) return sendText(res, 404, 'text/plain; charset=utf-8', 'channel not found');
      parsed.query.url = ch.url;
      // 以本次请求的 Host/IP 判定线路并固化到 req，后续分片请求沿用
      const qLine = parsed.query.line ? String(parsed.query.line).toLowerCase() : '';
      req._xteLine = (qLine === 'inner' || qLine === 'ipv6' || qLine === 'frp') ? qLine : detectLine(req);
      return await servePlaylist(req, res, parsed, req._xteLine);
    }

    if (p === '/proxy/m3u8') {
      req._xteLine = detectLine(req);
      return await servePlaylist(req, res, parsed, req._xteLine);
    }
    if (p === '/proxy/ts') {
      req._xteLine = detectLine(req);
      return await serveSegment(req, res, parsed);
    }
    if (p.startsWith('/api/')) {
      return await handleApi(req, res, parsed);
    }
    return serveStatic(req, res, parsed);
  } catch (e) {
    log('error', '请求处理异常 ' + p, { error: e.message, stack: e.stack });
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal', message: e.message }));
    } else {
      try { res.end(); } catch {}
    }
  }
});

server.on('clientError', (err, socket) => {
  try { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch {}
});

// 双栈监听：绑定 '::' 在 Linux 默认 net.ipv6.bindv6only=0 下同时接受 IPv4 与 IPv6，
// 修复 v4.1 之前只监听 0.0.0.0 导致 IPv6/FRP(v6) 链路无法连接的问题。
const BIND_HOST = process.env.XTE_BIND_HOST || '::';
server.listen(PORT, BIND_HOST, () => {
  const addrs = server.address();
  log('info', 'XTE-IPTV v' + APP_VERSION + ' 启动', {
    port: PORT,
    bind: BIND_HOST,
    listenAddr: addrs,
    mode: 'smart',
    dataDir: DATA_DIR,
    channels: channels.length,
    sources: sources.length,
    node: process.version,
  });
  // 关键运行参数写入日志，便于从日志直接判断卡顿是否与配置有关
  log('info', '缓冲与回源参数', {
    cacheWindow: config.cacheWindow,
    prefetchAhead: config.prefetchAhead,
    refreshMinIntervalMs: config.refreshMinIntervalMs,
    keepAliveIntervalMs: config.keepAliveIntervalMs,
    segmentTtlMs: config.segmentTtlMs,
    sessionTtlMs: config.sessionTtlMs,
    segRetry: config.segRetry,
    segRetryIntervalMs: config.segRetryIntervalMs,
  });
  const bases = getLineBases();
  log('info', '线路基地址', {
    inner: bases.inner || '(未启用)',
    ipv6: bases.ipv6 || '(未启用/未填 host)',
    frp: bases.frp || '(未启用/未填 host)',
  });
  // 启动时若有源但无频道，自动刷新一次
  if (sources.length && !channels.length) {
    refreshAllSources().catch(() => {});
  }
});

process.on('uncaughtException', (e) => log('error', 'uncaughtException', { error: e.message, stack: e.stack }));
process.on('unhandledRejection', (e) => log('error', 'unhandledRejection', { error: String(e) }));
