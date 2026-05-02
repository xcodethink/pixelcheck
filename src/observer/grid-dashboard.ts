/**
 * Grid Dashboard — Multi-session overview.
 *
 * Shows one tile per (persona × scenario) unit in an N-column grid.
 * Polls /api/grid every 2s to refresh each tile's status, last step,
 * events count, and cost. Click a tile to jump into that session's
 * detail view.
 *
 * Single-file HTML; no build step.
 */

export function getGridHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PixelCheck — Multi-Session Grid</title>
<style>
  * { box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
    background: #0d1117;
    color: #c9d1d9;
    margin: 0;
    min-height: 100vh;
  }
  header {
    padding: 12px 20px;
    background: #161b22;
    border-bottom: 1px solid #30363d;
    display: flex;
    align-items: center;
    gap: 12px;
  }
  header h1 { font-size: 14px; color: #58a6ff; margin: 0; flex: 1; }
  header .meta { font-size: 11px; color: #8b949e; }

  .grid {
    padding: 16px;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .tile {
    background: #161b22;
    border: 1px solid #30363d;
    border-radius: 8px;
    padding: 12px;
    cursor: pointer;
    transition: transform .08s ease, border-color .08s ease;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .tile:hover { transform: translateY(-2px); border-color: #58a6ff; }
  .tile-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }
  .tile-label {
    font-size: 12px;
    color: #c9d1d9;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
  }
  .status-badge {
    padding: 2px 8px;
    border-radius: 10px;
    font-size: 10px;
    font-weight: 600;
    text-transform: uppercase;
  }
  .status-running { background: #0d419d; color: #58a6ff; }
  .status-paused  { background: #4d2d00; color: #d29922; }
  .status-takeover{ background: #5a1e02; color: #f85149; }
  .status-complete{ background: #0e3a16; color: #3fb950; }
  .status-failed  { background: #5a1e02; color: #f85149; }

  .tile-metrics {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 6px;
  }
  .metric {
    background: #0d1117;
    border-radius: 4px;
    padding: 4px 6px;
    font-size: 11px;
  }
  .metric-label { color: #8b949e; font-size: 9px; text-transform: uppercase; letter-spacing: 0.5px; }
  .metric-value { color: #c9d1d9; font-weight: 600; }

  .tile-last-step {
    font-size: 11px;
    color: #8b949e;
    padding: 6px;
    background: #0d1117;
    border-radius: 4px;
    max-height: 44px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .empty {
    text-align: center;
    color: #484f58;
    padding: 40px;
    font-size: 13px;
  }

  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: #30363d; border-radius: 3px; }
</style>
</head>
<body>

<header>
  <h1>PixelCheck — Multi-Session Grid</h1>
  <span class="meta" id="metaSessions">0 sessions</span>
  <span class="meta" id="metaUpdated">never</span>
</header>

<div class="grid" id="grid">
  <div class="empty" id="empty">Waiting for sessions…</div>
</div>

<script>
const POLL_MS = 2000;

async function poll() {
  try {
    const res = await fetch('/api/grid');
    const data = await res.json();
    render(data);
    document.getElementById('metaSessions').textContent = data.length + ' session' + (data.length === 1 ? '' : 's');
    document.getElementById('metaUpdated').textContent = 'updated ' + new Date().toLocaleTimeString();
  } catch (e) {
    // offline — keep last state
  }
  setTimeout(poll, POLL_MS);
}

function render(snapshots) {
  const grid = document.getElementById('grid');
  document.getElementById('empty').style.display = snapshots.length === 0 ? 'block' : 'none';

  const existing = new Map();
  for (const el of grid.querySelectorAll('.tile')) existing.set(el.dataset.sid, el);

  for (const s of snapshots) {
    let tile = existing.get(s.session_id);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.sid = s.session_id;
      tile.onclick = () => openSession(s.session_id);
      grid.appendChild(tile);
    } else {
      existing.delete(s.session_id);
    }
    tile.innerHTML = renderTile(s);
  }
  // Remove sessions that no longer exist
  for (const [, orphan] of existing) orphan.remove();
}

function renderTile(s) {
  const status = s.state.status || 'running';
  const last = s.last_step
    ? escapeHtml(s.last_step.label) + ' — ' + s.last_step.status
    : '(no steps yet)';
  return (
    '<div class="tile-header">' +
      '<div class="tile-label">' + escapeHtml(s.label || s.session_id) + '</div>' +
      '<span class="status-badge status-' + status + '">' + status + '</span>' +
    '</div>' +
    '<div class="tile-metrics">' +
      metric('cost', '$' + (s.state.cost_usd || 0).toFixed(3)) +
      metric('steps', s.timeline_count || 0) +
      metric('fails', s.state.actions_failed || 0) +
    '</div>' +
    '<div class="tile-last-step">' + last + '</div>'
  );
}
function metric(label, value) {
  return '<div class="metric"><div class="metric-label">' + label + '</div>' +
    '<div class="metric-value">' + value + '</div></div>';
}
function openSession(sid) {
  // In future: deep-link to a per-session detail view. For now, open the root dashboard.
  window.open('/?session=' + encodeURIComponent(sid), '_blank');
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

poll();
</script>
</body>
</html>`;
}
