/* 红果短剧手机网页版 v2 — 单服务后端
 * 数据面：首页/详情代理 hongguoTV bridge（同容器 127.0.0.1:8787，仅用 home/series）
 * 搜索面：hongguo-drama 路 A signedSearchRequest（hongguo-app-search.searchApp）
 * 播放面：路 A fetchAppPlayUrl(vid) → CENC HEVC 流 + contentKey
 *         → 服务端下载加密文件 → ffmpeg -decryption_key 解密并转码 H.264 MP4 → 本地缓存后 Range 供播
 * 上游模块 GPL-3.0，声明见 native/*.js 文件头与 LICENSE-hongguo-drama。
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

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let upstreamCount = 0; // 本地诊断用：粗略统计本服务发出的上游请求

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/* ---------- 数据面：代理 bridge（仅 home / series） ---------- */
async function proxyBridge(req, res, bridgePath) {
  try {
    upstreamCount++;
    const r = await fetch(BRIDGE_ORIGIN + bridgePath, { signal: AbortSignal.timeout(30000) });
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (e) { json(res, 502, { error: '目录服务暂不可用: ' + e.message }); }
}

/* ---------- 搜索面：路 A ---------- */
async function handleSearch(req, res, q) {
  try {
    upstreamCount += 2; // 注册（缓存后多为0）+ 搜索请求，粗略计
    const out = await searchApp(q, { page: 1, deadline: Date.now() + 25000 });
    const items = out.results.map(r => ({
      id: r.series_id, title: r.series_title, cover: r.cover || '',
      description: r.description || '', badge: r.episode_count ? `全${r.episode_count}集` : '',
    }));
    json(res, 200, { items, page: 1 });
  } catch (e) { json(res, 502, { error: '搜索暂不可用: ' + e.message, code: e.code || '' }); }
}

/* ---------- 播放面：取流 → 下载 → 解密转码 → 缓存 ---------- */
const jobs = new Map(); // vid -> {status, file, error, quality, codec}
function finalFile(vid) { return path.join(CACHE_DIR, `${vid}.mp4`); }

async function runJob(vid) {
  const job = jobs.get(vid);
  try {
    job.stage = '取流（注册新设备+签名）';
    upstreamCount += 2;
    const play = await fetchAppPlayUrl(vid, {});
    if (!play.url) throw new Error('未拿到播放地址');
    job.quality = play.quality || ''; job.srcCodec = play.codec || '';
    job.stage = '下载加密流';
    const encFile = path.join(CACHE_DIR, `${vid}.enc.mp4`);
    upstreamCount++;
    const resp = await fetch(play.url, { headers: { 'User-Agent': play.userAgent || '' }, signal: AbortSignal.timeout(120000) });
    if (!resp.ok) throw new Error('媒体下载 HTTP ' + resp.status);
    const buf = Buffer.from(await resp.arrayBuffer());
    fs.writeFileSync(encFile, buf);
    job.encBytes = buf.length;
    job.stage = '解密+转码 H.264';
    const tmpFile = path.join(CACHE_DIR, `${vid}.tmp.mp4`);
    const args = [];
    if (play.contentKey) args.push('-decryption_key', play.contentKey);
    args.push('-v', 'error', '-i', encFile,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26',
      '-c:a', 'aac', '-b:a', '64k',
      '-movflags', '+faststart', '-f', 'mp4', '-y', tmpFile);
    await new Promise((resolve, reject) => {
      const ff = spawn('ffmpeg', args);
      let err = '';
      ff.stderr.on('data', d => { err += d.toString().slice(-2000); });
      ff.on('error', reject);
      ff.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg 退出码 ' + code + ': ' + err.slice(-500))));
    });
    fs.renameSync(tmpFile, finalFile(vid));
    try { fs.unlinkSync(encFile); } catch {}
    job.status = 'ready'; job.stage = '完成'; job.file = finalFile(vid);
  } catch (e) {
    job.status = 'error'; job.error = e.message; job.code = e.code || '';
  }
}

function ensureJob(vid) {
  const file = finalFile(vid);
  if (fs.existsSync(file) && fs.statSync(file).size > 10000) {
    if (!jobs.has(vid)) jobs.set(vid, { status: 'ready', file, stage: '缓存命中' });
    return jobs.get(vid);
  }
  let job = jobs.get(vid);
  if (!job || job.status === 'error') {
    job = { status: 'working', stage: '排队', error: '' };
    jobs.set(vid, job);
    runJob(vid);
  }
  return job;
}

/* ---------- 文件 Range 供播 ---------- */
function serveFile(req, res, file) {
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    let start = m[1] ? Number(m[1]) : 0;
    let end = m[2] ? Number(m[2]) : size - 1;
    if (start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); return res.end(); }
    end = Math.min(end, size - 1);
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    fs.createReadStream(file, { start, end }).pipe(res);
  } else {
    headers['Content-Length'] = size;
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
    if (p === '/healthz') return json(res, 200, { ok: true, upstreamApprox: upstreamCount });
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
      const job = ensureJob(vid);
      if (kind === 'prepare' || kind === 'status') {
        return json(res, 200, { vid, status: job.status, stage: job.stage || '', error: job.error || '', quality: job.quality || '', srcCodec: job.srcCodec || '', encBytes: job.encBytes || 0 });
      }
      if (job.status !== 'ready') return json(res, 425, { error: '尚未就绪', status: job.status, stage: job.stage || '' });
      return serveFile(req, res, job.file);
    }
    return serveStatic(req, res, p);
  } catch (e) { json(res, 500, { error: e.message }); }
});
server.listen(PORT, HOST, () => console.log(`[v2] listening on ${HOST}:${PORT}, cache=${CACHE_DIR}`));
