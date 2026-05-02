/**
 * Dashboard — Single-file HTML dashboard for live agent observation.
 * No build step — everything is inline CSS/JS.
 *
 * Three-panel layout:
 *   - Left (60%): Live browser feed (CDP screencast frames)
 *   - Right-top (40%): Agent thought/event stream
 *   - Right-bottom: Action log + criteria checklist
 *
 * Control bar: [Pause] [Resume] [Take Over] [Release]
 */

export function getDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PixelCheck - Live Observer</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    background: #0d1117;
    color: #c9d1d9;
    height: 100vh;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* Control Bar */
  .control-bar {
    background: #161b22;
    border-bottom: 1px solid #30363d;
    padding: 8px 16px;
    display: flex;
    align-items: center;
    gap: 12px;
    flex-shrink: 0;
  }
  .control-bar h1 {
    font-size: 14px;
    font-weight: 600;
    color: #58a6ff;
    margin-right: auto;
  }
  .status-badge {
    padding: 2px 10px;
    border-radius: 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-running { background: #0d419d; color: #58a6ff; }
  .status-paused { background: #4d2d00; color: #d29922; }
  .status-takeover { background: #5a1e02; color: #f85149; }
  .status-complete { background: #0e3a16; color: #3fb950; }
  .status-failed { background: #5a1e02; color: #f85149; }

  .btn {
    padding: 4px 14px;
    border: 1px solid #30363d;
    border-radius: 6px;
    background: #21262d;
    color: #c9d1d9;
    font-size: 12px;
    cursor: pointer;
    font-family: inherit;
  }
  .btn:hover { background: #30363d; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn-warn { border-color: #d29922; color: #d29922; }
  .btn-danger { border-color: #f85149; color: #f85149; }

  .cost-display {
    font-size: 12px;
    color: #8b949e;
  }

  /* Main Layout */
  .main {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* Left: Browser Feed */
  .feed-panel {
    flex: 0 0 60%;
    background: #010409;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    position: relative;
  }
  .feed-panel img {
    max-width: 100%;
    max-height: 100%;
    object-fit: contain;
  }
  .feed-placeholder {
    color: #484f58;
    font-size: 14px;
    text-align: center;
  }
  .feed-url {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 4px 12px;
    background: rgba(13, 17, 23, 0.85);
    font-size: 11px;
    color: #8b949e;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Right panels */
  .right-panels {
    flex: 0 0 40%;
    display: flex;
    flex-direction: column;
    border-left: 1px solid #30363d;
  }

  /* Event Stream */
  .event-panel {
    flex: 1;
    overflow-y: auto;
    padding: 8px;
    border-bottom: 1px solid #30363d;
  }
  .event-panel h2 {
    font-size: 12px;
    color: #8b949e;
    padding: 4px 0 8px 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .event-entry {
    padding: 3px 0;
    font-size: 12px;
    line-height: 1.5;
    border-bottom: 1px solid #21262d;
  }
  .event-time { color: #484f58; }
  .event-tag {
    display: inline-block;
    padding: 0 5px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    margin-right: 4px;
  }
  .tag-plan { background: #3b1f63; color: #d2a8ff; }
  .tag-action { background: #0d419d; color: #79c0ff; }
  .tag-think { background: #21262d; color: #8b949e; }
  .tag-step { background: #0e3a16; color: #3fb950; }
  .tag-fail { background: #5a1e02; color: #f85149; }
  .tag-criteria { background: #1a4a1a; color: #3fb950; }
  .tag-convergence { background: #4d2d00; color: #d29922; }

  .event-text { color: #c9d1d9; }

  /* Action Log */
  .action-panel {
    flex: 0 0 35%;
    overflow-y: auto;
    padding: 8px;
  }
  .action-panel h2 {
    font-size: 12px;
    color: #8b949e;
    padding: 4px 0 8px 0;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .action-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .action-table th {
    text-align: left;
    color: #8b949e;
    font-weight: 500;
    padding: 4px 6px;
    border-bottom: 1px solid #30363d;
  }
  .action-table td {
    padding: 3px 6px;
    border-bottom: 1px solid #21262d;
  }
  .st-pass { color: #3fb950; }
  .st-warn { color: #d29922; }
  .st-fail { color: #f85149; }
  .st-skip { color: #484f58; }

  /* Timeline */
  .timeline-panel {
    background: #0d1117;
    border-top: 1px solid #30363d;
    padding: 8px 12px;
    max-height: 180px;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    gap: 6px;
    flex-shrink: 0;
  }
  .timeline-panel h2 {
    font-size: 11px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .timeline-strip {
    display: flex;
    gap: 4px;
    overflow-x: auto;
    padding: 4px 0 8px 0;
  }
  .timeline-step {
    flex: 0 0 auto;
    min-width: 32px;
    height: 44px;
    border-radius: 4px;
    border: 1px solid #30363d;
    background: #161b22;
    padding: 4px 6px;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    transition: transform .08s ease;
    font-size: 10px;
  }
  .timeline-step:hover { transform: translateY(-1px); border-color: #58a6ff; }
  .timeline-step.selected { border-color: #58a6ff; box-shadow: 0 0 0 1px #58a6ff inset; }
  .timeline-step .tl-seq { color: #8b949e; font-weight: 600; }
  .timeline-step .tl-label { color: #c9d1d9; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 140px; }
  .timeline-step.ok { border-left: 3px solid #3fb950; }
  .timeline-step.warn { border-left: 3px solid #d29922; }
  .timeline-step.fail { border-left: 3px solid #f85149; }
  .timeline-step.pending { border-left: 3px solid #8b949e; opacity: 0.7; }
  .timeline-step.plan { background: #1c1530; }
  .timeline-step.criterion { background: #0d2b1a; }
  .timeline-step.session { background: #0d1f33; }

  /* Detail drawer */
  .detail-drawer {
    position: fixed;
    right: 0; top: 44px; bottom: 0;
    width: 420px;
    background: #161b22;
    border-left: 1px solid #30363d;
    padding: 16px;
    overflow-y: auto;
    transform: translateX(100%);
    transition: transform .15s ease;
    z-index: 50;
  }
  .detail-drawer.open { transform: translateX(0); }
  .detail-drawer h3 {
    font-size: 13px;
    color: #58a6ff;
    margin-bottom: 10px;
    display: flex;
    justify-content: space-between;
  }
  .detail-drawer .close-btn {
    cursor: pointer;
    color: #8b949e;
    background: none;
    border: none;
    font-size: 16px;
  }
  .detail-drawer pre {
    font-size: 11px;
    background: #0d1117;
    padding: 8px;
    border-radius: 4px;
    overflow-x: auto;
    white-space: pre-wrap;
    word-break: break-word;
    color: #c9d1d9;
  }
  .detail-drawer .detail-row { margin-bottom: 10px; }
  .detail-drawer .detail-label {
    font-size: 10px;
    color: #8b949e;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 3px;
  }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
</style>
</head>
<body>

<div class="control-bar">
  <h1>PixelCheck</h1>
  <span id="status" class="status-badge status-running">Connecting...</span>
  <span id="cost" class="cost-display">$0.000</span>
  <button class="btn" id="btnPause" onclick="send('pause')">Pause</button>
  <button class="btn" id="btnResume" onclick="send('resume')" disabled>Resume</button>
  <button class="btn btn-warn" id="btnTakeover" onclick="send('takeover')">Take Over</button>
  <button class="btn btn-danger" id="btnRelease" onclick="send('release')" disabled>Release</button>
  <a class="btn" style="text-decoration:none" href="/grid" target="_blank">Grid ▸</a>
</div>

<div class="main">
  <div class="feed-panel">
    <img id="feed" style="display:none" alt="Live browser feed">
    <div id="feedPlaceholder" class="feed-placeholder">Waiting for browser frames...</div>
    <div id="feedUrl" class="feed-url" style="display:none"></div>
  </div>

  <div class="right-panels">
    <div class="event-panel" id="eventPanel">
      <h2>Event Stream</h2>
      <div id="events"></div>
    </div>

    <div class="action-panel">
      <h2>Actions</h2>
      <table class="action-table">
        <thead><tr><th>#</th><th>Type</th><th>Status</th><th>Time</th></tr></thead>
        <tbody id="actions"></tbody>
      </table>
    </div>
  </div>
</div>

<div class="timeline-panel">
  <h2>
    <span>Timeline</span>
    <span id="tlCount" style="color:#484f58">0 steps</span>
    <span style="flex:1"></span>
    <button class="btn" style="padding:2px 8px;font-size:10px" onclick="refreshTimeline()">Refresh</button>
  </h2>
  <div class="timeline-strip" id="timelineStrip"></div>
</div>

<div class="detail-drawer" id="detailDrawer">
  <h3>
    <span id="detailTitle">Step</span>
    <button class="close-btn" onclick="closeDetail()">×</button>
  </h3>
  <div id="detailBody"></div>
</div>

<script>
const wsUrl = 'ws://' + location.host + '/ws';
let ws;
let actionCount = 0;

function connect() {
  ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    setStatus('running', 'Connected');
  };

  ws.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) {
      // Binary = screencast frame
      const blob = new Blob([evt.data], { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      const img = document.getElementById('feed');
      const old = img.src;
      img.src = url;
      img.style.display = 'block';
      document.getElementById('feedPlaceholder').style.display = 'none';
      if (old && old.startsWith('blob:')) URL.revokeObjectURL(old);
      return;
    }

    // Text = JSON message
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'init') {
        handleInit(msg.payload);
      } else if (msg.type === 'event') {
        handleEvent(msg.payload);
      }
    } catch(e) {}
  };

  ws.onclose = () => {
    setStatus('complete', 'Disconnected');
    setTimeout(connect, 3000);
  };
}

function send(command) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ command }));
  }
}

function handleInit(payload) {
  if (payload.state) {
    setStatus(payload.state.status, payload.state.status);
    document.getElementById('cost').textContent = '$' + (payload.state.cost_usd || 0).toFixed(3);
  }
  if (payload.recentEvents) {
    for (const evt of payload.recentEvents) {
      handleEvent(evt);
    }
  }
}

function handleEvent(evt) {
  // Update status badge
  if (evt.type === 'session:start') setStatus('running', 'Running');
  if (evt.type === 'session:end') setStatus(evt.data.status === 'fail' ? 'failed' : 'complete', evt.data.status || 'complete');
  if (evt.type === 'pause:requested') setStatus('paused', 'Paused');
  if (evt.type === 'pause:resumed') setStatus('running', 'Running');
  if (evt.type === 'takeover:start') setStatus('takeover', 'Takeover');
  if (evt.type === 'takeover:end') setStatus('running', 'Running');

  // Update cost
  if (evt.data && evt.data.cost_usd !== undefined) {
    document.getElementById('cost').textContent = '$' + Number(evt.data.cost_usd).toFixed(3);
  }

  // Add to event stream
  addEventEntry(evt);

  // Add to action log
  if (evt.type.startsWith('step:') || evt.type.startsWith('action:')) {
    addActionRow(evt);
  }
}

function addEventEntry(evt) {
  const container = document.getElementById('events');
  const el = document.createElement('div');
  el.className = 'event-entry';

  const time = new Date(evt.timestamp).toLocaleTimeString();
  const tagClass = getTagClass(evt.type);
  const tagLabel = getTagLabel(evt.type);
  const text = getEventText(evt);

  el.innerHTML = '<span class="event-time">' + time + '</span> '
    + '<span class="event-tag ' + tagClass + '">' + tagLabel + '</span>'
    + '<span class="event-text">' + escapeHtml(text) + '</span>';

  container.appendChild(el);

  // Auto-scroll
  const panel = document.getElementById('eventPanel');
  panel.scrollTop = panel.scrollHeight;
}

function addActionRow(evt) {
  if (evt.type !== 'step:complete' && evt.type !== 'step:failed'
      && evt.type !== 'action:complete' && evt.type !== 'action:failed') return;

  actionCount++;
  const tbody = document.getElementById('actions');
  const tr = document.createElement('tr');
  const status = (evt.data.status || (evt.type.includes('failed') ? 'fail' : 'pass'));
  const stClass = 'st-' + status;

  tr.innerHTML = '<td>' + actionCount + '</td>'
    + '<td>' + escapeHtml(String(evt.data.step_type || evt.data.action_type || '?')) + '</td>'
    + '<td class="' + stClass + '">' + escapeHtml(status) + '</td>'
    + '<td>' + (evt.data.duration_ms || 0) + 'ms</td>';

  tbody.appendChild(tr);
}

function setStatus(status, label) {
  const el = document.getElementById('status');
  el.className = 'status-badge status-' + status;
  el.textContent = label.charAt(0).toUpperCase() + label.slice(1);

  // Update button states
  const isPaused = status === 'paused';
  const isTakeover = status === 'takeover';
  const isRunning = status === 'running';
  document.getElementById('btnPause').disabled = !isRunning;
  document.getElementById('btnResume').disabled = !isPaused;
  document.getElementById('btnTakeover').disabled = !isRunning && !isPaused;
  document.getElementById('btnRelease').disabled = !isTakeover;
}

function getTagClass(type) {
  if (type.startsWith('plan:')) return 'tag-plan';
  if (type.startsWith('action:') || type.startsWith('step:')) {
    return type.includes('fail') ? 'tag-fail' : 'tag-step';
  }
  if (type.startsWith('thought:')) return 'tag-think';
  if (type.startsWith('criterion:')) return 'tag-criteria';
  if (type.startsWith('convergence:')) return 'tag-convergence';
  return 'tag-action';
}

function getTagLabel(type) {
  const parts = type.split(':');
  return (parts[1] || parts[0]).toUpperCase();
}

function getEventText(evt) {
  const d = evt.data || {};
  switch (evt.type) {
    case 'session:start': return (d.scenario_id || '') + ' x ' + (d.persona_id || '');
    case 'session:end': return 'Status: ' + (d.status || '?') + ' Score: ' + (d.overall_score !== undefined ? Number(d.overall_score).toFixed(1) : '?');
    case 'step:start': return (d.step_id || '') + ' (' + (d.step_type || '') + ') ' + (d.instruction || '').slice(0, 60);
    case 'step:complete': return (d.step_id || '') + ' ' + (d.status || 'pass') + ' ' + (d.duration_ms || 0) + 'ms';
    case 'step:failed': return (d.step_id || '') + ' ' + (d.error || 'failed').slice(0, 80);
    case 'plan:created': return ((d.steps && d.steps.length) || 0) + ' steps - ' + (d.reasoning || '').slice(0, 60);
    case 'plan:revised': return 'Replanned: ' + ((d.steps && d.steps.length) || 0) + ' steps';
    case 'thought:decision': return (d.instruction || d.thought || '').slice(0, 80);
    case 'thought:reasoning': return (d.thought || '').slice(0, 80);
    case 'criterion:met': return (d.id || '') + ': ' + (d.description || '');
    case 'convergence:goal_met': return 'All criteria met';
    case 'convergence:stuck': return 'Stuck: ' + (d.reason || '');
    case 'convergence:budget_exceeded': return 'Budget exceeded';
    default: return evt.type;
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ─── Timeline + step detail drawer ────────────────────────────
let _timelineCache = [];
let _eventsCache = [];

async function refreshTimeline() {
  try {
    const [tRes, eRes] = await Promise.all([
      fetch('/api/timeline'),
      fetch('/api/events/all?start=0'),
    ]);
    _timelineCache = await tRes.json();
    _eventsCache = await eRes.json();
    renderTimeline();
  } catch (e) { /* offline, ignore */ }
}

function renderTimeline() {
  const strip = document.getElementById('timelineStrip');
  document.getElementById('tlCount').textContent = _timelineCache.length + ' steps';
  strip.innerHTML = '';
  for (const step of _timelineCache) {
    const el = document.createElement('div');
    el.className = 'timeline-step ' + step.status + ' ' + step.kind;
    el.title = step.label + '\\n' + step.timestamp;
    el.innerHTML =
      '<span class="tl-seq">#' + step.sequence + '</span>' +
      '<span class="tl-label">' + escapeHtml(step.label) + '</span>';
    el.onclick = () => showDetail(step);
    strip.appendChild(el);
  }
  // Auto-scroll to the end so newest is visible
  strip.scrollLeft = strip.scrollWidth;
}

function showDetail(step) {
  // Mark selected
  for (const el of document.querySelectorAll('.timeline-step')) {
    el.classList.toggle('selected', el.title.startsWith(step.label));
  }
  document.getElementById('detailTitle').textContent =
    '#' + step.sequence + ' · ' + step.kind + ' · ' + step.label;

  // Pull related events from cache
  const related = _eventsCache.filter(e => step.event_sequences.includes(e.sequence));
  const body = document.getElementById('detailBody');

  const sections = [];
  sections.push('<div class="detail-row"><div class="detail-label">status</div><b class="st-' +
    (step.status === 'ok' ? 'pass' : step.status) + '">' + step.status + '</b></div>');
  if (step.timestamp) {
    sections.push('<div class="detail-row"><div class="detail-label">timestamp</div>' + step.timestamp + '</div>');
  }
  if (step.meta && Object.keys(step.meta).length) {
    sections.push('<div class="detail-row"><div class="detail-label">meta</div><pre>' +
      escapeHtml(JSON.stringify(step.meta, null, 2)) + '</pre></div>');
  }
  sections.push('<div class="detail-row"><div class="detail-label">events (' + related.length + ')</div><pre>' +
    escapeHtml(related.map(e => '[' + e.sequence + '] ' + e.type + ' ' + truncate(JSON.stringify(e.data), 400)).join('\\n')) +
    '</pre></div>');
  body.innerHTML = sections.join('');

  document.getElementById('detailDrawer').classList.add('open');
}

function closeDetail() {
  document.getElementById('detailDrawer').classList.remove('open');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// Refresh timeline when a new step/plan/criterion event arrives
const _origHandleEvent = handleEvent;
handleEvent = function (evt) {
  _origHandleEvent(evt);
  if (/^(action|step|plan|criterion|convergence|session):/.test(evt.type)) {
    // Debounce: schedule one refresh per 500ms window
    clearTimeout(window._tlRefreshTimer);
    window._tlRefreshTimer = setTimeout(refreshTimeline, 500);
  }
};

// Initial timeline fetch
setTimeout(refreshTimeline, 200);

connect();
</script>
</body>
</html>`;
}
