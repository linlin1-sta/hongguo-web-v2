/* 红果短剧手机网页版 v2.1 — 单服务后端
 * 数据面：首页/详情代理 hongguoTV bridge（同容器 127.0.0.1:8787，仅用 home/series）
 * 搜索面：hongguo-drama 路 A signedSearchRequest（hongguo-app-search.searchApp）
 * 播放面：路 A fetchAppPlayUrl(vid) → CENC HEVC 流 + contentKey
 *         → 服务端下载加密文件 → ffmpeg -decryption_key 解密并转码 H.264 MP4 → 本地缓存后 Range 供播
 * 上游模块 GPL-3.0，声明见 native/*.js 文件头与 LICENSE-hongguo-drama。
 *
 * v2.1 改动（仅 server 层，native/ 取流算法未动）：
 *  1) 播放链路全程结构化日志（console.log，ISO 时间戳 + vid 掩码 + 阶段 + 耗时），
 *     异常必打 error name/message/code；日志红线：不打完整播放地址、contentKey、完整设备 ID。
 *  2) prepare 失败把「最后一步 + 人话原因 + 错误摘要」存进任务状态，status 接口带回前端展示。
 *  3) 取流硬化：fetchAppPlayUrl 失败/超时后间隔 3s 换新设备重试 1 次（fetchAppPlayUrl
 *     内部每次调用都会重新注册设备，server 层重试即新设备）；各阶段有明确超时，
 *     单次 prepare 总超时 240s，到点必置失败态。
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8899);
const HOST = process.env.HOST || '0.0.0.0';
const BRIDGE_ORIGIN = process.env.BRIDGE_ORIGIN || 'http://127.0.0.1:8787';
const CACHE_DIR = process.env.VIDEO_CACHE_DIR || '/tmp/video-cache-v2';
fs.mkdirSync(CACHE_DIR, { recursive: true });
for (const f of fs.readdirSync(CACHE_DIR)) {
  if (f.endsWith('.enc.mp4') || f.endsWith('.tmp.mp4')) { try { fs.unlinkSync(path.join(CACHE_DIR, f)); } catch {} }
}

const { fetchAppPlayUrl } = require('./native/app-source.js');
const { searchApp } = require('./native/hongguo-app-search.js');

/* ---------- 超时/重试参数（可用环境变量覆盖） ---------- */
const PREPARE_TIMEOUT_MS = Number(process.env.PREPARE_TIMEOUT_MS || 240000);   // 单次 prepare 总上限
const FETCH_ATTEMPT_TIMEOUT_MS = Number(process.env.FETCH_ATTEMPT_TIMEOUT_MS || 90000); // 单次取流尝试上限
const FETCH_MAX_ATTEMPTS = 2;                                                  // 取流总尝试次数（含首次）
const FETCH_RETRY_DELAY_MS = 3000;                                             // 取流重试间隔
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 120000); // CDN 下载上限
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 150000);     // ffmpeg 解密转码上限

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let upstreamCount = 0; // 本地诊断用：粗略统计本服务发出的上游请求

/* ---------- 结构化日志 ----------
 * 格式：[ISO时间] [hg-v2.1] vid=<掩码> stage=<阶段> <消息> k=v ...
 * 红线：vid 只留前后各 4 位；不输出完整播放 URL（只记 host）、contentKey（只记有/无）、设备 ID 全文。
 */
function maskId(v) {
  const s = String(v == null ? '' : v);
  if (!s) return '-';
  return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-4)}`;
}
function hostOf(u) { try { return new URL(u).host; } catch { return '?'; } }
function logLine(vid, stage, msg, kv) {
  let extra = '';
  if (kv) extra = ' ' + Object.entries(kv).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[${new Date().toISOString()}] [hg-v2.1] vid=${maskId(vid)} stage=${stage || '-'} ${msg}${extra}`);
}
function errInfo(e) {
  if (!e) return { name: 'Error', message: 'unknown', code: '', status: '', registrationFailure: '' };
  return {
    name: e.name || 'Error',
    message: String(e.message || e),
    code: e.code || '',
    status: e.status != null ? String(e.status) : '',
    registrationFailure: e.registrationFailure || '',
  };
}
function errKv(e) {
  const i = errInfo(e);
  const kv = { err: i.name, code: i.code || '-', msg: i.message.replace(/\s+/g, ' ').slice(0, 300) };
  if (i.status) kv.httpStatus = i.status;
  if (i.registrationFailure) kv.regFailure = i.registrationFailure;
  return kv;
}
/* 把技术错误翻成人话原因（前端直接展示） */
function humanReason(stageKey, e) {
  const i = errInfo(e);
  const code = i.code;
  if (e && e.isPrepareTimeout) return `准备超时：超过 ${Math.round(PREPARE_TIMEOUT_MS / 1000)} 秒未完成，已停下，请重试`;
  if (stageKey === 'fetch') {
    if (code === 'DEVICE_REGISTRATION_FAILED') return `取流失败：设备注册失败${i.registrationFailure ? `（${i.registrationFailure}）` : ''}，上游没放行新设备`;
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED') return '取流失败：video_model 请求超时，上游没在时限内回话';
    if (code === 'EMPTY_RESPONSE') return '取流失败：上游返回空响应（签名或设备鉴权问题）';
    if (code === 'BUSINESS_REJECTED') return '取流失败：上游拒绝提供本集播放信息';
    if (code === 'MISSING_MODEL' || code === 'INVALID_RESPONSE') return '取流失败：上游没返回有效的播放信息';
    if (code === 'NO_COMPATIBLE_SOURCE' || code === 'QUALITY_UNAVAILABLE') return `取流失败：${i.message}`;
    if (code) return `取流失败：网络/上游错误（${code}）`;
    return `取流失败：${i.message}`;
  }
  if (stageKey === 'download') {
    if (i.status) return `下载失败：媒体服务器返回 HTTP ${i.status}`;
    if (code === 'ETIMEDOUT' || code === 'ECONNABORTED' || e.name === 'TimeoutError' || e.name === 'AbortError') return '下载失败：加密流下载超时';
    return `下载失败：${i.message}`;
  }
  if (stageKey === 'transcode') {
    if (code === 'ETIMEDOUT') return '解密转码失败：ffmpeg 超时未完成';
    return `解密转码失败：${i.message}`;
  }
  return i.message;
}
function errorDetail(e) {
  const i = errInfo(e);
  const firstLine = i.message.split('\n')[0].replace(/\s+/g, ' ').slice(0, 200);
  return `${i.name}: ${firstLine}${i.code ? ` [${i.code}]` : ''}${i.status ? ` [HTTP ${i.status}]` : ''}`;
}
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error(`${label}超时（>${Math.round(ms / 1000)}s）`);
      e.code = 'ETIMEDOUT';
      reject(e);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/* ---------- 数据面：代理 bridge（仅 home / series） ---------- */
async function proxyBridge(req, res, bridgePath) {
  const t0 = Date.now();
  try {
    upstreamCount++;
    const r = await fetch(BRIDGE_ORIGIN + bridgePath, { signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    logLine('', 'bridge', `proxy ok path=${bridgePath.split('?')[0]}`, { httpStatus: r.status, ms: Date.now() - t0 });
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (e) {
    logLine('', 'bridge', `proxy FAILED path=${bridgePath.split('?')[0]}`, { ms: Date.now() - t0, ...errKv(e) });
    json(res, 502, { error: '目录服务暂不可用: ' + e.message });
  }
}

/* ---------- 搜索面：路 A ---------- */
async function handleSearch(req, res, q) {
  const t0 = Date.now();
  try {
    upstreamCount += 2; // 注册（缓存后多为0）+ 搜索请求，粗略计
    const out = await searchApp(q, { page: 1, deadline: Date.now() + 25000 });
    const items = out.results.map(r => ({
      id: r.series_id, title: r.series_title, cover: r.cover || '',
      description: r.description || '', badge: r.episode_count ? `全${r.episode_count}集` : '',
    }));
    logLine('', 'search', 'search ok', { results: items.length, ms: Date.now() - t0 });
    json(res, 200, { items, page: 1 });
  } catch (e) {
    logLine('', 'search', 'search FAILED', { ms: Date.now() - t0, ...errKv(e) });
    json(res, 502, { error: '搜索暂不可用: ' + e.message, code: e.code || '' });
  }
}

/* ---------- 播放面：取流 → 下载 → 解密转码 → 缓存 ---------- */
const jobs = new Map(); // vid -> job
function finalFile(vid) { return path.join(CACHE_DIR, `${vid}.mp4`); }

function setStage(job, stageKey, stageLabel) {
  job.stageKey = stageKey;
  job.stage = stageLabel;
  job.stageSince = Date.now();
  logLine(job.vid, stageKey, `stage -> ${stageLabel}`);
}
function prepareTimeoutError() {
  const e = new Error(`prepare 总超时 ${Math.round(PREPARE_TIMEOUT_MS / 1000)}s`);
  e.code = 'ETIMEDOUT';
  e.isPrepareTimeout = true;
  return e;
}

/* 取流：server 层有界重试。fetchAppPlayUrl 每次调用内部都会重新注册一台新设备，
 * 所以重试 = 换新设备重试；内部对 EMPTY_RESPONSE 另有一次换 host 重试（native 既有行为，未改）。 */
async function fetchPlayWithRetry(vid, job, remainingMs) {
  let lastErr = null;
  for (let attempt = 1; attempt <= FETCH_MAX_ATTEMPTS; attempt++) {
    if (remainingMs() <= 0) throw prepareTimeoutError();
    const budget = Math.min(FETCH_ATTEMPT_TIMEOUT_MS, remainingMs());
    job.attempts = attempt;
    const t0 = Date.now();
    logLine(vid, 'fetch', `video_model 取流开始 attempt=${attempt}/${FETCH_MAX_ATTEMPTS} budgetMs=${budget}（每次尝试内部含新设备注册+签名）`);
    try {
      upstreamCount += 2; // 设备注册 + video_model，粗略计
      const play = await withTimeout(fetchAppPlayUrl(vid, {}), budget, '取流');
      if (!play.url) throw new Error('未拿到播放地址');
      logLine(vid, 'fetch', 'video_model 取流成功', {
        attempt, ms: Date.now() - t0,
        quality: play.quality || '-', codec: play.codec || '-',
        key: play.contentKey ? 'present' : 'none',
        cdnHost: hostOf(play.url),
        variants: Array.isArray(play.variants) ? play.variants.length : 1,
      });
      return play;
    } catch (e) {
      lastErr = e;
      logLine(vid, 'fetch', `video_model 取流失败 attempt=${attempt}`, { ms: Date.now() - t0, ...errKv(e) });
      if (attempt < FETCH_MAX_ATTEMPTS) {
        if (remainingMs() <= FETCH_RETRY_DELAY_MS + 5000) {
          logLine(vid, 'fetch', '剩余 prepare 预算不足，放弃重试');
          break;
        }
        logLine(vid, 'fetch', `等待 ${FETCH_RETRY_DELAY_MS}ms 后换新设备重试`);
        await sleep(FETCH_RETRY_DELAY_MS);
      }
    }
  }
  throw lastErr || new Error('取流失败');
}

async function downloadEncrypted(vid, job, play, encFile, remainingMs) {
  const budget = Math.min(DOWNLOAD_TIMEOUT_MS, remainingMs());
  if (budget <= 0) throw prepareTimeoutError();
  const t0 = Date.now();
  logLine(vid, 'download', 'CDN 下载开始', { cdnHost: hostOf(play.url), budgetMs: budget });
  upstreamCount++;
  const resp = await fetch(play.url, {
    headers: { 'User-Agent': play.userAgent || '' },
    signal: AbortSignal.timeout(budget),
  });
  if (!resp.ok) {
    const e = new Error('媒体下载 HTTP ' + resp.status);
    e.status = resp.status;
    throw e;
  }
  const declared = Number(resp.headers.get('content-length') || 0);
  const buf = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(encFile, buf);
  logLine(vid, 'download', 'CDN 下载完成', {
    bytes: buf.length, declaredBytes: declared || '-', ms: Date.now() - t0,
  });
  return buf.length;
}

async function transcode(vid, job, play, encFile, tmpFile, remainingMs) {
  const budget = Math.min(FFMPEG_TIMEOUT_MS, remainingMs());
  if (budget <= 0) throw prepareTimeoutError();
  const args = [];
  if (play.contentKey) args.push('-decryption_key', play.contentKey); // key 只进 argv，绝不进日志
  args.push('-v', 'error', '-i', encFile,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
    '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart', '-f', 'mp4', '-y', tmpFile);
  const t0 = Date.now();
  logLine(vid, 'transcode', 'ffmpeg 解密+转码开始', {
    encBytes: job.encBytes || '-', decryptionKey: play.contentKey ? 'present' : 'none', budgetMs: budget,
  });
  await new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args);
    let errTail = '';
    let settled = false;
    const killer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ff.kill('SIGKILL'); } catch {}
      const e = new Error(`ffmpeg 超时（>${Math.round(budget / 1000)}s）`);
      e.code = 'ETIMEDOUT';
      logLine(vid, 'transcode', 'ffmpeg 超时被终止', { ms: Date.now() - t0, stderrTail: errTail.trim().split('\n').slice(-3).join(' | ').slice(0, 300) || '-' });
      reject(e);
    }, budget);
    ff.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-4000); });
    ff.on('error', (e2) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      logLine(vid, 'transcode', 'ffmpeg 启动失败', { ms: Date.now() - t0, ...errKv(e2) });
      reject(e2);
    });
    ff.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      const tail = errTail.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
      logLine(vid, 'transcode', `ffmpeg 退出 code=${code}`, { ms: Date.now() - t0, stderrTail: tail || '-' });
      if (code === 0) resolve();
      else reject(new Error('ffmpeg 退出码 ' + code + ': ' + errTail.slice(-500)));
    });
  });
}

async function runJob(vid) {
  const job = jobs.get(vid);
  const startedAt = Date.now();
  job.startedAt = startedAt;
  const deadline = startedAt + PREPARE_TIMEOUT_MS;
  const remainingMs = () => deadline - Date.now();
  logLine(vid, 'prepare', `prepare 开始 totalTimeoutMs=${PREPARE_TIMEOUT_MS}`);
  try {
    /* 阶段 1：取流（注册新设备 + 签名 video_model，失败换新设备重试 1 次） */
    setStage(job, 'fetch', '取流（注册新设备+签名）');
    const play = await fetchPlayWithRetry(vid, job, remainingMs);
    job.quality = play.quality || '';
    job.srcCodec = play.codec || '';

    /* 阶段 2：下载加密流 */
    if (remainingMs() <= 0) throw prepareTimeoutError();
    setStage(job, 'download', '下载加密流');
    const encFile = path.join(CACHE_DIR, `${vid}.enc.mp4`);
    job.encBytes = await downloadEncrypted(vid, job, play, encFile, remainingMs);

    /* 阶段 3：ffmpeg 解密 + 转码 H.264 */
    if (remainingMs() <= 0) throw prepareTimeoutError();
    setStage(job, 'transcode', '解密+转码 H.264');
    const tmpFile = path.join(CACHE_DIR, `${vid}.tmp.mp4`);
    await transcode(vid, job, play, encFile, tmpFile, remainingMs);
    fs.renameSync(tmpFile, finalFile(vid));
    try { fs.unlinkSync(encFile); } catch {}
    job.outBytes = fs.statSync(finalFile(vid)).size;

    job.status = 'ready';
    job.stageKey = 'done';
    job.stage = '完成';
    job.file = finalFile(vid);
    logLine(vid, 'prepare', 'prepare 完成 ready', {
      totalMs: Date.now() - startedAt, attempts: job.attempts || 1,
      quality: job.quality || '-', outBytes: job.outBytes,
    });
  } catch (e) {
    const stageKey = job.stageKey || 'fetch';
    job.status = 'error';
    job.lastStage = stageKey;
    job.lastStageLabel = job.stage || '';
    job.error = e.message;
    job.code = e.code || '';
    job.reason = humanReason(stageKey, e);
    job.detail = errorDetail(e);
    job.failedAt = new Date().toISOString();
    logLine(vid, 'prepare', 'prepare 失败', {
      totalMs: Date.now() - startedAt, failedStage: stageKey, attempts: job.attempts || 0,
      reason: job.reason, ...errKv(e),
    });
  }
}

function ensureJob(vid, via) {
  const file = finalFile(vid);
  if (fs.existsSync(file) && fs.statSync(file).size > 10000) {
    if (!jobs.has(vid)) {
      jobs.set(vid, { vid, status: 'ready', file, stage: '缓存命中', stageKey: 'cache', attempts: 0 });
      logLine(vid, 'cache', `缓存命中 via=${via}`, { bytes: fs.statSync(file).size });
    }
    return jobs.get(vid);
  }
  let job = jobs.get(vid);
  if (!job || job.status === 'error') {
    job = { vid, status: 'working', stage: '排队', stageKey: 'queue', error: '', reason: '', detail: '', attempts: 0, createdAt: Date.now() };
    jobs.set(vid, job);
    logLine(vid, 'prepare', `prepare 收到请求 via=${via}（新建任务）`);
    runJob(vid);
  } else if (job.status === 'working') {
    // 轮询请求不重复打日志，只在间隔较久时记一条进度（防日志刷屏）
    const now = Date.now();
    if (!job.lastPollLog || now - job.lastPollLog > 30000) {
      job.lastPollLog = now;
      logLine(vid, job.stageKey || 'prepare', `prepare 进行中 via=${via}`, { stage: job.stage || '', elapsedMs: job.startedAt ? now - job.startedAt : 0 });
    }
  }
  return job;
}

/* ---------- 文件 Range 供播 ---------- */
function serveFile(req, res, file, vid) {
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) {
      logLine(vid, 'serve', 'Range 请求不合法 -> 416', { range, fileBytes: size });
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end();
    }
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : size - 1;
    if (start >= size) {
      logLine(vid, 'serve', 'Range 起点越界 -> 416', { range, fileBytes: size });
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end();
    }
    end = Math.min(end, size - 1);
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = end - start + 1;
    logLine(vid, 'serve', 'Range 供播 206', { range: `bytes ${start}-${end}/${size}`, bytes: end - start + 1, method: req.method });
    res.writeHead(206, headers);
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    headers['Content-Length'] = size;
    logLine(vid, 'serve', '全量供播 200', { fileBytes: size, method: req.method });
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }
}

/* ---------- 静态前端 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.join(__dirname, 'public', rel);
  if (!file.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

/* ---------- 路由 ---------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') return json(res, 200, { ok: true, version: '2.1.0', upstreamApprox: upstreamCount });
    if (p === '/api/home') return proxyBridge(req, res, `/api/home?page=${Number(url.searchParams.get('page') || 1)}`);
    const series = /^\/api\/series\/(\d{1,30})$/.exec(p);
    if (series) return proxyBridge(req, res, `/api/series/${series[1]}`);
    if (p === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return json(res, 400, { error: '请输入关键词' });
      return handleSearch(req, res, q);
    }
    const playMatch = /^\/api\/(prepare|status|video)\/(\d{1,30})$/.exec(p);
    if (playMatch) {
      const [, kind, vid] = playMatch;
      const job = ensureJob(vid, kind);
      if (kind === 'prepare' || kind === 'status') {
        return json(res, 200, {
          vid, status: job.status, stage: job.stage || '', stageKey: job.stageKey || '',
          error: job.error || '',
          reason: job.status === 'error' ? (job.reason || '') : '',
          detail: job.status === 'error' ? (job.detail || '') : '',
          lastStage: job.lastStage || '', code: job.code || '',
          attempts: job.attempts || 0,
          elapsedMs: job.startedAt ? (job.status === 'working' ? Date.now() - job.startedAt : (job.failedAt ? new Date(job.failedAt).getTime() - job.startedAt : 0)) : 0,
          quality: job.quality || '', srcCodec: job.srcCodec || '', encBytes: job.encBytes || 0,
        });
      }
      if (job.status !== 'ready') return json(res, 425, { error: '尚未就绪', status: job.status, stage: job.stage || '', reason: job.reason || '', detail: job.detail || '' });
      return serveFile(req, res, job.file, vid);
    }
    return serveStatic(req, res, p);
  } catch (e) {
    logLine('', 'http', '请求处理异常', errKv(e));
    json(res, 500, { error: e.message });
  }
});
server.listen(PORT, HOST, () => console.log(`[${new Date().toISOString()}] [hg-v2.1] vid=- stage=boot listening on ${HOST}:${PORT}, cache=${CACHE_DIR}, prepareTimeoutMs=${PREPARE_TIMEOUT_MS}`));
