/* 红果短剧手机网页版 v2.2 — 单服务后端
 * 数据面：首页/详情代理 hongguoTV bridge（同容器 127.0.0.1:8787，仅用 home/series）
 * 搜索面：hongguo-drama 路 A signedSearchRequest（hongguo-app-search.searchApp）
 * 播放面：路 A fetchAppPlayUrl(vid) → CENC HEVC 流 + contentKey → 服务端下载加密文件
 *         → 主路「解密直拷」：ffmpeg -decryption_key -c copy 输出解密 HEVC MP4（近零资源）
 *         → 备路「转码」：前端 <video> 报错时才走，解密 + 转 H.264（省内存参数）
 *         → 本地缓存后 Range 供播
 * 上游模块 GPL-3.0，声明见 native/*.js 文件头与 LICENSE-hongguo-drama。
 *
 * v2.2 改动（仅 server 层 + 前端 app.js，native/ 取流算法未动）：
 *  背景：v2.1 线上日志定案——取流/下载在 Railway 上每次约 1s/1.4s 成功，死因是容器内
 *  ffmpeg 转码启动后 0.6–0.76s 即被信号杀（code=null、signal 有值、stderr 全空）。
 *  1) 解密直拷为默认主路：-c copy 不重编码，近零 CPU/内存，秒级完成；iPhone Safari 原生支持 HEVC MP4。
 *  2) 转码降为按需备路（prepare?mode=transcode）：-threads 2 + ultrafast + 输出缩放上限宽 720。
 *  3) single-flight：同 vid+mode 进行中任务一律挂靠不新建；失败置 30s 冷却，
 *     冷却内 prepare/status 不重跑（显式 retry=1 除外）；全局 ffmpeg 并发信号量 = 1。
 *  4) 启动自检 ffmpeg（-version + lavfi 1 秒空转码）并写 boot 日志；所有 ffmpeg 子进程
 *     监听 error 事件，退出日志必带 code + signal——一眼区分「根本跑不起来」与「跑真活被杀」。
 * v2.1 既有：全程结构化日志（ISO 时间戳 + vid 掩码 + 阶段 + 耗时，异常必打）、失败人话原因
 *  回显、取流有界重试（失败间隔 3s 换新设备重试 1 次）、prepare 总超时 240s。
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

/* ---------- 超时/重试/冷却参数（可用环境变量覆盖） ---------- */
const PREPARE_TIMEOUT_MS = Number(process.env.PREPARE_TIMEOUT_MS || 240000);   // 单次 prepare 总上限
const FETCH_ATTEMPT_TIMEOUT_MS = Number(process.env.FETCH_ATTEMPT_TIMEOUT_MS || 90000); // 单次取流尝试上限
const FETCH_MAX_ATTEMPTS = 2;                                                  // 取流总尝试次数（含首次）
const FETCH_RETRY_DELAY_MS = 3000;                                             // 取流重试间隔
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 120000); // CDN 下载上限
const FFMPEG_TIMEOUT_MS = Number(process.env.FFMPEG_TIMEOUT_MS || 150000);     // 转码备路 ffmpeg 上限
const FFMPEG_COPY_TIMEOUT_MS = Number(process.env.FFMPEG_COPY_TIMEOUT_MS || 60000); // 直拷 ffmpeg 上限
const ERROR_COOLDOWN_MS = Number(process.env.ERROR_COOLDOWN_MS || 30000);      // 失败任务冷却（single-flight）

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let upstreamCount = 0; // 本地诊断用：粗略统计本服务发出的上游请求

/* ---------- 结构化日志 ----------
 * 格式：[ISO时间] [hg-v2.2] vid=<掩码> stage=<阶段> <消息> k=v ...
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
  console.log(`[${new Date().toISOString()}] [hg-v2.2] vid=${maskId(vid)} stage=${stage || '-'} ${msg}${extra}`);
}
function errInfo(e) {
  if (!e) return { name: 'Error', message: 'unknown', code: '', status: '', registrationFailure: '', signal: '' };
  return {
    name: e.name || 'Error',
    message: String(e.message || e),
    code: e.code || '',
    status: e.status != null ? String(e.status) : '',
    registrationFailure: e.registrationFailure || '',
    signal: e.signal || '',
  };
}
function errKv(e) {
  const i = errInfo(e);
  const kv = { err: i.name, code: i.code || '-', msg: i.message.replace(/\s+/g, ' ').slice(0, 300) };
  if (i.status) kv.httpStatus = i.status;
  if (i.registrationFailure) kv.regFailure = i.registrationFailure;
  if (i.signal) kv.signal = i.signal;
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
  if (stageKey === 'remux') {
    if (i.signal) return `解密直拷失败：ffmpeg 被信号 ${i.signal} 终止（容器资源受限的典型表现）`;
    if (code === 'ETIMEDOUT') return '解密直拷失败：ffmpeg 超时未完成';
    return `解密直拷失败：${i.message}`;
  }
  if (stageKey === 'transcode') {
    if (i.signal) return `解密转码失败：ffmpeg 被信号 ${i.signal} 终止（容器资源受限的典型表现）`;
    if (code === 'ETIMEDOUT') return '解密转码失败：ffmpeg 超时未完成';
    return `解密转码失败：${i.message}`;
  }
  return i.message;
}
function errorDetail(e) {
  const i = errInfo(e);
  const firstLine = i.message.split('\n')[0].replace(/\s+/g, ' ').slice(0, 200);
  return `${i.name}: ${firstLine}${i.code ? ` [${i.code}]` : ''}${i.status ? ` [HTTP ${i.status}]` : ''}${i.signal ? ` [signal ${i.signal}]` : ''}`;
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

/* ---------- ffmpeg 全局信号量（并发 = 1） ---------- */
let ffmpegBusy = false;
const ffmpegWaiters = [];
function acquireFfmpeg(vid, stageKey) {
  return new Promise((resolve) => {
    const grant = () => {
      ffmpegBusy = true;
      logLine(vid, stageKey, 'ffmpeg 信号量获得（全局并发=1）');
      resolve(() => {
        ffmpegBusy = false;
        const next = ffmpegWaiters.shift();
        if (next) next();
      });
    };
    if (!ffmpegBusy) grant();
    else {
      logLine(vid, stageKey, 'ffmpeg 信号量等待中（已有 ffmpeg 任务在跑）', { queue: ffmpegWaiters.length + 1 });
      ffmpegWaiters.push(grant);
    }
  });
}

/* 统一 ffmpeg 子进程执行：监听 error 事件；退出日志必带 code + signal + stderr 末尾。
 * 超时 SIGKILL 强杀并置 ETIMEDOUT（signal 记为我方所发，与外部杀进程区分）。 */
async function runFfmpeg(job, stageKey, label, args, budgetMs) {
  const release = await acquireFfmpeg(job.vid, stageKey);
  const t0 = Date.now();
  logLine(job.vid, stageKey, `ffmpeg ${label}开始`, {
    mode: job.mode, encBytes: job.encBytes || '-', budgetMs,
  });
  try {
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args);
      let errTail = '';
      let settled = false;
      const killer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ff.kill('SIGKILL'); } catch {}
        const e = new Error(`ffmpeg ${label}超时（>${Math.round(budgetMs / 1000)}s）被我方 SIGKILL 终止`);
        e.code = 'ETIMEDOUT';
        e.signal = 'SIGKILL(self)';
        logLine(job.vid, stageKey, `ffmpeg ${label}超时被终止`, {
          ms: Date.now() - t0, code: '-', signal: 'SIGKILL(self)',
          stderrTail: errTail.trim().split('\n').slice(-3).join(' | ').slice(0, 300) || '-',
        });
        reject(e);
      }, budgetMs);
      ff.stderr.on('data', d => { errTail = (errTail + d.toString()).slice(-4000); });
      ff.on('error', (e2) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        logLine(job.vid, stageKey, `ffmpeg ${label}启动失败（error 事件）`, { ms: Date.now() - t0, ...errKv(e2) });
        reject(e2);
      });
      ff.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(killer);
        const tail = errTail.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(0, 300);
        logLine(job.vid, stageKey, `ffmpeg ${label}退出`, {
          code: code == null ? 'null' : code, signal: signal || '-', ms: Date.now() - t0,
          stderrTail: tail || '-',
        });
        if (code === 0) resolve();
        else {
          const e = new Error(`ffmpeg 退出 code=${code} signal=${signal || '-'}: ` + errTail.slice(-500));
          e.signal = signal || '';
          e.ffmpegCode = code;
          reject(e);
        }
      });
    });
  } finally {
    release();
  }
}

/* ---------- 启动自检：ffmpeg 在当前进程环境里到底能不能跑 ---------- */
const selfCheck = { ffmpegVersion: '', versionCode: null, versionSignal: '', lavfi: null };
function spawnCapture(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '', err = '', settled = false;
    let child;
    try { child = spawn(cmd, args); } catch (e) {
      return resolve({ code: null, signal: '', ms: 0, stdout: '', stderr: '', spawnError: e });
    }
    const killer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGKILL'); } catch {}
      resolve({ code: null, signal: 'SIGKILL(self-timeout)', ms: Date.now() - t0, stdout: out, stderr: err });
    }, timeoutMs);
    child.stdout.on('data', d => { out = (out + d.toString()).slice(0, 2000); });
    child.stderr.on('data', d => { err = (err + d.toString()).slice(-2000); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ code: null, signal: '', ms: Date.now() - t0, stdout: out, stderr: err, spawnError: e });
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      resolve({ code, signal: signal || '', ms: Date.now() - t0, stdout: out, stderr: err });
    });
  });
}
async function bootSelfCheck() {
  const v = await spawnCapture('ffmpeg', ['-version'], 10000);
  selfCheck.ffmpegVersion = (v.stdout || '').split('\n')[0] || '';
  selfCheck.versionCode = v.code;
  selfCheck.versionSignal = v.signal || '';
  if (v.spawnError) {
    logLine('', 'selfcheck', 'ffmpeg -version 启动失败（error 事件）', errKv(v.spawnError));
  } else {
    logLine('', 'selfcheck', `ffmpeg -version code=${v.code} signal=${v.signal || '-'}`, {
      ms: v.ms, version: selfCheck.ffmpegVersion || '-',
    });
  }
  const t = await spawnCapture('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=1:size=128x128:rate=10',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-f', 'null', '-',
  ], 20000);
  selfCheck.lavfi = { ok: t.code === 0, code: t.code, signal: t.signal || '', ms: t.ms };
  const firstErr = (t.stderr || '').trim().split('\n').filter(Boolean)[0] || '';
  if (t.spawnError) {
    logLine('', 'selfcheck', 'lavfi 空转码自检启动失败（error 事件）', errKv(t.spawnError));
  } else {
    logLine('', 'selfcheck', `lavfi 空转码自检 ${t.code === 0 ? 'OK' : 'FAILED'} code=${t.code} signal=${t.signal || '-'}`, {
      ms: t.ms, stderrFirst: firstErr.slice(0, 200) || '-',
    });
  }
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

/* ---------- 播放面：取流 → 下载 → 解密（直拷主路 / 转码备路） → 缓存 ---------- */
const jobs = new Map(); // `${vid}:${mode}` -> job
function normalizeMode(m) { return m === 'transcode' ? 'transcode' : 'copy'; }
function jobKey(vid, mode) { return `${vid}:${mode}`; }
function finalFile(vid, mode) {
  return path.join(CACHE_DIR, mode === 'transcode' ? `${vid}.h264.mp4` : `${vid}.mp4`);
}
function encFileOf(vid, mode) { return path.join(CACHE_DIR, `${vid}.${mode}.enc.mp4`); }
function tmpFileOf(vid, mode) { return path.join(CACHE_DIR, `${vid}.${mode}.tmp.mp4`); }

function setStage(job, stageKey, stageLabel) {
  job.stageKey = stageKey;
  job.stage = stageLabel;
  job.stageSince = Date.now();
  logLine(job.vid, stageKey, `stage -> ${stageLabel}`, { mode: job.mode });
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

/* 主路：解密直拷。-decryption_key 解 CENC，-c copy 不重编码；
 * HEVC 流补 hvc1 标记（Safari 只认 hvc1，不认 hev1）。 */
async function remuxCopy(job, play, encFile, tmpFile, remainingMs) {
  const budget = Math.min(FFMPEG_COPY_TIMEOUT_MS, remainingMs());
  if (budget <= 0) throw prepareTimeoutError();
  const args = [];
  if (play.contentKey) args.push('-decryption_key', play.contentKey); // key 只进 argv，绝不进日志
  args.push('-v', 'error', '-i', encFile, '-c', 'copy');
  const codec = String(play.codec || '').toLowerCase();
  if (codec.includes('hevc') || codec.includes('hvc') || codec.includes('265')) args.push('-tag:v', 'hvc1');
  args.push('-movflags', '+faststart', '-f', 'mp4', '-y', tmpFile);
  logLine(job.vid, 'remux', '解密直拷参数就绪', {
    decryptionKey: play.contentKey ? 'present' : 'none', srcCodec: play.codec || '-', budgetMs: budget,
  });
  await runFfmpeg(job, 'remux', '解密直拷', args, budget);
}

/* 备路：解密 + 转码 H.264。省内存参数（v2.2 定版，勿回退）：
 * -threads 2、-preset ultrafast、输出缩放上限宽 720（竖屏即 720×1280）。 */
async function transcode(job, play, encFile, tmpFile, remainingMs) {
  const budget = Math.min(FFMPEG_TIMEOUT_MS, remainingMs());
  if (budget <= 0) throw prepareTimeoutError();
  const args = [];
  if (play.contentKey) args.push('-decryption_key', play.contentKey); // key 只进 argv，绝不进日志
  args.push('-v', 'error', '-i', encFile,
    '-vf', "scale=w='min(720,iw)':h=-2",
    '-threads', '2',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26',
    '-c:a', 'aac', '-b:a', '64k',
    '-movflags', '+faststart', '-f', 'mp4', '-y', tmpFile);
  logLine(job.vid, 'transcode', '转码参数就绪（省内存：threads=2 ultrafast scale<=720w）', {
    decryptionKey: play.contentKey ? 'present' : 'none', budgetMs: budget,
  });
  await runFfmpeg(job, 'transcode', '解密+转码', args, budget);
}

async function runJob(job) {
  const vid = job.vid;
  const startedAt = Date.now();
  job.startedAt = startedAt;
  const deadline = startedAt + PREPARE_TIMEOUT_MS;
  const remainingMs = () => deadline - Date.now();
  logLine(vid, 'prepare', `prepare 开始 mode=${job.mode} totalTimeoutMs=${PREPARE_TIMEOUT_MS}`);
  try {
    /* 阶段 1：取流（注册新设备 + 签名 video_model，失败换新设备重试 1 次） */
    setStage(job, 'fetch', '取流（注册新设备+签名）');
    const play = await fetchPlayWithRetry(vid, job, remainingMs);
    job.quality = play.quality || '';
    job.srcCodec = play.codec || '';

    /* 阶段 2：下载加密流 */
    if (remainingMs() <= 0) throw prepareTimeoutError();
    setStage(job, 'download', '下载加密流');
    const encFile = encFileOf(vid, job.mode);
    job.encBytes = await downloadEncrypted(vid, job, play, encFile, remainingMs);

    /* 阶段 3：解密（主路直拷 / 备路转码） */
    if (remainingMs() <= 0) throw prepareTimeoutError();
    const tmpFile = tmpFileOf(vid, job.mode);
    if (job.mode === 'transcode') {
      setStage(job, 'transcode', '解密+转码 H.264（备路）');
      await transcode(job, play, encFile, tmpFile, remainingMs);
    } else {
      setStage(job, 'remux', '解密直拷（HEVC 原画）');
      await remuxCopy(job, play, encFile, tmpFile, remainingMs);
    }
    if (!fs.existsSync(tmpFile) || fs.statSync(tmpFile).size <= 10000) {
      throw new Error('ffmpeg 产物缺失或过小');
    }
    fs.renameSync(tmpFile, finalFile(vid, job.mode));
    try { fs.unlinkSync(encFile); } catch {}
    job.outBytes = fs.statSync(finalFile(vid, job.mode)).size;

    job.status = 'ready';
    job.stageKey = 'done';
    job.stage = '完成';
    job.file = finalFile(vid, job.mode);
    logLine(vid, 'prepare', 'prepare 完成 ready', {
      mode: job.mode, totalMs: Date.now() - startedAt, attempts: job.attempts || 1,
      quality: job.quality || '-', outBytes: job.outBytes,
    });
  } catch (e) {
    const stageKey = job.stageKey || 'fetch';
    job.status = 'error';
    job.lastStage = stageKey;
    job.lastStageLabel = job.stage || '';
    job.error = e.message;
    job.code = e.code || '';
    job.signal = e.signal || '';
    job.reason = humanReason(stageKey, e);
    job.detail = errorDetail(e);
    job.failedAt = new Date().toISOString();
    job.failedAtTs = Date.now();
    job.cooldownUntil = job.failedAtTs + ERROR_COOLDOWN_MS;
    logLine(vid, 'prepare', 'prepare 失败', {
      mode: job.mode, totalMs: Date.now() - startedAt, failedStage: stageKey, attempts: job.attempts || 0,
      cooldownMs: ERROR_COOLDOWN_MS,
      reason: job.reason, ...errKv(e),
    });
  }
}

/* single-flight 入口：
 * - 缓存命中直接 ready；
 * - working 任务一律挂靠（只节流记进度日志），绝不新建；
 * - error 任务在冷却内一律返回旧任务、不重跑；冷却过或显式 retry=1 才重启。 */
function ensureJob(vid, mode, via, retry) {
  const key = jobKey(vid, mode);
  const file = finalFile(vid, mode);
  if (fs.existsSync(file) && fs.statSync(file).size > 10000) {
    if (!jobs.has(key)) {
      jobs.set(key, { vid, mode, status: 'ready', file, stage: '缓存命中', stageKey: 'cache', attempts: 0 });
      logLine(vid, 'cache', `缓存命中 via=${via}`, { mode, bytes: fs.statSync(file).size });
    }
    return jobs.get(key);
  }
  let job = jobs.get(key);
  if (job) {
    if (job.status === 'working') {
      const now = Date.now();
      if (!job.lastPollLog || now - job.lastPollLog > 30000) {
        job.lastPollLog = now;
        logLine(vid, job.stageKey || 'prepare', `prepare 进行中（挂靠现有任务）via=${via}`, {
          mode, stage: job.stage || '', elapsedMs: job.startedAt ? now - job.startedAt : 0,
        });
      }
      return job;
    }
    if (job.status === 'error') {
      const remain = (job.cooldownUntil || 0) - Date.now();
      if (remain > 0 && !retry) {
        const now = Date.now();
        if (!job.lastCoolLog || now - job.lastCoolLog > 30000) {
          job.lastCoolLog = now;
          logLine(vid, 'prepare', `失败冷却中，不重跑 via=${via}`, { mode, cooldownRemainMs: remain });
        }
        return job;
      }
      logLine(vid, 'prepare', `失败任务重启 via=${via}`, { mode, retry: retry ? 1 : 0, cooldownRemainMs: Math.max(0, remain) });
    }
    // ready 但文件丢失 → 落到下面重建
  }
  job = {
    vid, mode, status: 'working', stage: '排队', stageKey: 'queue',
    error: '', reason: '', detail: '', code: '', attempts: 0, createdAt: Date.now(),
  };
  jobs.set(key, job);
  logLine(vid, 'prepare', `prepare 收到请求 via=${via}（新建任务）`, { mode });
  runJob(job);
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
    if (p === '/healthz') return json(res, 200, { ok: true, version: '2.2.0', selfCheck, upstreamApprox: upstreamCount });
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
      const mode = normalizeMode(url.searchParams.get('mode'));
      const retry = url.searchParams.get('retry') === '1';
      const job = ensureJob(vid, mode, kind, retry);
      if (kind === 'prepare' || kind === 'status') {
        return json(res, 200, {
          vid, mode, status: job.status, stage: job.stage || '', stageKey: job.stageKey || '',
          error: job.error || '',
          reason: job.status === 'error' ? (job.reason || '') : '',
          detail: job.status === 'error' ? (job.detail || '') : '',
          lastStage: job.lastStage || '', code: job.code || '', signal: job.signal || '',
          cooldownMs: job.status === 'error' ? Math.max(0, (job.cooldownUntil || 0) - Date.now()) : 0,
          attempts: job.attempts || 0,
          elapsedMs: job.startedAt ? (job.status === 'working' ? Date.now() - job.startedAt : (job.failedAt ? new Date(job.failedAt).getTime() - job.startedAt : 0)) : 0,
          quality: job.quality || '', srcCodec: job.srcCodec || '', encBytes: job.encBytes || 0,
        });
      }
      if (job.status !== 'ready') return json(res, 425, { error: '尚未就绪', status: job.status, stage: job.stage || '', reason: job.reason || '', detail: job.detail || '', mode });
      return serveFile(req, res, job.file, vid);
    }
    return serveStatic(req, res, p);
  } catch (e) {
    logLine('', 'http', '请求处理异常', errKv(e));
    json(res, 500, { error: e.message });
  }
});
server.listen(PORT, HOST, () => {
  console.log(`[${new Date().toISOString()}] [hg-v2.2] vid=- stage=boot listening on ${HOST}:${PORT}, cache=${CACHE_DIR}, prepareTimeoutMs=${PREPARE_TIMEOUT_MS}, errorCooldownMs=${ERROR_COOLDOWN_MS}`);
  bootSelfCheck();
});
