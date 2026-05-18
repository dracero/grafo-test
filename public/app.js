/**
 * PDF Knowledge Graph Explorer — Frontend Application
 * D3.js force-directed graph visualization with interactive controls.
 */

const API = '';
const ENTITY_COLORS = {
  PERSON: '#F472B6', ORGANIZATION: '#60A5FA', LOCATION: '#34D399',
  CONCEPT: '#FBBF24', DATE: '#A78BFA', OTHER: '#9CA3AF',
  Entity: '#60A5FA'
};

// ── State ──
let graphData = { nodes: [], edges: [] };
let simulation, svg, g, linkGroup, nodeGroup, labelGroup, linkLabelGroup;
let zoom;
let activeFilters = new Set();
let selectedNode = null;
let showOnlyConcordant = false;

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  initGraph();
  loadGraph();
  bindEvents();
});

function bindEvents() {
  document.getElementById('btn-refresh').addEventListener('click', loadGraph);
  document.getElementById('btn-process').addEventListener('click', processPDFs);
  document.getElementById('btn-clear-db').addEventListener('click', clearDatabase);
  document.getElementById('btn-search').addEventListener('click', doSearch);
  document.getElementById('search-input').addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  document.getElementById('node-panel-close').addEventListener('click', closeNodePanel);
  document.getElementById('zoom-in').addEventListener('click', () => zoomBy(1.4));
  document.getElementById('zoom-out').addEventListener('click', () => zoomBy(0.7));
  document.getElementById('zoom-reset').addEventListener('click', zoomReset);

  const concordantCheckbox = document.getElementById('filter-concordant');
  if (concordantCheckbox) {
    concordantCheckbox.addEventListener('change', (e) => {
      showOnlyConcordant = e.target.checked;
      applyFilters();
    });
  }
}

// ── Graph Setup ──
function initGraph() {
  const container = document.getElementById('graph-container');
  const w = container.clientWidth;
  const h = container.clientHeight;

  svg = d3.select('#graph-svg');
  svg.selectAll('*').remove();

  // Defs for glow filters
  const defs = svg.append('defs');
  const filter = defs.append('filter').attr('id', 'glow');
  filter.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'coloredBlur');
  const merge = filter.append('feMerge');
  merge.append('feMergeNode').attr('in', 'coloredBlur');
  merge.append('feMergeNode').attr('in', 'SourceGraphic');

  // Arrow markers
  defs.append('marker').attr('id', 'arrowhead').attr('viewBox', '0 -5 10 10')
    .attr('refX', 20).attr('refY', 0).attr('markerWidth', 6).attr('markerHeight', 6)
    .attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L10,0L0,4').attr('fill', '#6B7280').attr('opacity', 0.5);

  g = svg.append('g');
  linkGroup = g.append('g').attr('class', 'links');
  linkLabelGroup = g.append('g').attr('class', 'link-labels');
  nodeGroup = g.append('g').attr('class', 'nodes');
  labelGroup = g.append('g').attr('class', 'labels');

  zoom = d3.zoom().scaleExtent([0.1, 8]).on('zoom', e => g.attr('transform', e.transform));
  svg.call(zoom);

  simulation = d3.forceSimulation()
    .force('link', d3.forceLink().id(d => d.id).distance(120))
    .force('charge', d3.forceManyBody().strength(-300))
    .force('center', d3.forceCenter(w / 2, h / 2))
    .force('collision', d3.forceCollide().radius(30))
    .on('tick', ticked);

  simulation.stop();
}

function ticked() {
  linkGroup.selectAll('.link')
    .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
    .attr('x2', d => d.target.x).attr('y2', d => d.target.y);

  linkLabelGroup.selectAll('.link-label')
    .attr('x', d => (d.source.x + d.target.x) / 2)
    .attr('y', d => (d.source.y + d.target.y) / 2);

  nodeGroup.selectAll('.node-group')
    .attr('transform', d => `translate(${d.x},${d.y})`);
}

// ── Load Graph Data ──
async function loadGraph() {
  showLoading('Cargando grafo...');
  try {
    const res = await fetch(`${API}/api/graph/raw`);
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    graphData = json.data;
    updateStats(json.stats);
    renderGraph();
    await loadStats();
    hideLoading();

    if (graphData.nodes.length === 0) {
      document.getElementById('empty-state').classList.remove('hidden');
    } else {
      document.getElementById('empty-state').classList.add('hidden');
    }

    toast('Grafo cargado correctamente', 'success');
  } catch (err) {
    hideLoading();
    console.error('Error loading graph:', err);
    document.getElementById('empty-state').classList.remove('hidden');
    toast('Error cargando el grafo: ' + err.message, 'error');
  }
}

async function loadStats() {
  try {
    const res = await fetch(`${API}/api/stats`);
    const json = await res.json();
    if (!json.success) return;
    const d = json.data;

    document.getElementById('stat-nodes').textContent = d.totalNodes;
    document.getElementById('stat-edges').textContent = d.totalRelationships;
    document.getElementById('stat-docs').textContent = d.documentBreakdown?.length || 0;

    buildFilters(d.typeBreakdown || []);
    buildLegend(d.typeBreakdown || []);
    buildDocList(d.documentBreakdown || []);
  } catch (e) { console.error('Stats error', e); }
}

function updateStats(stats) {
  if (!stats) return;
  document.getElementById('stat-nodes').textContent = stats.nodeCount;
  document.getElementById('stat-edges').textContent = stats.edgeCount;
}

// ── Render Graph ──
function renderGraph() {
  const nodes = graphData.nodes.map(n => ({ ...n }));
  const edges = graphData.edges.map(e => ({ ...e }));

  // Remove edges with missing source/target
  const nodeIds = new Set(nodes.map(n => n.id));
  const validEdges = edges.filter(e => nodeIds.has(e.source) && nodeIds.has(e.target));

  // Links
  const links = linkGroup.selectAll('.link').data(validEdges, d => d.id);
  links.exit().remove();
  links.enter().append('line')
    .attr('class', 'link')
    .attr('stroke', '#4B5563')
    .attr('stroke-width', 1.2)
    .attr('marker-end', 'url(#arrowhead)');

  // Link Labels
  const ll = linkLabelGroup.selectAll('.link-label').data(validEdges, d => d.id);
  ll.exit().remove();
  ll.enter().append('text').attr('class', 'link-label').text(d => d.label);

  // Nodes
  const nodeGrps = nodeGroup.selectAll('.node-group').data(nodes, d => d.id);
  nodeGrps.exit().remove();

  const enter = nodeGrps.enter().append('g').attr('class', 'node-group');

  enter.append('circle')
    .attr('class', 'node-circle')
    .attr('r', d => getNodeRadius(d))
    .attr('fill', d => getNodeColor(d))
    .attr('stroke', d => d3.color(getNodeColor(d)).darker(0.4))
    .attr('filter', 'url(#glow)')
    .on('click', (event, d) => onNodeClick(d))
    .on('mouseenter', (event, d) => highlightNode(d))
    .on('mouseleave', () => clearHighlight());

  enter.append('text')
    .attr('class', 'node-label')
    .attr('dy', d => getNodeRadius(d) + 14)
    .text(d => truncate(d.label, 18));

  // Drag
  enter.call(d3.drag()
    .on('start', (event, d) => {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      d.fx = d.x; d.fy = d.y;
    })
    .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
    .on('end', (event, d) => {
      if (!event.active) simulation.alphaTarget(0);
      d.fx = null; d.fy = null;
    }));

  // Update simulation
  simulation.nodes(nodes);
  simulation.force('link').links(validEdges);
  simulation.alpha(1).restart();
}

function getNodeColor(d) {
  return ENTITY_COLORS[d.type] || ENTITY_COLORS.OTHER;
}

function getNodeRadius(d) {
  return 10;
}

function truncate(str, len) {
  return str && str.length > len ? str.substring(0, len) + '…' : str || '';
}

// ── Node Interactions ──
function onNodeClick(d) {
  selectedNode = d;
  const panel = document.getElementById('node-panel');
  const title = document.getElementById('node-panel-title');
  const body = document.getElementById('node-panel-body');

  title.textContent = d.label || d.id;

  const color = getNodeColor(d);
  const props = d.properties || {};

  let html = `
    <div class="node-detail-section">
      <div class="node-detail-label">Tipo</div>
      <div><span class="node-type-badge" style="background:${color}20;color:${color};border:1px solid ${color}40">${d.type}</span></div>
    </div>`;

  if (props.sourceText) {
    html += `
    <div class="node-detail-section">
      <div class="node-detail-label">Texto Fuente</div>
      <div class="node-detail-value">${escapeHtml(props.sourceText)}</div>
    </div>`;
  }

  if (props.documents && props.documents.length > 0) {
    html += `
    <div class="node-detail-section">
      <div class="node-detail-label">Documentos</div>
      <div class="node-detail-value">${props.documents.map(doc => `<div>📄 ${escapeHtml(doc)}</div>`).join('')}</div>
    </div>`;
  }

  // Show connections
  const connections = graphData.edges.filter(e =>
    e.source === d.id || e.target === d.id ||
    (e.source && e.source.id === d.id) || (e.target && e.target.id === d.id)
  );

  if (connections.length > 0) {
    html += `
    <div class="node-detail-section">
      <div class="node-detail-label">Conexiones (${connections.length})</div>
      <div class="node-connections">
        ${connections.map(c => {
          const isSource = (c.source === d.id || (c.source && c.source.id === d.id));
          const other = isSource ? (typeof c.target === 'string' ? c.target : c.target.id) : (typeof c.source === 'string' ? c.source : c.source.id);
          const arrow = isSource ? '→' : '←';
          return `<div class="node-connection-item">
            <span class="connection-arrow">${arrow}</span>
            <span class="connection-type">${c.label}</span>
            <span>${truncate(other, 22)}</span>
          </div>`;
        }).join('')}
      </div>
    </div>`;
  }

  // Extra properties
  const skipKeys = ['name', 'type', 'sourceText', 'documents', 'embedding', 'id'];
  const extraProps = Object.entries(props).filter(([k]) => !skipKeys.includes(k));
  if (extraProps.length > 0) {
    html += `
    <div class="node-detail-section">
      <div class="node-detail-label">Propiedades</div>
      ${extraProps.map(([k, v]) => `<div class="node-detail-value"><strong>${k}:</strong> ${escapeHtml(String(v))}</div>`).join('')}
    </div>`;
  }

  body.innerHTML = html;
  panel.classList.remove('hidden');
}

function closeNodePanel() {
  document.getElementById('node-panel').classList.add('hidden');
  selectedNode = null;
  clearHighlight();
}

function highlightNode(d) {
  const connectedIds = new Set([d.id]);
  graphData.edges.forEach(e => {
    const sid = typeof e.source === 'string' ? e.source : e.source.id;
    const tid = typeof e.target === 'string' ? e.target : e.target.id;
    if (sid === d.id) connectedIds.add(tid);
    if (tid === d.id) connectedIds.add(sid);
  });

  nodeGroup.selectAll('.node-group')
    .classed('highlighted', n => n.id === d.id)
    .classed('dimmed', n => !connectedIds.has(n.id));

  linkGroup.selectAll('.link')
    .classed('highlighted', l => {
      const sid = typeof l.source === 'string' ? l.source : l.source.id;
      const tid = typeof l.target === 'string' ? l.target : l.target.id;
      return sid === d.id || tid === d.id;
    })
    .classed('dimmed', l => {
      const sid = typeof l.source === 'string' ? l.source : l.source.id;
      const tid = typeof l.target === 'string' ? l.target : l.target.id;
      return sid !== d.id && tid !== d.id;
    });
}

function clearHighlight() {
  nodeGroup.selectAll('.node-group').classed('highlighted', false).classed('dimmed', false);
  linkGroup.selectAll('.link').classed('highlighted', false).classed('dimmed', false);
}

// ── Sidebar Builders ──
function buildFilters(types) {
  const container = document.getElementById('type-filters');
  if (!types.length) { container.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted)">Sin datos</span>'; return; }

  activeFilters = new Set(types.map(t => t.type));
  container.innerHTML = types.map(t => {
    const color = ENTITY_COLORS[t.type] || ENTITY_COLORS.OTHER;
    return `<div class="filter-item active" data-type="${t.type}">
      <div class="filter-checkbox"></div>
      <div class="filter-dot" style="background:${color}"></div>
      <span class="filter-label">${t.type}</span>
      <span class="filter-count">${t.count}</span>
    </div>`;
  }).join('');

  container.querySelectorAll('.filter-item').forEach(el => {
    el.addEventListener('click', () => {
      const type = el.dataset.type;
      el.classList.toggle('active');
      if (activeFilters.has(type)) activeFilters.delete(type);
      else activeFilters.add(type);
      applyFilters();
    });
  });
}

function applyFilters() {
  let validNodeIds = null;
  if (showOnlyConcordant) {
    validNodeIds = new Set();
    graphData.edges.forEach(e => {
      if (e.label === 'EVALUATED_AGAINST' && e.properties && e.properties.status === 'covered') {
        const sid = typeof e.source === 'string' ? e.source : e.source.id;
        const tid = typeof e.target === 'string' ? e.target : e.target.id;
        validNodeIds.add(sid);
        validNodeIds.add(tid);
        
        graphData.edges.forEach(e2 => {
          if (e2.label === 'EXTRACTED_FROM') {
            const e2sid = typeof e2.source === 'string' ? e2.source : e2.source.id;
            if (e2sid === tid) {
              const e2tid = typeof e2.target === 'string' ? e2.target : e2.target.id;
              validNodeIds.add(e2tid);
            }
          }
        });
      }
    });
  }

  nodeGroup.selectAll('.node-group').each(function(d) {
    let visible = activeFilters.has(d.type);

    if (showOnlyConcordant && validNodeIds) {
      if (!validNodeIds.has(d.id)) visible = false;
    }

    d3.select(this).style('display', visible ? null : 'none');
  });

  linkGroup.selectAll('.link').each(function(d) {
    const sid = typeof d.source === 'string' ? d.source : d.source.id;
    const tid = typeof d.target === 'string' ? d.target : d.target.id;
    const sNode = graphData.nodes.find(n => n.id === sid);
    const tNode = graphData.nodes.find(n => n.id === tid);
    let visible = sNode && tNode && activeFilters.has(sNode.type) && activeFilters.has(tNode.type);

    if (showOnlyConcordant && validNodeIds) {
      if (!validNodeIds.has(sid) || !validNodeIds.has(tid)) visible = false;
    }

    d3.select(this).style('display', visible ? null : 'none');
  });
}

function buildLegend(types) {
  const container = document.getElementById('legend');
  if (!types.length) { container.innerHTML = ''; return; }
  container.innerHTML = types.map(t => {
    const color = ENTITY_COLORS[t.type] || ENTITY_COLORS.OTHER;
    return `<div class="legend-item"><div class="legend-dot" style="background:${color};color:${color}"></div>${t.type}</div>`;
  }).join('');
}

function buildDocList(docs) {
  const container = document.getElementById('doc-list');
  if (!docs.length) { container.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted)">Sin documentos</span>'; return; }
  container.innerHTML = docs.map(d =>
    `<div class="doc-item"><span class="doc-icon">📄</span>${truncate(d.document, 22)}<span class="doc-count">${d.entityCount}</span></div>`
  ).join('');
}

// ── Process PDFs ──
async function clearDatabase() {
  // Confirm with user
  if (!confirm('⚠️ ¿Estás seguro de que quieres borrar TODA la base de datos?\n\nEsta acción eliminará:\n• Todos los nodos\n• Todas las relaciones\n• Todos los índices\n• Todos los constraints\n\nEsta acción NO se puede deshacer.')) {
    return;
  }

  const btn = document.getElementById('btn-clear-db');
  const originalHTML = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dots">Borrando...</span>';
  
  showLoading('Limpiando base de datos...');
  toast('Borrando toda la base de datos...', 'info');

  try {
    const res = await fetch(`${API}/api/database/clear`, { method: 'DELETE' });
    const json = await res.json();
    
    if (!json.success) throw new Error(json.error);

    const data = json.data;
    toast(`Base de datos limpiada: ${data.deletedNodes} nodos, ${data.deletedRelationships} relaciones eliminadas`, 'success');
    
    // Clear the graph visualization
    graphData = { nodes: [], edges: [] };
    renderGraph();
    
    // Show empty state
    document.getElementById('empty-state').classList.remove('hidden');
    
    // Reset stats
    document.getElementById('stat-nodes').textContent = '0';
    document.getElementById('stat-edges').textContent = '0';
    document.getElementById('stat-docs').textContent = '0';
    
    // Clear filters and legend
    document.getElementById('type-filters').innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted)">Sin datos</span>';
    document.getElementById('legend').innerHTML = '';
    document.getElementById('doc-list').innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted)">Sin documentos</span>';
    
    hideLoading();
  } catch (err) {
    hideLoading();
    toast('Error limpiando la base de datos: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalHTML;
  }
}

async function processPDFs() {
  const btn = document.getElementById('btn-process');
  btn.disabled = true;
  btn.innerHTML = '<span class="loading-dots">Procesando...</span>';
  toast('Procesando PDFs... esto puede tardar un momento', 'info');

  try {
    const res = await fetch(`${API}/api/process`, { method: 'POST' });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    const data = json.data;
    toast(`Procesados ${data.processed} archivos`, 'success');
    await loadGraph();
  } catch (err) {
    toast('Error procesando PDFs: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 12.5A5.5 5.5 0 1 1 8 2.5 5.5 5.5 0 0 1 8 13.5zM10.5 8L7 5.5v5L10.5 8z"/></svg> Procesar PDFs';
  }
}

// ── Search ──
async function doSearch() {
  const query = document.getElementById('search-input').value.trim();
  if (!query) return;

  const container = document.getElementById('search-results');
  container.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted)">Buscando...</span>';

  try {
    const res = await fetch(`${API}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 10 })
    });
    const json = await res.json();
    if (!json.success) throw new Error(json.error);

    if (json.data.length === 0) {
      container.innerHTML = '<span style="font-size:0.78rem;color:var(--text-muted)">Sin resultados</span>';
      return;
    }

    container.innerHTML = json.data.map(r => {
      const color = ENTITY_COLORS[r.entity?.type] || ENTITY_COLORS.OTHER;
      return `<div class="search-result-item" data-node-id="${r.nodeId}">
        <span>${r.entity?.name || r.nodeId}</span>
        <span class="search-result-type" style="background:${color}20;color:${color}">${r.entity?.type || ''}</span>
        <span class="search-result-score">${(r.similarity * 100).toFixed(0)}%</span>
      </div>`;
    }).join('');

    container.querySelectorAll('.search-result-item').forEach(el => {
      el.addEventListener('click', () => {
        const nodeId = el.dataset.nodeId;
        const node = graphData.nodes.find(n => n.id === nodeId);
        if (node) {
          onNodeClick(node);
          highlightNode(node);
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<span style="font-size:0.78rem;color:var(--accent-rose)">${err.message}</span>`;
  }
}

// ── Zoom ──
function zoomBy(factor) {
  svg.transition().duration(300).call(zoom.scaleBy, factor);
}
function zoomReset() {
  const container = document.getElementById('graph-container');
  svg.transition().duration(500).call(zoom.transform,
    d3.zoomIdentity.translate(container.clientWidth / 2, container.clientHeight / 2).scale(1).translate(-container.clientWidth / 2, -container.clientHeight / 2)
  );
}

// ── Utilities ──
function showLoading(msg) {
  const overlay = document.getElementById('loading-overlay');
  overlay.querySelector('.loading-subtitle').textContent = msg || '';
  overlay.classList.remove('hidden');
}

function hideLoading() {
  document.getElementById('loading-overlay').classList.add('hidden');
}

function toast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('toast-exit');
    setTimeout(() => el.remove(), 200);
  }, 4000);
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
