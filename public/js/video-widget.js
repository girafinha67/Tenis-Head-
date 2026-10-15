/* Vídeo "Sobre nós": mini-card flutuante no canto inferior esquerdo.
   Toque no card → abre o vídeo grande (com som). O X do card esconde o widget nesta visita. */
(function () {
  'use strict';
  var KEY = 'tn_video_widget_closed';
  try { if (sessionStorage.getItem(KEY) === '1') return; } catch (e) {}

  var SRC = 'assets/video/sobre-nos.mp4';
  var POSTER = 'assets/video/sobre-nos.jpg';
  var TITLE = 'Sobre nós';

  var css = '\
.vw-mini{position:fixed;left:14px;bottom:calc(16px + env(safe-area-inset-bottom,0px));z-index:150;width:118px;border-radius:22px;overflow:hidden;\
  background:#000;border:1.5px solid #7a0f0b;box-shadow:0 10px 30px rgba(0,0,0,.45);cursor:pointer;\
  animation:vwIn .5s cubic-bezier(.22,.61,.36,1) both;font-family:"Space Grotesk",sans-serif}\
.vw-mini-head{display:flex;align-items:center;justify-content:space-between;gap:4px;height:38px;padding:0 6px 0 11px;color:#fff;\
  background:linear-gradient(100deg,#0a0a0a 0%,#0a0a0a 40%,#b80500 100%)}\
.vw-mini-title{font-weight:700;font-size:.78rem;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:58px}\
.vw-x{flex:none;width:24px;height:24px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;color:#fff;background:none;border:0;cursor:pointer;padding:0}\
.vw-x svg{width:16px;height:16px}\
.vw-mini-body{height:132px;display:flex;align-items:center;justify-content:center;background:#000}\
.vw-play{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;background:linear-gradient(135deg,#0a0a0a 0%,#e10600 100%);\
  box-shadow:0 0 0 0 rgba(225,6,0,.55);animation:vwPulse 2s infinite}\
.vw-play svg{width:22px;height:22px;margin-left:3px}\
@keyframes vwPulse{0%{box-shadow:0 0 0 0 rgba(225,6,0,.55)}70%{box-shadow:0 0 0 14px rgba(225,6,0,0)}100%{box-shadow:0 0 0 0 rgba(225,6,0,0)}}\
@keyframes vwIn{from{opacity:0;transform:translateY(24px) scale(.9)}to{opacity:1;transform:none}}\
@media(min-width:900px){.vw-mini{width:140px;left:24px;bottom:24px}.vw-mini-body{height:170px}.vw-mini-title{max-width:80px}}\
.vw-scrim{position:fixed;inset:0;z-index:320;background:rgba(0,0,0,.78);-webkit-backdrop-filter:blur(3px);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;\
  padding:calc(env(safe-area-inset-top,0px) + 16px) 16px calc(env(safe-area-inset-bottom,0px) + 16px);opacity:0;pointer-events:none;transition:opacity .3s}\
.vw-scrim.open{opacity:1;pointer-events:auto}\
.vw-card{width:min(100%,390px);max-height:100%;display:flex;flex-direction:column;border-radius:28px;overflow:hidden;background:#000;border:1.5px solid #7a0f0b;\
  box-shadow:0 20px 60px rgba(0,0,0,.6);transform:translateY(20px) scale(.96);transition:transform .35s cubic-bezier(.22,.61,.36,1);font-family:"Space Grotesk",sans-serif}\
.vw-scrim.open .vw-card{transform:none}\
.vw-head{flex:none;display:flex;align-items:center;justify-content:space-between;padding:14px 16px 14px 22px;color:#fff;\
  background:linear-gradient(100deg,#0a0a0a 0%,#0a0a0a 45%,#b80500 100%);border-bottom:3px solid #e10600}\
.vw-head h2{font-size:1.35rem;font-weight:700;letter-spacing:-.01em;color:#fff;line-height:1}\
.vw-close{width:42px;height:42px;border-radius:50%;background:#e10600;color:#fff;display:inline-flex;align-items:center;justify-content:center;border:0;cursor:pointer;transition:transform .2s}\
.vw-close:hover{transform:scale(1.08)}\
.vw-close svg{width:20px;height:20px}\
.vw-stage{position:relative;background:#000;min-height:0;display:flex}\
.vw-stage video{display:block;width:100%;height:auto;max-height:calc(100vh - 150px);max-height:calc(100dvh - 150px);object-fit:contain;background:#000}\
.vw-mute{position:absolute;top:16px;right:16px;width:50px;height:50px;border-radius:50%;background:rgba(255,255,255,.95);color:#0a0a0a;border:0;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.35)}\
.vw-mute svg{width:24px;height:24px}\
.vw-mute .off{display:none}.vw-mute.muted .on{display:none}.vw-mute.muted .off{display:block}\
.vw-bigplay{position:absolute;inset:0;margin:auto;width:72px;height:72px;border-radius:50%;border:0;color:#fff;background:linear-gradient(135deg,#0a0a0a 0%,#e10600 100%);display:none;align-items:center;justify-content:center;cursor:pointer}\
.vw-bigplay svg{width:32px;height:32px;margin-left:4px}\
.vw-stage.paused .vw-bigplay{display:flex}\
@media(prefers-reduced-motion:reduce){.vw-mini,.vw-play{animation:none}.vw-card{transition:none}}';

  var X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
  var SPK_ON = '<svg class="on" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z" fill="currentColor"/><path d="M15.5 8.5a5 5 0 010 7M18.5 5.5a9 9 0 010 13"/></svg>';
  var SPK_OFF = '<svg class="off" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H3v6h3l5 4z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6"/></svg>';

  function init() {
    var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

    var mini = document.createElement('div');
    mini.className = 'vw-mini'; mini.setAttribute('role', 'button'); mini.setAttribute('tabindex', '0'); mini.setAttribute('aria-label', 'Assistir vídeo: ' + TITLE);
    mini.innerHTML = '<div class="vw-mini-head"><span class="vw-mini-title">' + TITLE + '</span><button class="vw-x" aria-label="Fechar vídeo">' + X + '</button></div>' +
      '<div class="vw-mini-body"><span class="vw-play">' + PLAY + '</span></div>';
    document.body.appendChild(mini);

    var scrim = document.createElement('div');
    scrim.className = 'vw-scrim'; scrim.setAttribute('role', 'dialog'); scrim.setAttribute('aria-modal', 'true'); scrim.setAttribute('aria-label', TITLE);
    scrim.innerHTML = '<div class="vw-card"><div class="vw-head"><h2>' + TITLE.replace('nós', 'Nós') + '</h2><button class="vw-close" aria-label="Fechar">' + X + '</button></div>' +
      '<div class="vw-stage paused"><video playsinline preload="none" poster="' + POSTER + '" loop></video>' +
      '<button class="vw-mute" aria-label="Som">' + SPK_ON + SPK_OFF + '</button>' +
      '<button class="vw-bigplay" aria-label="Reproduzir">' + PLAY + '</button></div></div>';
    document.body.appendChild(scrim);

    var video = scrim.querySelector('video'), stage = scrim.querySelector('.vw-stage'), mute = scrim.querySelector('.vw-mute');
    function syncMute() { mute.classList.toggle('muted', video.muted); }
    function syncPaused() { stage.classList.toggle('paused', video.paused); }
    video.addEventListener('play', syncPaused); video.addEventListener('pause', syncPaused);

    function open() {
      if (!video.getAttribute('src')) video.src = SRC;
      scrim.classList.add('open'); mini.style.display = 'none';
      document.documentElement.style.overflow = 'hidden';
      video.muted = false; syncMute();
      var p = video.play();
      if (p && p.catch) p.catch(function () { video.muted = true; syncMute(); video.play().catch(function () {}); });
    }
    function close() {
      scrim.classList.remove('open'); video.pause();
      document.documentElement.style.overflow = '';
      mini.style.display = '';
    }
    function dismiss(e) {
      e.stopPropagation();
      try { sessionStorage.setItem(KEY, '1'); } catch (er) {}
      mini.remove();
    }

    mini.addEventListener('click', open);
    mini.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    mini.querySelector('.vw-x').addEventListener('click', dismiss);
    scrim.querySelector('.vw-close').addEventListener('click', close);
    scrim.addEventListener('click', function (e) { if (e.target === scrim) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && scrim.classList.contains('open')) close(); });
    mute.addEventListener('click', function () { video.muted = !video.muted; syncMute(); });
    video.addEventListener('click', function () { video.paused ? video.play() : video.pause(); });
    scrim.querySelector('.vw-bigplay').addEventListener('click', function () { video.play(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
