/**
 * Compare page — client-side logic
 * Extracted from inline <script> in compare.html
 */

// ── State ──
let normativeFile = null;
let programFile = null;
let latestNormativeDocName = '';
let latestProgramDocName = '';

// Load previous comparison on page load
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/compare/latest');
    const json = await res.json();
    if (json.success && json.data) {
      renderResults(json.data);
      document.getElementById('results-section').classList.add('visible');
      toast('Resumen de comparación cargado desde la base de datos', 'info');
    }
  } catch (err) {
    console.error('Failed to load latest comparison:', err);
  }
});

// ── File Inputs ──
document.getElementById('file-normative').addEventListener('change', e => {
  normativeFile = e.target.files[0];
  if (normativeFile) {
    document.getElementById('card-normative').classList.add('has-file');
    document.getElementById('name-normative').textContent = '✓ ' + normativeFile.name;
  }
  checkReady();
});

document.getElementById('file-program').addEventListener('change', e => {
  programFile = e.target.files[0];
  if (programFile) {
    document.getElementById('card-program').classList.add('has-file');
    document.getElementById('name-program').textContent = '✓ ' + programFile.name;
  }
  checkReady();
});

function checkReady() {
  document.getElementById('btn-compare').disabled = !(normativeFile && programFile);
}

// ── Compare ──
document.getElementById('btn-compare').addEventListener('click', runComparison);

async function runComparison() {
  const btn = document.getElementById('btn-compare');
  btn.disabled = true;
  btn.textContent = 'Analizando...';

  const progress = document.getElementById('progress-bar');
  progress.classList.add('active');
  document.getElementById('progress-status').textContent = 'Extrayendo ontología del documento normativo...';
  document.getElementById('results-section').classList.remove('visible');

  try {
    const formData = new FormData();
    formData.append('normative', normativeFile);
    formData.append('program', programFile);
    formData.append('clearPrevious', document.getElementById('clear-previous').checked);

    const res = await fetch('/api/compare', { method: 'POST', body: formData });
    const json = await res.json();

    if (!json.success) throw new Error(json.error);

    progress.classList.remove('active');
    renderResults(json.data);
    document.getElementById('results-section').classList.add('visible');
    toast('Comparación completada', 'success');
  } catch (err) {
    progress.classList.remove('active');
    toast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Comparar Documentos';
  }
}

// ── Render Results ──
function renderResults(report) {
  const s = report.summary;

  document.getElementById('display-normative-name').textContent = report.normativeDocument || '—';
  document.getElementById('display-program-name').textContent = report.programDocument || '—';
  latestNormativeDocName = report.normativeDocument || '';
  latestProgramDocName = report.programDocument || '';

  const hasGaps = s.partial > 0 || s.missing > 0;
  document.getElementById('btn-fix').style.display = hasGaps ? 'block' : 'none';

  document.getElementById('summary-grid').innerHTML = `
    <div class="summary-card"><div class="value value-total">${s.total}</div><div class="label">Total Requisitos</div></div>
    <div class="summary-card"><div class="value value-covered">${s.covered}</div><div class="label">Cubiertos</div></div>
    <div class="summary-card"><div class="value value-partial">${s.partial}</div><div class="label">Parciales</div></div>
    <div class="summary-card"><div class="value value-missing">${s.missing}</div><div class="label">Faltantes</div></div>
  `;

  const covPct = s.total > 0 ? (s.covered / s.total * 100).toFixed(1) : 0;
  const parPct = s.total > 0 ? (s.partial / s.total * 100).toFixed(1) : 0;
  const misPct = s.total > 0 ? (s.missing / s.total * 100).toFixed(1) : 0;
  const barColor = s.coveragePercent >= 75 ? 'var(--accent-emerald)' : s.coveragePercent >= 50 ? 'var(--accent-amber)' : 'var(--accent-rose)';

  document.getElementById('coverage-container').innerHTML = `
    <div class="coverage-header">
      <h3>Cobertura General</h3>
      <span class="coverage-percent" style="color:${barColor}">${s.coveragePercent}%</span>
    </div>
    <div class="coverage-track">
      <div class="coverage-segment covered" style="width:${covPct}%"></div>
      <div class="coverage-segment partial" style="width:${parPct}%"></div>
      <div class="coverage-segment missing" style="width:${misPct}%"></div>
    </div>
    <div class="coverage-legend">
      <div class="coverage-legend-item"><div class="coverage-legend-dot" style="background:var(--accent-emerald)"></div>Cubierto (${covPct}%)</div>
      <div class="coverage-legend-item"><div class="coverage-legend-dot" style="background:var(--accent-amber)"></div>Parcial (${parPct}%)</div>
      <div class="coverage-legend-item"><div class="coverage-legend-dot" style="background:var(--accent-rose)"></div>Faltante (${misPct}%)</div>
    </div>
  `;

  renderTable(report.results, 'all');
}

let currentResults = [];
function renderTable(results, filter) {
  currentResults = results;
  const filtered = filter === 'all' ? results : results.filter(r => r.status === filter);

  const statusLabel = { covered: 'Cubierto', partial: 'Parcial', missing: 'Faltante' };
  const statusIcon = { covered: '✓', partial: '◐', missing: '✗' };

  document.getElementById('results-table').innerHTML = `
    <div class="results-table-header">
      <h3>Detalle por Requisito (${filtered.length})</h3>
      <div class="filter-tabs">
        <button class="filter-tab ${filter==='all'?'active':''}" onclick="renderTable(currentResults,'all')">Todos</button>
        <button class="filter-tab ${filter==='covered'?'active':''}" onclick="renderTable(currentResults,'covered')">Cubiertos</button>
        <button class="filter-tab ${filter==='partial'?'active':''}" onclick="renderTable(currentResults,'partial')">Parciales</button>
        <button class="filter-tab ${filter==='missing'?'active':''}" onclick="renderTable(currentResults,'missing')">Faltantes</button>
      </div>
    </div>
    ${filtered.map(r => `
      <div class="result-row">
        <div class="result-row-header">
          <span class="status-badge status-${r.status}">${statusIcon[r.status]} ${statusLabel[r.status]}</span>
          <span class="result-id">${esc(r.item.id)}</span>
          <span class="result-category">${esc(r.item.category)}</span>
          <span class="result-requirement">${esc(r.item.requirement)}</span>
        </div>
        <div class="result-details">
          <div class="result-detail-box evidence">
            <div class="detail-label">Evidencia</div>
            <div class="detail-text">${esc(r.evidence) || '—'}</div>
          </div>
          <div class="result-detail-box suggestion">
            <div class="detail-label">Sugerencia</div>
            <div class="detail-text">${esc(r.suggestion) || '—'}</div>
          </div>
        </div>
      </div>
    `).join('')}
  `;
}

// ── Fix button event ──
document.getElementById('btn-fix').addEventListener('click', runFixPipeline);
document.getElementById('btn-close-modal').addEventListener('click', () => {
  document.getElementById('fix-modal').style.display = 'none';
});

async function runFixPipeline() {
  if (!latestNormativeDocName || !latestProgramDocName) {
    toast('No hay documentos comparados para arreglar.', 'error');
    return;
  }

  const modal = document.getElementById('fix-modal');
  modal.style.display = 'flex';

  const steps = ['start', 'normative', 'program', 'compliance', 'fixer', 'pdf'];
  steps.forEach(s => {
    const el = document.getElementById('step-' + s);
    if (el) {
      el.style.color = 'var(--text-muted)';
      el.querySelector('.step-status').textContent = '⏳';
    }
  });

  document.getElementById('btn-download-pdf').style.display = 'none';

  try {
    const res = await fetch('/api/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        normativeDocument: latestNormativeDocName,
        programDocument: latestProgramDocName
      })
    });

    if (!res.ok) throw new Error('Error al iniciar el pipeline de corrección.');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    updateStep('start', 'active');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          if (data.type === 'progress') {
            handleProgressUpdate(data);
          } else if (data.type === 'complete') {
            updateStep('pdf', 'success');
            const dlBtn = document.getElementById('btn-download-pdf');
            dlBtn.href = data.downloadUrl;
            dlBtn.style.display = 'inline-flex';
            toast('Corrección finalizada con éxito', 'success');
          } else if (data.type === 'error') {
            throw new Error(data.error);
          }
        } catch (e) {
          console.error('Error parsing streaming line:', e, line);
        }
      }
    }
  } catch (err) {
    toast('Error de corrección: ' + err.message, 'error');
    steps.forEach(s => {
      const el = document.getElementById('step-' + s);
      if (el && el.querySelector('.step-status').textContent === '⚡') {
        el.querySelector('.step-status').textContent = '❌';
        el.style.color = 'var(--accent-rose)';
      }
    });
  }
}

function updateStep(stepId, state) {
  const el = document.getElementById('step-' + stepId);
  if (!el) return;
  if (state === 'active') {
    el.style.color = 'var(--accent-cyan)';
    el.querySelector('.step-status').textContent = '⚡';
  } else if (state === 'success') {
    el.style.color = 'var(--accent-emerald)';
    el.querySelector('.step-status').textContent = '✅';
  }
}

function handleProgressUpdate(update) {
  if (update.step === 'NormativeOntologyAgent') {
    updateStep('start', 'success');
    updateStep('normative', 'active');
    if (update.isFinal) updateStep('normative', 'success');
  } else if (update.step === 'ProgramOntologyAgent') {
    updateStep('normative', 'success');
    updateStep('program', 'active');
    if (update.isFinal) updateStep('program', 'success');
  } else if (update.step === 'ComplianceGapsAgent') {
    updateStep('program', 'success');
    updateStep('compliance', 'active');
    if (update.isFinal) updateStep('compliance', 'success');
  } else if (update.step === 'ProgramFixerAgent') {
    updateStep('compliance', 'success');
    updateStep('fixer', 'active');
    if (update.isFinal) {
      updateStep('fixer', 'success');
      updateStep('pdf', 'active');
    }
  } else if (update.step === 'PDFGenerator') {
    updateStep('fixer', 'success');
    updateStep('pdf', 'active');
  }
}

// ── Utils ──
function esc(str) { const d = document.createElement('div'); d.textContent = str || ''; return d.innerHTML; }

function toast(msg, type) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => { el.classList.add('toast-exit'); setTimeout(() => el.remove(), 200); }, 4000);
}
