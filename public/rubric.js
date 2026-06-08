/**
 * Rubric page — client-side logic (Multi-Agent version)
 * Handles 2 file uploads (normative + evaluation schema),
 * multi-agent rubric generation, preview rendering,
 * non-evaluable observations, PDF download, and clear.
 */

// Helper function to translate keys using injected translations
function t(key, fallback) {
  return (window.AppTranslations && window.AppTranslations[key]) || fallback;
}

// ── State ──
let normativeFile = null;
let schemaFile = null;
let rubricData = null;
let pdfBase64 = null;

// ── File Inputs ──

function setupFileInput(inputId, cardId, nameId, fileKey) {
  document.getElementById(inputId).addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (fileKey === 'normative') normativeFile = file;
    else if (fileKey === 'schema') schemaFile = file;

    if (file) {
      document.getElementById(cardId).classList.add('has-file');
      document.getElementById(nameId).textContent = '✓ ' + file.name;
    } else {
      document.getElementById(cardId).classList.remove('has-file');
      document.getElementById(nameId).textContent = '';
    }
    checkReady();
  });
}

setupFileInput('file-normative-rubric', 'card-normative-rubric', 'name-normative-rubric', 'normative');
setupFileInput('file-schema-rubric', 'card-schema-rubric', 'name-schema-rubric', 'schema');

function checkReady() {
  const allReady = normativeFile && schemaFile;
  document.getElementById('btn-generate-rubric').disabled = !allReady;

  // Update step-upload state
  if (allReady) {
    setStepState('step-upload', 'done');
  } else if (normativeFile || schemaFile) {
    setStepState('step-upload', 'active');
  } else {
    setStepState('step-upload', '');
  }
}

// ── Generate Rubric (Multi-Agent) ──
document.getElementById('btn-generate-rubric').addEventListener('click', generateRubric);

async function generateRubric() {
  const btn = document.getElementById('btn-generate-rubric');
  btn.disabled = true;
  btn.textContent = t('executing_pipeline', '⏳ Ejecutando pipeline multi-agente...');

  const progress = document.getElementById('rubric-progress');
  progress.classList.add('active');
  document.getElementById('rubric-preview').classList.remove('visible');
  document.getElementById('btn-download-rubric').style.display = 'none';
  document.getElementById('btn-clear-rubric').style.display = 'none';
  document.getElementById('observations-panel').style.display = 'none';

  // Reset agent steps
  setStepState('step-extract', 'active');
  setStepState('step-ontology-agent', '');
  setStepState('step-adjuster-agent', '');
  setStepState('step-synthesizer-agent', '');
  updateProgressStatus(t('extracting_text', 'Extrayendo texto de los documentos PDF...'));

  try {
    await sleep(500);

    const provider = document.getElementById('model-provider')?.value || 'gemini';
    const formData = new FormData();
    formData.append('normative', normativeFile);
    formData.append('evaluationSchema', schemaFile);
    formData.append('provider', provider);

    // Step 2: Extracting
    updateProgressStatus(t('extracting_ontology', 'Extrayendo ontología normativa y esquema de evaluación...'));

    // Simulate step progression while waiting for the long response
    const stepTimers = [
      setTimeout(() => {
        setStepState('step-extract', 'done');
        setStepState('step-ontology-agent', 'active');
        updateProgressStatus(t('agent1_running', '🤖 Agente 1: Analizando ontología normativa...'));
      }, 10000),
      setTimeout(() => {
        setStepState('step-ontology-agent', 'done');
        setStepState('step-adjuster-agent', 'active');
        updateProgressStatus(t('agent2_running', '🤖 Agente 2: Ajustando ontología con esquema de evaluación...'));
      }, 50000),
      setTimeout(() => {
        setStepState('step-adjuster-agent', 'done');
        setStepState('step-synthesizer-agent', 'active');
        updateProgressStatus(t('agent3_running', '🤖 Agente 3: Sintetizando rúbrica final...'));
      }, 100000),
    ];

    const res = await fetch('/api/rubric', { method: 'POST', body: formData });

    // Clear step timers
    stepTimers.forEach(t => clearTimeout(t));

    // Mark all steps done
    setStepState('step-extract', 'done');
    setStepState('step-ontology-agent', 'done');
    setStepState('step-adjuster-agent', 'done');
    setStepState('step-synthesizer-agent', 'done');
    updateProgressStatus(t('rendering_preview', 'Renderizando vista previa...'));
    await sleep(400);

    const json = await res.json();

    if (!json.success) throw new Error(json.error);

    rubricData = json.data;
    pdfBase64 = json.pdfBase64;

    progress.classList.remove('active');
    renderRubricPreview(rubricData);

    // Show action buttons
    if (pdfBase64) {
      const dlBtn = document.getElementById('btn-download-rubric');
      dlBtn.href = 'data:application/pdf;base64,' + pdfBase64;
      dlBtn.download = 'rubrica_multiagente_' + normativeFile.name.replace(/\.pdf$/i, '') + '.pdf';
      dlBtn.style.display = 'inline-flex';
    }
    document.getElementById('btn-clear-rubric').style.display = 'inline-flex';

    toast(t('generate_success', 'Rúbrica multi-agente generada exitosamente'), 'success');
  } catch (err) {
    progress.classList.remove('active');
    setStepState('step-extract', '');
    setStepState('step-ontology-agent', '');
    setStepState('step-adjuster-agent', '');
    setStepState('step-synthesizer-agent', '');
    toast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_generate', '🤖 Generar Rúbrica Multi-Agente');
    checkReady();
  }
}

// ── Load Persisted Rubric on Startup ──
document.addEventListener('DOMContentLoaded', loadSavedRubric);

async function loadSavedRubric() {
  try {
    const res = await fetch('/api/rubric');
    const json = await res.json();
    if (json.success && json.data) {
      rubricData = json.data;
      pdfBase64 = json.pdfBase64;

      setStepState('step-upload', 'done');
      setStepState('step-extract', 'done');
      setStepState('step-ontology-agent', 'done');
      setStepState('step-adjuster-agent', 'done');
      setStepState('step-synthesizer-agent', 'done');
      renderRubricPreview(rubricData);

      if (pdfBase64) {
        const dlBtn = document.getElementById('btn-download-rubric');
        dlBtn.href = 'data:application/pdf;base64,' + pdfBase64;
        dlBtn.download = 'rubrica_multiagente_' + (rubricData.normativeDocument || 'documento').replace(/\.pdf$/i, '') + '.pdf';
        dlBtn.style.display = 'inline-flex';
      }
      document.getElementById('btn-clear-rubric').style.display = 'inline-flex';
    }
  } catch (err) {
    console.error('Error recuperando rúbrica guardada:', err);
  }
}

// ── Clear All ──
document.getElementById('btn-clear-rubric').addEventListener('click', async () => {
  if (!confirm(t('clear_db_confirm', '¿Estás seguro de que quieres borrar toda la base de datos? Esta acción no se puede deshacer y eliminará todos los documentos, comparaciones y rúbricas.'))) {
    return;
  }

  const btn = document.getElementById('btn-clear-rubric');
  btn.disabled = true;
  btn.textContent = t('clearing', '⏳ Borrando todo...');

  try {
    const res = await fetch('/api/graph/clear', { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Error al limpiar la base de datos');

    rubricData = null;
    pdfBase64 = null;
    normativeFile = null;
    schemaFile = null;

    document.getElementById('file-normative-rubric').value = '';
    document.getElementById('file-schema-rubric').value = '';
    document.getElementById('card-normative-rubric').classList.remove('has-file');
    document.getElementById('card-schema-rubric').classList.remove('has-file');
    document.getElementById('name-normative-rubric').textContent = '';
    document.getElementById('name-schema-rubric').textContent = '';
    document.getElementById('rubric-preview').classList.remove('visible');
    document.getElementById('btn-download-rubric').style.display = 'none';
    document.getElementById('btn-clear-rubric').style.display = 'none';
    document.getElementById('rubric-dimensions-container').innerHTML = '';
    document.getElementById('observations-panel').style.display = 'none';
    document.getElementById('btn-generate-rubric').disabled = true;

    setStepState('step-upload', '');
    setStepState('step-extract', '');
    setStepState('step-ontology-agent', '');
    setStepState('step-adjuster-agent', '');
    setStepState('step-synthesizer-agent', '');

    toast(t('clear_success', 'Base de datos y rúbricas eliminadas por completo'), 'success');
  } catch (err) {
    toast('Error al limpiar la base de datos: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = t('btn_clear', '🗑️ Limpiar Todo');
  }
});

// ── Render Rubric Preview ──
function renderRubricPreview(rubric) {
  document.getElementById('rubric-doc-name').textContent = rubric.normativeDocument || '—';
  
  const compLabel = rubric.criteria.length > 1 ? t('components', 'componentes') : t('component', 'componente');
  document.getElementById('rubric-criteria-count').textContent = rubric.criteria.length + ' ' + compLabel;

  // Count unique dimensions
  const dims = new Set(rubric.criteria.map(c => c.dimension));
  const dimLabel = dims.size > 1 ? t('dimensions', 'dimensiones') : t('dimension', 'dimensión');
  document.getElementById('rubric-dimensions-count').textContent = dims.size + ' ' + dimLabel.toLowerCase();
  
  document.getElementById('rubric-total-weight').textContent = rubric.totalWeight + ' ' + t('pts_max', 'pts máx.');

  // Render non-evaluable observations
  if (rubric.nonEvaluableObservations && rubric.nonEvaluableObservations.length > 0) {
    const obsContainer = document.getElementById('observations-container');
    obsContainer.innerHTML = rubric.nonEvaluableObservations.map(obs => `
      <div class="observation-item">
        <strong>${esc(obs.aspect)}</strong>
        <p><em>${t('reason', 'Razón')}:</em> ${esc(obs.reason)}</p>
        ${obs.recommendation ? `<p><em>${t('recommendation', 'Recomendación')}:</em> ${esc(obs.recommendation)}</p>` : ''}
      </div>
    `).join('');
    document.getElementById('observations-panel').style.display = 'block';
  }

  // Group by dimension
  const dimensionMap = new Map();
  for (const c of rubric.criteria) {
    const dim = c.dimension || 'General';
    if (!dimensionMap.has(dim)) dimensionMap.set(dim, []);
    dimensionMap.get(dim).push(c);
  }

  const container = document.getElementById('rubric-dimensions-container');
  container.innerHTML = '';

  let dimIndex = 0;
  for (const [dimName, criteria] of dimensionMap) {
    dimIndex++;
    const section = document.createElement('div');
    section.className = 'dimension-section';

    section.innerHTML = `
      <div class="dimension-header">
        <span class="dimension-icon">📋</span>
        <span class="dimension-name">${t('dimension', 'DIMENSIÓN')} ${dimIndex}: ${esc(dimName).toUpperCase()}</span>
        <span class="dimension-count">${criteria.length} ${criteria.length > 1 ? t('components', 'componentes') : t('component', 'componente')}</span>
      </div>
      <table class="criteria-table">
        <thead>
          <tr>
            <th class="th-criterion">${t('table_evaluated_component', 'Componente Evaluado')}</th>
            <th class="th-criterion" style="background:#475569; width:20%;">${t('table_institutional_criterion', 'Criterio de Calidad Institucional')}</th>
            <th class="th-excellent">${t('table_level_excellent', 'Cumple Totalmente (2 pts)')}</th>
            <th class="th-acceptable">${t('table_level_acceptable', 'Cumple Parcialmente (1 pt)')}</th>
            <th class="th-insufficient">${t('table_level_insufficient', 'No Cumple (0 pts)')}</th>
          </tr>
        </thead>
        <tbody>
          ${criteria.map(c => `
            <tr>
              <td class="td-criterion">
                ${esc(c.id)}<br>
                <strong>${esc(c.criterion)}</strong>
              </td>
              <td style="color: var(--text-secondary); font-size: 0.78rem;">
                ${esc(c.description)}
              </td>
              <td class="td-excellent">
                <strong>${t('table_label_optimo', 'ÓPTIMO')}</strong><br>
                ${esc(c.levels.full)}
              </td>
              <td class="td-acceptable">
                <strong>${t('table_label_acceptable', 'ACEPTABLE CON OBSERVACIÓN')}</strong><br>
                ${esc(c.levels.partial)}
              </td>
              <td class="td-insufficient">
                <strong>${t('table_label_deficiente', 'DEFICIENTE / CRÍTICO')}</strong><br>
                ${esc(c.levels.none)}
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    container.appendChild(section);
  }

  document.getElementById('rubric-preview').classList.add('visible');
}

// ── Helpers ──

function setStepState(stepId, state) {
  const el = document.getElementById(stepId);
  if (!el) return;
  el.classList.remove('active', 'done');
  if (state) el.classList.add(state);
}

function updateProgressStatus(text) {
  document.getElementById('rubric-progress-status').textContent = text;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// HTML escape helper
function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function toast(msg, type) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => { el.classList.add('toast-exit'); setTimeout(() => el.remove(), 200); }, 4000);
}
