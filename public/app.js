'use strict';
const view = document.getElementById('view');
const player = document.getElementById('player');
const video = document.getElementById('video');
const playStatus = document.getElementById('playStatus');
const epBar = document.getElementById('epBar');
let current = null; // {series, epIndex}
let pollTimer = null;

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

async function playEpisode(i){
  if(!current) return;
  current.epIndex=i;
  const ep=current.series.episodes[i];
  player.classList.remove('hidden');
  epBar.innerHTML=current.series.episodes.map((e,j)=>`<button data-i="${j}" class="${j===i?'on':''}">第${e.number}集</button>`).join('');
  epBar.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>playEpisode(Number(b.dataset.i))));
  playStatus.textContent=`正在准备第${ep.number}集（取流→解密→转码，首次约需十几秒）…`;
  video.removeAttribute('src'); video.load();
  clearInterval(pollTimer);
  const tick=async()=>{
    try{
      const st=await getJSON('/api/prepare/'+ep.id);
      if(st.status==='ready'){
        clearInterval(pollTimer);
        playStatus.textContent=`第${ep.number}集 · ${st.quality||''} 已就绪`;
        video.src='/api/video/'+ep.id;
        video.play().catch(()=>{});
      }else if(st.status==='error'){
        clearInterval(pollTimer);
        playStatus.textContent='播放准备失败：'+(st.error||'未知错误');
      }else{
        playStatus.textContent=`正在准备第${ep.number}集：${st.stage||st.status}…`;
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
loadHome();
