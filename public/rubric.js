/**
 * Rubric page — client-side logic
 * Handles file upload, rubric generation, preview rendering, PDF download, and clear.
 */

// ── State ──
let normativeFile = null;
let rubricData = null;
let pdfBase64 = null;

// ── File Input ──
document.getElementById('file-normative-rubric').addEventListener('change', (e) => {
  normativeFile = e.target.files[0];
  if (normativeFile) {
    document.getElementById('card-normative-rubric').classList.add('has-file');
    document.getElementById('name-normative-rubric').textContent = '✓ ' + normativeFile.name;
    setStepState('step-upload', 'done');
  } else {
    document.getElementById('card-normative-rubric').classList.remove('has-file');
    setStepState('step-upload', '');
  }
  checkReady();
});

function checkReady() {
  document.getElementById('btn-generate-rubric').disabled = !normativeFile;
}

// ── Generate Rubric ──
document.getElementById('btn-generate-rubric').addEventListener('click', generateRubric);

async function generateRubric() {
  const btn = document.getElementById('btn-generate-rubric');
  btn.disabled = true;
  btn.textContent = '⏳ Generando...';

  const progress = document.getElementById('rubric-progress');
  progress.classList.add('active');
  document.getElementById('rubric-preview').classList.remove('visible');
  document.getElementById('btn-download-rubric').style.display = 'none';
  document.getElementById('btn-clear-rubric').style.display = 'none';

  setStepState('step-ontology', 'active');
  setStepState('step-rubric', '');
  setStepState('step-preview', '');
  updateProgressStatus('Extrayendo texto del documento normativo...');

  try {
    // Brief delay for UX
    await sleep(500);
    updateProgressStatus('Extrayendo ontología de requisitos con IA...');
    setStepState('step-ontology', 'active');

    const formData = new FormData();
    formData.append('normative', normativeFile);

    const res = await fetch('/api/rubric', { method: 'POST', body: formData });

    // Update steps as response arrives
    setStepState('step-ontology', 'done');
    setStepState('step-rubric', 'active');
    updateProgressStatus('Generando rúbrica holística con Gemini...');
    await sleep(300);

    const json = await res.json();

    if (!json.success) throw new Error(json.error);

    rubricData = json.data;
    pdfBase64 = json.pdfBase64;

    setStepState('step-rubric', 'done');
    setStepState('step-preview', 'active');
    updateProgressStatus('Renderizando vista previa...');
    await sleep(400);

    progress.classList.remove('active');
    renderRubricPreview(rubricData);

    setStepState('step-preview', 'done');

    // Show action buttons
    if (pdfBase64) {
      const dlBtn = document.getElementById('btn-download-rubric');
      dlBtn.href = 'data:application/pdf;base64,' + pdfBase64;
      dlBtn.download = 'rubrica_' + normativeFile.name.replace(/\.pdf$/i, '') + '.pdf';
      dlBtn.style.display = 'inline-flex';
    }
    document.getElementById('btn-clear-rubric').style.display = 'inline-flex';

    toast('Rúbrica generada exitosamente', 'success');
  } catch (err) {
    progress.classList.remove('active');
    setStepState('step-ontology', '');
    setStepState('step-rubric', '');
    setStepState('step-preview', '');
    toast('Error: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '📝 Generar Rúbrica';
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
      setStepState('step-ontology', 'done');
      setStepState('step-rubric', 'done');
      renderRubricPreview(rubricData);
      setStepState('step-preview', 'done');
      
      if (pdfBase64) {
        const dlBtn = document.getElementById('btn-download-rubric');
        dlBtn.href = 'data:application/pdf;base64,' + pdfBase64;
        dlBtn.download = 'rubrica_' + (rubricData.normativeDocument || 'documento').replace(/\.pdf$/i, '') + '.pdf';
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
  if (!confirm('¿Estás seguro de que quieres borrar toda la base de datos? Esta acción no se puede deshacer y eliminará todos los documentos, comparaciones y rúbricas.')) {
    return;
  }

  const btn = document.getElementById('btn-clear-rubric');
  btn.disabled = true;
  btn.textContent = '⏳ Borrando todo...';

  try {
    const res = await fetch('/api/graph/clear', { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error || 'Error al limpiar la base de datos');
    
    rubricData = null;
    pdfBase64 = null;
    normativeFile = null;

    document.getElementById('file-normative-rubric').value = '';
    document.getElementById('card-normative-rubric').classList.remove('has-file');
    document.getElementById('name-normative-rubric').textContent = '';
    document.getElementById('rubric-preview').classList.remove('visible');
    document.getElementById('btn-download-rubric').style.display = 'none';
    document.getElementById('btn-clear-rubric').style.display = 'none';
    document.getElementById('rubric-dimensions-container').innerHTML = '';
    document.getElementById('btn-generate-rubric').disabled = true;

    setStepState('step-upload', '');
    setStepState('step-ontology', '');
    setStepState('step-rubric', '');
    setStepState('step-preview', '');

    toast('Base de datos y rúbricas eliminadas por completo', 'success');
  } catch (err) {
    toast('Error al limpiar la base de datos: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '🗑️ Limpiar Todo';
  }
});

// ── Render Rubric Preview ──
function renderRubricPreview(rubric) {
  document.getElementById('rubric-doc-name').textContent = rubric.normativeDocument || '—';
  document.getElementById('rubric-criteria-count').textContent = rubric.criteria.length + ' componentes';

  // Count unique dimensions
  const dims = new Set(rubric.criteria.map(c => c.dimension));
  document.getElementById('rubric-dimensions-count').textContent = dims.size + ' dimensiones';
  document.getElementById('rubric-total-weight').textContent = rubric.totalWeight + ' pts máx.';

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
        <span class="dimension-name">DIMENSIÓN ${dimIndex}: ${esc(dimName).toUpperCase()}</span>
        <span class="dimension-count">${criteria.length} componente${criteria.length > 1 ? 's' : ''}</span>
      </div>
      <table class="criteria-table">
        <thead>
          <tr>
            <th class="th-criterion">Componente Evaluado</th>
            <th class="th-criterion" style="background:#475569; width:20%;">Criterio de Calidad Institucional</th>
            <th class="th-excellent">Cumple Totalmente (2 pts)</th>
            <th class="th-acceptable">Cumple Parcialmente (1 pt)</th>
            <th class="th-insufficient">No Cumple (0 pts)</th>
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
                <strong>ÓPTIMO</strong><br>
                ${esc(c.levels.full)}
              </td>
              <td class="td-acceptable">
                <strong>ACEPTABLE CON OBSERVACIÓN</strong><br>
                ${esc(c.levels.partial)}
              </td>
              <td class="td-insufficient">
                <strong>DEFICIENTE / CRÍTICO</strong><br>
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
