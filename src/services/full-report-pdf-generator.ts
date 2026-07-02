/**
 * Full Report PDF Generator
 *
 * Generates a professional PDF report documenting the COMPLETE comparison
 * results (covered, partial, and missing) — the same information visible
 * on screen — as a downloadable/printable annex.
 */

import PDFDocumentKit from 'pdfkit';
import { createLogger } from './logger';
import type { ComparisonReport, ComparisonResult } from './comparison';

const logger = createLogger();

// ── Color palette (matches UI) ───────────────────────────────────────────────
const COLORS = {
  covered:     '#16a34a',
  coveredBg:   '#f0fdf4',
  coveredBdr:  '#bbf7d0',
  partial:     '#d97706',
  partialBg:   '#fffbeb',
  partialBdr:  '#fde68a',
  missing:     '#dc2626',
  missingBg:   '#fef2f2',
  missingBdr:  '#fecaca',
  headerBar:   '#1e40af',
  titleDark:   '#1e293b',
  textDark:    '#334155',
  textBody:    '#475569',
  textMuted:   '#64748b',
  textLight:   '#94a3b8',
  bgLight:     '#f8fafc',
  bgBox:       '#ffffff',
  border:      '#e2e8f0',
  borderLight: '#cbd5e1',
  accent:      '#8b5cf6',
};

const STATUS_ICON: Record<string, string> = {
  covered: '✓',
  partial: '◐',
  missing: '✗',
};

const STATUS_LABEL: Record<string, string> = {
  covered: 'CUBIERTO',
  partial: 'PARCIAL',
  missing: 'FALTANTE',
};

/**
 * Generates a professional PDF report of the full comparison.
 */
export async function generateFullReportPDF(
  report: ComparisonReport,
  corrections?: any[]
): Promise<Buffer> {
  logger.info('FullReportPDF', `Generating full report for: ${report.programDocument} (${report.results.length} items)`);

  return new Promise((resolve, reject) => {
    try {
      const chunks: Buffer[] = [];
      const doc = new PDFDocumentKit({
        size: 'A4',
        margins: { top: 54, bottom: 60, left: 54, right: 54 },
        bufferPages: true,
      });

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const margin = 54;
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const writeWidth = pageWidth - margin * 2;
      const availableY = () => pageHeight - 60 - margin;
      const ensureSpace = (needed: number) => {
        if (doc.y + needed > availableY()) {
          doc.addPage();
        }
      };

      const s = report.summary;
      const programTitle = report.programDocument.replace(/\.pdf$/i, '').replace(/_/g, ' ');
      const normativeTitle = report.normativeDocument.replace(/\.pdf$/i, '').replace(/_/g, ' ');

      // ── COVER / HEADER ─────────────────────────────────────────────────
      doc.rect(0, 0, pageWidth, 10).fill(COLORS.accent);

      doc.moveDown(3);

      doc.fillColor(COLORS.titleDark)
         .font('Helvetica-Bold')
         .fontSize(22)
         .text('INFORME DE COMPARACIÓN COMPLETO', { align: 'left' });

      doc.moveDown(0.2);

      doc.fillColor(COLORS.textBody)
         .font('Helvetica-Bold')
         .fontSize(10)
         .text('ANÁLISIS DE CUMPLIMIENTO CURRICULAR Y REGULATORIO', { align: 'left' });

      doc.moveDown(1.5);

      // ── METADATA BOX ──────────────────────────────────────────────────
      const metaY = doc.y;
      doc.rect(margin, metaY, writeWidth, 90)
         .lineWidth(1)
         .strokeColor(COLORS.border)
         .fillAndStroke(COLORS.bgLight, COLORS.border);

      doc.fillColor(COLORS.textDark).fontSize(9.5);

      doc.font('Helvetica-Bold')
         .text('Programa Evaluado:', margin + 15, metaY + 15, { continued: true })
         .font('Helvetica')
         .text(`  ${programTitle}`);

      doc.font('Helvetica-Bold')
         .text('Marco Normativo:', margin + 15, metaY + 35, { continued: true })
         .font('Helvetica')
         .text(`  ${normativeTitle}`);

      doc.font('Helvetica-Bold')
         .text('Fecha de Análisis:', margin + 15, metaY + 55, { continued: true })
         .font('Helvetica')
         .text(`  ${new Date(report.timestamp || Date.now()).toLocaleDateString('es-AR', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} h`);

      // Coverage metrics box (right side)
      const metricsX = margin + writeWidth - 180;
      doc.rect(metricsX, metaY + 10, 165, 70).fill(COLORS.bgBox);
      doc.rect(metricsX, metaY + 10, 165, 70).lineWidth(0.5).strokeColor(COLORS.borderLight);

      doc.fillColor(COLORS.titleDark)
         .font('Helvetica-Bold')
         .fontSize(8)
         .text('CUMPLIMIENTO GENERAL', metricsX + 10, metaY + 18, { align: 'center', width: 145 });

      const pctColor = s.coveragePercent >= 75 ? COLORS.covered : s.coveragePercent >= 50 ? COLORS.partial : COLORS.missing;
      doc.fillColor(pctColor)
         .font('Helvetica-Bold')
         .fontSize(22)
         .text(`${s.coveragePercent}%`, metricsX + 10, metaY + 30, { align: 'center', width: 145 });

      doc.fillColor(COLORS.textMuted)
         .font('Helvetica')
         .fontSize(7.5)
         .text(`${s.covered} cubiertos | ${s.partial} parciales | ${s.missing} faltantes`, metricsX + 10, metaY + 56, { align: 'center', width: 145 });

      doc.y = metaY + 105;

      // ── SUMMARY CARDS ─────────────────────────────────────────────────
      const cardW = (writeWidth - 12) / 4;
      const cardH = 48;
      const cardY = doc.y;

      const summaryItems = [
        { label: 'TOTAL', value: s.total, color: '#06b6d4' },
        { label: 'CUBIERTOS', value: s.covered, color: COLORS.covered },
        { label: 'PARCIALES', value: s.partial, color: COLORS.partial },
        { label: 'FALTANTES', value: s.missing, color: COLORS.missing },
      ];

      for (let i = 0; i < summaryItems.length; i++) {
        const item = summaryItems[i];
        const x = margin + i * (cardW + 4);

        doc.rect(x, cardY, cardW, cardH)
           .lineWidth(0.5)
           .strokeColor(COLORS.border)
           .fillAndStroke(COLORS.bgLight, COLORS.border);

        doc.rect(x, cardY, cardW, 3).fill(item.color);

        doc.fillColor(item.color)
           .font('Helvetica-Bold')
           .fontSize(18)
           .text(String(item.value), x, cardY + 10, { width: cardW, align: 'center' });

        doc.fillColor(COLORS.textMuted)
           .font('Helvetica-Bold')
           .fontSize(6.5)
           .text(item.label, x, cardY + 32, { width: cardW, align: 'center' });
      }

      doc.y = cardY + cardH + 12;

      // ── COVERAGE BAR ──────────────────────────────────────────────────
      doc.fillColor(COLORS.textDark)
         .font('Helvetica-Bold')
         .fontSize(9)
         .text('Gráfica de Cumplimiento:');

      doc.moveDown(0.3);

      const trackY = doc.y;
      const trackH = 10;
      doc.rect(margin, trackY, writeWidth, trackH).fill(COLORS.border);

      const total = s.total || 1;
      const wCov = (s.covered / total) * writeWidth;
      const wPar = (s.partial / total) * writeWidth;
      const wMis = (s.missing / total) * writeWidth;

      if (wCov > 0) doc.rect(margin, trackY, wCov, trackH).fill(COLORS.covered);
      if (wPar > 0) doc.rect(margin + wCov, trackY, wPar, trackH).fill('#fbbf24');
      if (wMis > 0) doc.rect(margin + wCov + wPar, trackY, wMis, trackH).fill('#f87171');

      doc.y = trackY + 18;

      // Legend
      const legendItems = [
        { label: `Cubierto (${(s.covered / total * 100).toFixed(1)}%)`, color: COLORS.covered },
        { label: `Parcial (${(s.partial / total * 100).toFixed(1)}%)`, color: '#fbbf24' },
        { label: `Faltante (${(s.missing / total * 100).toFixed(1)}%)`, color: '#f87171' },
      ];
      const legendY = doc.y;
      let legendX = margin;
      for (const li of legendItems) {
        doc.rect(legendX, legendY, 8, 8).fill(li.color);
        doc.fillColor(COLORS.textMuted)
           .font('Helvetica')
           .fontSize(7.5)
           .text(li.label, legendX + 12, legendY, { continued: false });
        legendX += 130;
      }

      doc.y = legendY + 18;

      // ── Separator ─────────────────────────────────────────────────────
      doc.strokeColor(COLORS.border)
         .lineWidth(0.5)
         .moveTo(margin, doc.y)
         .lineTo(pageWidth - margin, doc.y)
         .stroke();

      doc.moveDown(1);

      // ── Section header ────────────────────────────────────────────────
      doc.fillColor(COLORS.titleDark)
         .font('Helvetica-Bold')
         .fontSize(13)
         .text(`DETALLE POR REQUISITO (${report.results.length})`);

      doc.moveDown(0.8);

      // Build corrections lookup
      const corrMap = new Map<string, any>();
      if (corrections && corrections.length > 0) {
        for (const c of corrections) {
          if (c.gapId) corrMap.set(c.gapId.toLowerCase(), c);
        }
      }

      // ── RENDER EACH RESULT ────────────────────────────────────────────
      for (let idx = 0; idx < report.results.length; idx++) {
        const r = report.results[idx];
        const statusColor = COLORS[r.status] || COLORS.missing;
        const statusBg = r.status === 'covered' ? COLORS.coveredBg : r.status === 'partial' ? COLORS.partialBg : COLORS.missingBg;
        const statusBdr = r.status === 'covered' ? COLORS.coveredBdr : r.status === 'partial' ? COLORS.partialBdr : COLORS.missingBdr;

        // Pre-measure
        const evH = r.evidence ? doc.heightOfString(r.evidence, { width: writeWidth - 24 }) + 20 : 0;
        const sugH = r.suggestion ? doc.heightOfString(r.suggestion, { width: writeWidth - 24 }) + 20 : 0;
        const minH = 45 + evH + sugH;
        ensureSpace(Math.min(minH, 100));

        // Card top strip
        const rowY = doc.y;
        doc.rect(margin, rowY, writeWidth, 5).fill(statusColor);

        // Status badge + ID + Category + Requirement
        doc.fillColor(statusColor)
           .font('Helvetica-Bold')
           .fontSize(8)
           .text(`${STATUS_ICON[r.status] || '?'} ${STATUS_LABEL[r.status] || r.status.toUpperCase()}`, margin + 8, rowY + 10);

        doc.fillColor(COLORS.textMuted)
           .font('Helvetica-Bold')
           .fontSize(7.5)
           .text(r.item.id, margin + 80, rowY + 10);

        const catW = doc.widthOfString(r.item.category) + 10;
        doc.rect(margin + 130, rowY + 8, catW, 14).fill(COLORS.bgLight);
        doc.fillColor('#06b6d4')
           .font('Helvetica-Bold')
           .fontSize(7)
           .text(r.item.category, margin + 135, rowY + 11);

        doc.fillColor(COLORS.titleDark)
           .font('Helvetica-Bold')
           .fontSize(9)
           .text(r.item.requirement, margin + 8, rowY + 28, { width: writeWidth - 16 });

        doc.moveDown(0.4);

        // Evidence box
        if (r.evidence) {
          ensureSpace(evH + 6);
          const eY = doc.y;
          doc.rect(margin + 6, eY, writeWidth - 12, evH)
             .lineWidth(0.5)
             .strokeColor('#06b6d4')
             .fillAndStroke(COLORS.bgLight, '#06b6d4');

          // Left accent bar
          doc.rect(margin + 6, eY, 3, evH).fill('#06b6d4');

          doc.fillColor(COLORS.textMuted)
             .font('Helvetica-Bold')
             .fontSize(6.5)
             .text('EVIDENCIA', margin + 16, eY + 4);

          doc.fillColor(COLORS.textBody)
             .font('Helvetica')
             .fontSize(8)
             .text(r.evidence, margin + 16, eY + 14, { width: writeWidth - 36, lineGap: 1 });

          doc.y = eY + evH + 4;
        }

        // Suggestion box
        if (r.suggestion && r.suggestion !== 'Ninguna') {
          const sH = sugH;
          ensureSpace(sH + 6);
          const sY = doc.y;
          doc.rect(margin + 6, sY, writeWidth - 12, sH)
             .lineWidth(0.5)
             .strokeColor(COLORS.partial)
             .fillAndStroke('#fffbeb', COLORS.partial);

          doc.rect(margin + 6, sY, 3, sH).fill(COLORS.partial);

          doc.fillColor(COLORS.textMuted)
             .font('Helvetica-Bold')
             .fontSize(6.5)
             .text('SUGERENCIA', margin + 16, sY + 4);

          doc.fillColor(COLORS.textBody)
             .font('Helvetica')
             .fontSize(8)
             .text(r.suggestion, margin + 16, sY + 14, { width: writeWidth - 36, lineGap: 1 });

          doc.y = sY + sH + 4;
        }

        // Correction details (if available)
        const corr = corrMap.get((r.item.id || '').toLowerCase());
        if (corr) {
          const corrTextH = doc.heightOfString(corr.correctedText || '', { width: writeWidth - 36 }) + 30;
          ensureSpace(corrTextH + 10);

          const cY = doc.y;
          doc.rect(margin + 6, cY, writeWidth - 12, corrTextH)
             .lineWidth(0.5)
             .strokeColor(COLORS.coveredBdr)
             .fillAndStroke(COLORS.coveredBg, COLORS.coveredBdr);

          doc.rect(margin + 6, cY, 3, corrTextH).fill(COLORS.covered);

          doc.fillColor(COLORS.covered)
             .font('Helvetica-Bold')
             .fontSize(6.5)
             .text('🔧 PROPUESTA DE ADECUACIÓN (ANEXO PDF)', margin + 16, cY + 4);

          // Meta line: section + action + priority
          let metaLine = '';
          if (corr.section) metaLine += `Sección: ${corr.section}`;
          if (corr.action) metaLine += `  |  Acción: ${corr.action}`;
          if (corr.priority) metaLine += `  |  Prioridad: ${corr.priority.toUpperCase()}`;
          if (metaLine) {
            doc.fillColor(COLORS.textMuted)
               .font('Helvetica')
               .fontSize(7)
               .text(metaLine, margin + 16, cY + 14);
          }

          if (corr.justification) {
            doc.fillColor(COLORS.textBody)
               .font('Helvetica-Bold')
               .fontSize(7.5)
               .text('Justificación: ', margin + 16, doc.y + 3, { continued: true })
               .font('Helvetica')
               .text(corr.justification, { width: writeWidth - 36 });
          }

          doc.fillColor(COLORS.titleDark)
             .font('Helvetica')
             .fontSize(8)
             .text(corr.correctedText || '', margin + 16, doc.y + 3, { width: writeWidth - 36, lineGap: 1 });

          doc.y = cY + corrTextH + 4;
        }

        // Card border
        const cardBottom = doc.y;
        doc.rect(margin, rowY, writeWidth, cardBottom - rowY)
           .lineWidth(0.5)
           .strokeColor(statusBdr);

        doc.y = cardBottom + 10;

        // Separator
        if (idx < report.results.length - 1) {
          doc.strokeColor(COLORS.border)
             .lineWidth(0.3)
             .moveTo(margin + 20, doc.y)
             .lineTo(pageWidth - margin - 20, doc.y)
             .stroke();
          doc.moveDown(0.5);
        }
      }

      // ── HEADERS & FOOTERS ─────────────────────────────────────────────
      const pages = doc.bufferedPageRange();
      for (let j = 0; j < pages.count; j++) {
        doc.switchToPage(j);

        const oldBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;

        // Header (skip first page)
        if (j > 0) {
          doc.fontSize(7.5)
             .fillColor(COLORS.textLight)
             .font('Helvetica')
             .text(`INFORME DE COMPARACIÓN — ${programTitle.toUpperCase()}`, margin, 32, { align: 'left' });

          doc.strokeColor(COLORS.border)
             .lineWidth(0.5)
             .moveTo(margin, 44)
             .lineTo(pageWidth - margin, 44)
             .stroke();
        }

        // Footer
        doc.strokeColor(COLORS.border)
           .lineWidth(0.5)
           .moveTo(margin, pageHeight - 42)
           .lineTo(pageWidth - margin, pageHeight - 42)
           .stroke();

        doc.fontSize(7.5)
           .fillColor(COLORS.textLight)
           .font('Helvetica')
           .text('Informe de Auditoría Curricular generado automáticamente.', margin, pageHeight - 32, { align: 'left', continued: true })
           .text(`Pág. ${j + 1} de ${pages.count}`, pageWidth - margin - 80, pageHeight - 32, { width: 80, align: 'right' });

        doc.page.margins.bottom = oldBottom;
      }

      doc.end();
    } catch (error) {
      logger.error('FullReportPDF', 'Error generating full report PDF', error as Error);
      reject(error);
    }
  });
}
