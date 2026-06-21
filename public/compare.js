/**
 * Compare page — client-side logic
 * Extracted from inline <script> in compare.html
 */

// ── i18n helper ──
function t(key, fallback) {
  return (window.AppTranslations && window.AppTranslations[key]) || fallback;
}

// ── State ──
let normativeFile = null;
let programFile = null;
let latestNormativeDocName = '';
let latestProgramDocName = '';
let latestCorrectedPdfUrl = '';
let latestCorrections = [];

function getPriorityColor(priority) {
  const p = (priority || '').toLowerCase();
  if (p === 'alta' || p === 'high') return 'var(--accent-rose)';
  if (p === 'media' || p === 'medium') return 'var(--accent-amber)';
  if (p === 'baja' || p === 'low') return 'var(--accent-emerald)';
  return 'var(--text-muted)';
}

// Load previous comparison on page load
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const res = await fetch('/api/compare/latest');
    const json = await res.json();
    if (json.success && json.data) {
      renderResults(json.data);
      document.getElementById('results-section').classList.add('visible');
      toast(t('loaded_from_db', 'Resumen de comparación cargado desde la base de datos'), 'info');
    }
  } catch (err) {
    console.error('Failed to load latest comparison:', err);
  }
});

// ── File Inputs ──
function setupFileInput(inputId, cardId, nameId, fileKey) {
  const card = document.getElementById(cardId);
  const input = document.getElementById(inputId);

  card.addEventListener('click', (e) => {
    if (e.target !== input) {
      input.click();
    }
  });

  input.addEventListener('click', (e) => {
    e.stopPropagation();
  });

  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (fileKey === 'normative') normativeFile = file;
    else if (fileKey === 'program') programFile = file;

    if (file) {
      card.classList.add('has-file');
      document.getElementById(nameId).textContent = '✓ ' + file.name;
    } else {
      card.classList.remove('has-file');
      document.getElementById(nameId).textContent = '';
    }
    checkReady();
  });
}

setupFileInput('file-normative', 'card-normative', 'name-normative', 'normative');
setupFileInput('file-program', 'card-program', 'name-program', 'program');

function checkReady() {
  document.getElementById('btn-compare').disabled = !(normativeFile && programFile);
}

// ── Compare ──
document.getElementById('btn-compare').addEventListener('click', runComparison);

async function runComparison() {
  const btn = document.getElementById('btn-compare');
  btn.disabled = true;
  btn.textContent = t('analyzing', 'Analizando...');

  const progress = document.getElementById('progress-bar');
  progress.classList.add('active');
  const progressStatus = document.getElementById('progress-status');
  progressStatus.textContent = t('extracting_ontology', 'Extrayendo ontología del documento normativo...');
  document.getElementById('results-section').classList.remove('visible');
  latestCorrectedPdfUrl = '';

  try {
    const provider = document.getElementById('model-provider')?.value || 'gemini';
    const formData = new FormData();
    formData.append('normative', normativeFile);
    formData.append('program', programFile);
    formData.append('clearPrevious', document.getElementById('clear-previous').checked);
    formData.append('provider', provider);

    const res = await fetch('/api/compare', { method: 'POST', body: formData });
    if (!res.ok) throw new Error(t('error_prefix', 'Error de comparación: ') + res.statusText);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

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
            if (data.step === 'ComparisonService') {
              progressStatus.textContent = data.content;
            } else if (data.step === 'NormativeOntologyAgent') {
              progressStatus.textContent = `📋 Agente Ontología Normativa: Analizando requisitos...`;
            } else if (data.step === 'ProgramOntologyAgent') {
              progressStatus.textContent = `📚 Agente Ontología Programa: Analizando temas...`;
            } else if (data.step === 'StructureAnalyzerAgent') {
              progressStatus.textContent = `🔍 Agente Estructura Programa: Analizando estructura...`;
            } else if (data.step === 'ComplianceGapsAgent') {
              progressStatus.textContent = `⚡ Agente Brechas Cumplimiento: Identificando desviaciones...`;
            } else if (data.step === 'ComplianceValidatorAgent') {
              progressStatus.textContent = `✅ Agente Validador: Filtrando falsos positivos...`;
            } else if (data.step === 'ProgramFixerAgent') {
              progressStatus.textContent = `🔧 Agente Corrector: Modificando programa...`;
            } else if (data.step === 'PDFGenerator') {
              progressStatus.textContent = data.content;
            }
          } else if (data.type === 'complete') {
            progress.classList.remove('active');
            
            if (data.downloadUrl) {
              latestCorrectedPdfUrl = data.downloadUrl;
            }
            
            renderResults(data.data);
            document.getElementById('results-section').classList.add('visible');
            toast(t('comparison_completed', 'Comparación completada'), 'success');
          } else if (data.type === 'error') {
            throw new Error(data.error);
          }
        } catch (e) {
          console.error('Error parsing streaming line:', e, line);
        }
      }
    }
  } catch (err) {
    progress.classList.remove('active');
    toast(t('error_prefix', 'Error: ') + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_compare', 'Comparar Documentos');
  }
}

// ── Render Results ──
function renderResults(report) {
  const s = report.summary;

  document.getElementById('display-normative-name').textContent = report.normativeDocument || '—';
  document.getElementById('display-program-name').textContent = report.programDocument || '—';
  latestNormativeDocName = report.normativeDocument || '';
  latestProgramDocName = report.programDocument || '';

  if (report.programDocument && report.correctionsJson) {
    const downloadName = report.programDocument.replace(/\.pdf$/i, '') + '_corregido.pdf';
    latestCorrectedPdfUrl = `/api/fix/download/${encodeURIComponent(downloadName)}`;
    try {
      latestCorrections = JSON.parse(report.correctionsJson);
    } catch (e) {
      console.error('Failed to parse correctionsJson:', e);
      latestCorrections = [];
    }
  } else {
    latestCorrections = [];
  }

  const hasGaps = s.partial > 0 || s.missing > 0;
  document.getElementById('btn-fix').style.display = hasGaps ? 'block' : 'none';
  document.getElementById('btn-download-non-compliance').style.display = hasGaps ? 'block' : 'none';

  document.getElementById('summary-grid').innerHTML = `
    <div class="summary-card"><div class="value value-total">${s.total}</div><div class="label">${t('total_requirements', 'Total Requisitos')}</div></div>
    <div class="summary-card"><div class="value value-covered">${s.covered}</div><div class="label">${t('covered', 'Cubiertos')}</div></div>
    <div class="summary-card"><div class="value value-partial">${s.partial}</div><div class="label">${t('partial', 'Parciales')}</div></div>
    <div class="summary-card"><div class="value value-missing">${s.missing}</div><div class="label">${t('missing', 'Faltantes')}</div></div>
  `;

  const covPct = s.total > 0 ? (s.covered / s.total * 100).toFixed(1) : 0;
  const parPct = s.total > 0 ? (s.partial / s.total * 100).toFixed(1) : 0;
  const misPct = s.total > 0 ? (s.missing / s.total * 100).toFixed(1) : 0;
  const barColor = s.coveragePercent >= 75 ? 'var(--accent-emerald)' : s.coveragePercent >= 50 ? 'var(--accent-amber)' : 'var(--accent-rose)';

  document.getElementById('coverage-container').innerHTML = `
    <div class="coverage-header">
      <h3>${t('general_coverage', 'Cobertura General')}</h3>
      <span class="coverage-percent" style="color:${barColor}">${s.coveragePercent}%</span>
    </div>
    <div class="coverage-track">
      <div class="coverage-segment covered" style="width:${covPct}%"></div>
      <div class="coverage-segment partial" style="width:${parPct}%"></div>
      <div class="coverage-segment missing" style="width:${misPct}%"></div>
    </div>
    <div class="coverage-legend">
      <div class="coverage-legend-item"><div class="coverage-legend-dot" style="background:var(--accent-emerald)"></div>${t('status_covered', 'Cubierto')} (${covPct}%)</div>
      <div class="coverage-legend-item"><div class="coverage-legend-dot" style="background:var(--accent-amber)"></div>${t('status_partial', 'Parcial')} (${parPct}%)</div>
      <div class="coverage-legend-item"><div class="coverage-legend-dot" style="background:var(--accent-rose)"></div>${t('status_missing', 'Faltante')} (${misPct}%)</div>
    </div>
  `;

  renderTable(report.results, 'all');
}

let currentResults = [];
function renderTable(results, filter) {
  currentResults = results;
  const filtered = filter === 'all' ? results : results.filter(r => r.status === filter);

  const statusLabel = {
    covered: t('status_covered', 'Cubierto'),
    partial: t('status_partial', 'Parcial'),
    missing: t('status_missing', 'Faltante')
  };
  const statusIcon = { covered: '✓', partial: '◐', missing: '✗' };

  document.getElementById('results-table').innerHTML = `
    <div class="results-table-header">
      <h3>${t('detail_by_requirement', 'Detalle por Requisito')} (${filtered.length})</h3>
      <div class="filter-tabs">
        <button class="filter-tab ${filter==='all'?'active':''}" onclick="renderTable(currentResults,'all')">${t('filter_all', 'Todos')}</button>
        <button class="filter-tab ${filter==='covered'?'active':''}" onclick="renderTable(currentResults,'covered')">${t('filter_covered', 'Cubiertos')}</button>
        <button class="filter-tab ${filter==='partial'?'active':''}" onclick="renderTable(currentResults,'partial')">${t('filter_partial', 'Parciales')}</button>
        <button class="filter-tab ${filter==='missing'?'active':''}" onclick="renderTable(currentResults,'missing')">${t('filter_missing', 'Faltantes')}</button>
      </div>
    </div>
    ${filtered.map(r => {
      const corr = latestCorrections.find(c => String(c.gapId || '').toLowerCase() === String(r.item.id || '').toLowerCase());
      let correctionHtml = '';
      if (corr) {
        const pColor = getPriorityColor(corr.priority);
        correctionHtml = `
          <div class="result-detail-box correction" style="grid-column: span 2; border-left: 3px solid var(--accent-emerald); background: rgba(16, 185, 129, 0.04); padding: 12px 16px; margin-top: 8px;">
            <div class="detail-label" style="color: var(--accent-emerald); font-weight: 700;">🔧 ${t('proposed_correction', 'Propuesta de Adecuación (Anexo PDF)')}</div>
            <div style="display: flex; gap: 16px; margin: 8px 0; font-size: 0.8rem; color: var(--text-secondary); flex-wrap: wrap;">
              <div><strong>${t('target_section', 'Sección de destino')}:</strong> ${esc(corr.section)}</div>
              <div><strong>${t('action', 'Acción')}:</strong> <span class="status-badge status-covered" style="padding: 1px 6px; font-size: 0.65rem; text-transform: uppercase;">${esc(corr.action)}</span></div>
              <div><strong>${t('priority', 'Prioridad')}:</strong> <span class="status-badge" style="background: ${pColor}; color: white; padding: 1px 6px; font-size: 0.65rem; text-transform: uppercase; border-radius: 4px;">${esc(corr.priority)}</span></div>
            </div>
            <div class="detail-text" style="margin-bottom: 8px; font-size: 0.8rem; line-height: 1.5;"><strong>${t('justification', 'Justificación')}:</strong> ${esc(corr.justification)}</div>
            <div class="detail-label" style="margin-top: 8px; font-size: 0.68rem;">${t('text_to_integrate', 'Texto a incorporar')}:</div>
            <pre style="background: var(--bg-primary); border: 1px solid var(--border-light); padding: 10px 14px; border-radius: var(--radius-sm); font-size: 0.8rem; color: var(--text-primary); white-space: pre-wrap; font-family: var(--font-sans); margin: 6px 0 0 0; max-height: 250px; overflow-y: auto; line-height: 1.5;">${esc(corr.correctedText)}</pre>
          </div>
        `;
      }

      return `
        <div class="result-row">
          <div class="result-row-header">
            <span class="status-badge status-${r.status}">${statusIcon[r.status]} ${statusLabel[r.status]}</span>
            <span class="result-id">${esc(r.item.id)}</span>
            <span class="result-category">${esc(r.item.category)}</span>
            <span class="result-requirement">${esc(r.item.requirement)}</span>
          </div>
          <div class="result-details">
            <div class="result-detail-box evidence">
              <div class="detail-label">${t('evidence', 'Evidencia')}</div>
              <div class="detail-text">${esc(r.evidence) || '—'}</div>
            </div>
            <div class="result-detail-box suggestion">
              <div class="detail-label">${t('suggestion', 'Sugerencia')}</div>
              <div class="detail-text">${esc(r.suggestion) || '—'}</div>
            </div>
            ${correctionHtml}
          </div>
        </div>
      `;
    }).join('')}
  `;
}

// ── Fix button event ──
document.getElementById('btn-fix').addEventListener('click', () => {
  if (latestCorrectedPdfUrl) {
    window.open(latestCorrectedPdfUrl, '_blank');
  } else {
    runFixPipeline();
  }
});
document.getElementById('btn-close-modal').addEventListener('click', () => {
  document.getElementById('fix-modal').style.display = 'none';
});
document.getElementById('btn-download-non-compliance').addEventListener('click', () => {
  window.open('/api/compare/non-compliance-pdf', '_blank');
});

async function runFixPipeline() {
  if (!latestNormativeDocName || !latestProgramDocName) {
    toast(t('no_docs_to_fix', 'No hay documentos comparados para arreglar.'), 'error');
    return;
  }

  const modal = document.getElementById('fix-modal');
  modal.style.display = 'flex';

  const steps = ['start', 'normative', 'program', 'compliance', 'validator', 'fixer', 'pdf'];
  steps.forEach(s => {
    const el = document.getElementById('step-' + s);
    if (el) {
      el.style.color = 'var(--text-muted)';
      el.querySelector('.step-status').textContent = '⏳';
    }
  });

  document.getElementById('btn-download-pdf').style.display = 'none';

  const provider = document.getElementById('model-provider')?.value || 'gemini';
  
  // Set the dynamic label inside the modal step text for step-fixer
  const fixerTextEl = document.querySelector('#step-fixer .step-text');
  if (fixerTextEl) {
    fixerTextEl.textContent = t('agent_corrector_modifying', 'Agente Corrector: Modificando programa con ') + (provider === 'groq' ? 'Groq' : 'Gemini') + '...';
  }

  const lang = document.documentElement.lang || 'es';
  
  try {
    const res = await fetch('/api/fix', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        normativeDocument: latestNormativeDocName,
        programDocument: latestProgramDocName,
        provider: provider,
        lang: lang
      })
    });

    if (!res.ok) throw new Error(t('fix_error_prefix', 'Error de corrección: ') + res.statusText);

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
            toast(t('fix_success', 'Corrección finalizada con éxito'), 'success');
            if (data.data) {
              renderResults(data.data);
            }
          } else if (data.type === 'error') {
            throw new Error(data.error);
          }
        } catch (e) {
          console.error('Error parsing streaming line:', e, line);
        }
      }
    }
  } catch (err) {
    toast(t('fix_error_prefix', 'Error de corrección: ') + err.message, 'error');
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
  } else if (update.step === 'ComplianceValidatorAgent') {
    updateStep('compliance', 'success');
    updateStep('validator', 'active');
    if (update.isFinal) updateStep('validator', 'success');
  } else if (update.step === 'ProgramFixerAgent') {
    updateStep('validator', 'success');
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
