/* HNM Live + Premiere Banner — shared across the network */
(function () {
  var SUPABASE_URL = "https://knttdoasnhqwkfzdgorm.supabase.co";
  var SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtudHRkb2Fzbmhxd2tmemRnb3JtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg1NTE0ODMsImV4cCI6MjA5NDEyNzQ4M30.zcbRTPAToBaSgekIUnDPzq8U3XqMWJBlkhXnUNw1Kqk";
  var POLL_MS = 60000;

  var css = '.hnm-live-toast{position:fixed;bottom:20px;right:20px;max-width:360px;background:#0a0a0a;border:1px solid rgba(245,241,235,0.15);border-left:3px solid #f48022;padding:16px 20px;box-shadow:0 8px 32px rgba(0,0,0,0.5);font-family:"Geist",-apple-system,sans-serif;color:#f5f1eb;z-index:9999;transform:translateY(120%);transition:transform 0.4s ease;cursor:pointer}'
    + '.hnm-live-toast.show{transform:translateY(0)}'
    + '.hnm-live-toast.premiere{border-left-color:#20557b}'
    + '.hnm-live-head{display:flex;align-items:center;gap:8px;font-family:"Red Hat Mono",ui-monospace,monospace;font-size:0.7rem;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;color:#f48022;margin-bottom:8px}'
    + '.hnm-live-toast.premiere .hnm-live-head{color:#5fa1d6}'
    + '.hnm-live-dot{width:8px;height:8px;border-radius:50%;background:#f48022;animation:hnm-pulse 1.5s infinite}'
    + '.hnm-live-toast.premiere .hnm-live-dot{background:#5fa1d6;animation:none}'
    + '@keyframes hnm-pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.3;transform:scale(1.3)}}'
    + '.hnm-live-x{margin-left:auto;background:none;border:none;color:rgba(245,241,235,0.4);font-size:1.3rem;cursor:pointer;padding:0;line-height:1;font-family:inherit}'
    + '.hnm-live-x:hover{color:#f5f1eb}'
    + '.hnm-live-title{font-size:0.95rem;font-weight:600;margin-bottom:10px;line-height:1.3}'
    + '.hnm-live-cta{font-family:"Red Hat Mono",ui-monospace,monospace;font-size:0.7rem;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:#f48022}'
    + '.hnm-live-toast.premiere .hnm-live-cta{color:#5fa1d6}';

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  var currentToast = null;
  var currentVideoId = null;

  function dismissed(id) {
    try { return localStorage.getItem('hnm_dismissed_' + id) === '1'; }
    catch (e) { return false; }
  }
  function setDismissed(id) {
    try { localStorage.setItem('hnm_dismissed_' + id, '1'); } catch (e) {}
  }
  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function removeToast() {
    if (!currentToast) return;
    currentToast.classList.remove('show');
    var t = currentToast;
    setTimeout(function () { if (t && t.parentNode) t.parentNode.removeChild(t); }, 400);
    currentToast = null;
  }

  function showToast(status) {
    if (status.video_id === currentVideoId && currentToast) return;
    if (dismissed(status.video_id)) return;
    removeToast();
    currentVideoId = status.video_id;

    var watchUrl = 'https://www.youtube.com/watch?v=' + status.video_id;
    var header, cta, isPremiere = false;
    if (status.event_type === 'live') {
      header = 'LIVE NOW';
      cta = 'Watch on YouTube →';
    } else if (status.event_type === 'premiere' || status.event_type === 'scheduled') {
      var mins = Math.max(0, Math.round((new Date(status.scheduled_start).getTime() - Date.now()) / 60000));
      header = (status.event_type === 'premiere' ? 'PREMIERE' : 'STREAMING') + ' IN ' + mins + (mins === 1 ? ' MIN' : ' MINS');
      cta = 'Set reminder on YouTube →';
      isPremiere = true;
    } else {
      return;
    }

    var toast = document.createElement('div');
    toast.className = 'hnm-live-toast' + (isPremiere ? ' premiere' : '');
    toast.innerHTML =
      '<div class="hnm-live-head">' +
        '<span class="hnm-live-dot"></span>' +
        '<span>' + escapeHtml(header) + '</span>' +
        '<button class="hnm-live-x" aria-label="Dismiss">×</button>' +
      '</div>' +
      '<div class="hnm-live-title">' + escapeHtml(status.title || 'New content from @JamesHicks') + '</div>' +
      '<div class="hnm-live-cta">' + cta + '</div>';

    toast.addEventListener('click', function (e) {
      if (e.target.classList.contains('hnm-live-x')) {
        e.stopPropagation();
        setDismissed(status.video_id);
        removeToast();
        return;
      }
      window.open(watchUrl, '_blank', 'noopener');
    });

    document.body.appendChild(toast);
    currentToast = toast;
    setTimeout(function () { toast.classList.add('show'); }, 80);
  }

  async function poll() {
    try {
      var res = await fetch(SUPABASE_URL + '/rest/v1/live_status?id=eq.1&select=*', {
        headers: {
          'apikey': SUPABASE_ANON_KEY,
          'Authorization': 'Bearer ' + SUPABASE_ANON_KEY
        }
      });
      if (!res.ok) return;
      var rows = await res.json();
      var status = rows && rows[0];
      if (!status) return;
      if (status.event_type === 'none') {
        currentVideoId = null;
        removeToast();
      } else if (status.is_live || status.is_premiere_soon) {
        showToast(status);
      }
    } catch (err) { /* silent — never disrupt the page */ }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', poll);
  else poll();
  setInterval(poll, POLL_MS);
})();
