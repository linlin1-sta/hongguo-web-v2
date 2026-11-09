'use strict';
const view = document.getElementById('view');
const player = document.getElementById('player');
const video = document.getElementById('video');
const playStatus = document.getElementById('playStatus');
const epBar = document.getElementById('epBar');
let current = null; // {series, epIndex}
let pollTimer = null;
let playMode = 'copy'; // v2.2：'copy'=解密直拷(HEVC 主路) | 'transcode'=转码(H.264 备路)
let fallbackUsed = false; // 本集是否已自动切过转码备路，防 error 事件死循环

function esc(s){return String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function getJSON(u){const r=await fetch(u);const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||('HTTP '+r.status));return j}

function renderCards(items){
  view.innerHTML = '<div class="grid">' + items.map(it =>
    `<div class="card" data-id="${esc(it.id)}"><img loading="lazy" src="${esc(it.cover)}" alt=""><div class="t">${esc(it.title)}</div>${it.badge?`<div class="b">${esc(it.badge)}</div>`:''}</div>`
  ).join('') + '</div>';
  view.querySelectorAll('.card').forEach(c=>c.addEventListener('click',()=>openSeries(c.dataset.id)));
}

async function loadHome(){
  view.innerHTML='<div class="msg">加载推荐中…</div>';
  try{ const j=await getJSON('/api/home?page=1'); renderCards(j.items||[]); }
  catch(e){ view.innerHTML=`<div class="msg err">首页加载失败：${esc(e.message)}</div>`; }
}

async function openSeries(id){
  view.innerHTML='<div class="msg">加载详情中…</div>';
  try{
    const s=await getJSON('/api/series/'+id);
    current={series:s, epIndex:0};
    view.innerHTML=`<div class="detail">
      ${s.cover?`<img src="${esc(s.cover)}" alt="">`:''}
      <h3>${esc(s.title)}</h3><p>${esc(s.description||'')}</p>
      <div class="eps">${s.episodes.map((e,i)=>`<button data-i="${i}">第${e.number}集</button>`).join('')}</div>
      <p><button onclick="loadHome()">← 返回首页</button></p></div>`;
    view.querySelectorAll('.eps button').forEach(b=>b.addEventListener('click',()=>playEpisode(Number(b.dataset.i))));
    window.scrollTo(0,0);
  }catch(e){ view.innerHTML=`<div class="msg err">详情加载失败：${esc(e.message)}</div>`; }
}

async function playEpisode(i, mode){
  if(!current) return;
  mode = mode==='transcode' ? 'transcode' : 'copy';
  playMode = mode;
  if(mode==='copy') fallbackUsed=false; else fallbackUsed=true;
  current.epIndex=i;
  const ep=current.series.episodes[i];
  player.classList.remove('hidden');
  epBar.innerHTML=current.series.episodes.map((e,j)=>`<button data-i="${j}" class="${j===i?'on':''}">第${e.number}集</button>`).join('');
  epBar.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>playEpisode(Number(b.dataset.i))));
  playStatus.textContent = mode==='transcode'
    ? `正在准备第${ep.number}集（转码备路：取流→解密→转 H.264，较慢）…`
    : `正在准备第${ep.number}集（取流→解密直拷，首次几秒）…`;
  video.removeAttribute('src'); video.load();
  clearInterval(pollTimer);
  const pollStart=Date.now();
  const tick=async()=>{
    try{
      const st=await getJSON(`/api/prepare/${ep.id}?mode=${mode}`);
      if(st.status==='ready'){
        clearInterval(pollTimer);
        playStatus.textContent=`第${ep.number}集 · ${st.quality||''} 已就绪（${mode==='transcode'?'转码 H.264':'解密直拷 HEVC'}）`;
        video.src=`/api/video/${ep.id}?mode=${mode}`;
        video.play().catch(()=>{});
      }else if(st.status==='error'){
        clearInterval(pollTimer);
        // v2.1：失败原因优先用人话 reason，detail 是技术摘要（错误名/消息/码），与 reason 重复时不重复显示
        const reason=st.reason||st.error||'未知错误';
        const detail=st.detail && st.detail!==reason ? `（${st.detail}）` : '';
        const cool=st.cooldownMs>0 ? `，${Math.ceil(st.cooldownMs/1000)} 秒后重开本集可重试` : '';
        playStatus.textContent='播放准备失败：'+reason+detail+cool;
      }else if(Date.now()-pollStart>300000){
        clearInterval(pollTimer);
        playStatus.textContent=`第${ep.number}集准备超时（等了5分钟还在「${st.stage||st.status}」），请关掉重开这一集试试`;
      }else{
        const secs=st.elapsedMs?Math.round(st.elapsedMs/1000):Math.round((Date.now()-pollStart)/1000);
        playStatus.textContent=`正在准备第${ep.number}集（${mode==='transcode'?'转码中':'解密直拷'}）：${st.stage||st.status}…（已等 ${secs} 秒）`;
      }
    }catch(e){ /* 继续轮询 */ }
  };
  tick(); pollTimer=setInterval(tick,2000);
}

document.getElementById('closePlayer').addEventListener('click',()=>{
  clearInterval(pollTimer); video.pause(); video.removeAttribute('src'); video.load();
  player.classList.add('hidden');
});
document.getElementById('searchForm').addEventListener('submit',async(e)=>{
  e.preventDefault();
  const q=document.getElementById('q').value.trim(); if(!q) return;
  view.innerHTML='<div class="msg">搜索中…</div>';
  try{ const j=await getJSON('/api/search?q='+encodeURIComponent(q)); renderCards(j.items||[]); if(!(j.items||[]).length) view.innerHTML='<div class="msg">没有搜到结果</div>'; }
  catch(err){ view.innerHTML=`<div class="msg err">搜索失败：${esc(err.message)}</div>`; }
});
video.addEventListener('ended',()=>{ if(current && current.epIndex+1<current.series.episodes.length) playEpisode(current.epIndex+1); });
/* v2.2 备路触发：直拷 HEVC 文件在当前浏览器播不了（error 事件）时，
 * 自动改走 prepare?mode=transcode 重新准备 H.264；只切一次，防死循环。
 * 注意：removeAttribute('src') 后 currentSrc 为空，不会误触发。 */
video.addEventListener('error',()=>{
  if(player.classList.contains('hidden')||!current) return;
  if(!video.currentSrc || !video.currentSrc.includes('/api/video/')) return;
  if(playMode==='copy' && !fallbackUsed){
    fallbackUsed=true;
    playStatus.textContent='当前浏览器放不了 HEVC 直拷文件，自动切换到 H.264 转码备路…';
    playEpisode(current.epIndex,'transcode');
  }else if(playMode==='transcode'){
    playStatus.textContent='播放失败：转码后的 H.264 文件也无法播放';
  }
});
loadHome();
