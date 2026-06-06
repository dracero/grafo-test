/**
 * Non-Conformity PDF Generator
 *
 * Generates a professional PDF report documenting only the non-compliance points
 * (partial or missing requirements) detected in a syllabus comparison.
 */

import PDFDocumentKit from 'pdfkit';
import { createLogger } from './logger';
import type { ComparisonReport } from './comparison';

const logger = createLogger();

/**
 * Generates a professional PDF report of non-conformities.
 */
export async function generateNonCompliancePDF(report: ComparisonReport): Promise<Buffer> {
  logger.info('NonCompliancePDF', `Generating report for: ${report.programDocument}`);

  return new Promise((resolve, reject) => {
    try {
      const chunks: Buffer[] = [];
      const doc = new PDFDocumentKit({
        size: 'A4',
        margin: 54,
        bufferPages: true,
      });

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const margin = 54;
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const writeWidth = pageWidth - margin * 2;

      // Filter non-compliance results
      const missingItems = report.results.filter((r) => r.status === 'missing');
      const partialItems = report.results.filter((r) => r.status === 'partial');
      const nonCompliancesCount = missingItems.length + partialItems.length;

      const programTitle = report.programDocument.replace(/\.pdf$/i, '').replace(/_/g, ' ');
      const normativeTitle = report.normativeDocument.replace(/\.pdf$/i, '').replace(/_/g, ' ');

      // ── Header Banner ──────────────────────────────────────────────────
      // Top bar highlight
      doc.rect(0, 0, pageWidth, 12).fill('#991b1b'); // Crimson theme for alerts

      doc.moveDown(3);

      // Title
      doc.fillColor('#1e293b')
         .font('Helvetica-Bold')
         .fontSize(22)
         .text('INFORME DE NO CONFORMIDADES', { align: 'left' });

      doc.moveDown(0.2);

      doc.fillColor('#475569')
         .font('Helvetica-Bold')
         .fontSize(10)
         .text('REVISIÓN DE CUMPLIMIENTO CURRICULAR Y REGULATORIO', { align: 'left' });

      doc.moveDown(1.5);

      // ── Metadata Table / Box ──────────────────────────────────────────
      const metaY = doc.y;
      doc.rect(margin, metaY, writeWidth, 90)
         .lineWidth(1)
         .strokeColor('#e2e8f0')
         .fillAndStroke('#f8fafc', '#e2e8f0');

      doc.fillColor('#334155')
         .fontSize(9.5);

      // Left Column
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

      // Right Column (Metrics Box)
      const metricsX = margin + writeWidth - 180;
      doc.rect(metricsX, metaY + 10, 165, 70)
         .fill('#ffffff');

      // Border around metrics
      doc.rect(metricsX, metaY + 10, 165, 70)
         .lineWidth(0.5)
         .strokeColor('#cbd5e1');

      doc.fillColor('#0f172a')
         .font('Helvetica-Bold')
         .fontSize(8)
         .text('CUMPLIMIENTO GENERAL', metricsX + 10, metaY + 18, { align: 'center', width: 145 });

      const pctColor = report.summary.coveragePercent >= 75 ? '#16a34a' : report.summary.coveragePercent >= 50 ? '#d97706' : '#dc2626';
      doc.fillColor(pctColor)
         .font('Helvetica-Bold')
         .fontSize(22)
         .text(`${report.summary.coveragePercent}%`, metricsX + 10, metaY + 30, { align: 'center', width: 145 });

      doc.fillColor('#64748b')
         .font('Helvetica')
         .fontSize(7.5)
         .text(`${report.summary.covered} cubiertos | ${report.summary.partial} parciales | ${report.summary.missing} faltantes`, metricsX + 10, metaY + 56, { align: 'center', width: 145 });

      doc.y = metaY + 105;

      // ── Compliance progress bar ─────────────────────────────────────────
      doc.fillColor('#334155')
         .font('Helvetica-Bold')
         .fontSize(9)
         .text('Gráfica de Cumplimiento:');

      doc.moveDown(0.3);

      const trackY = doc.y;
      const trackH = 10;
      doc.rect(margin, trackY, writeWidth, trackH)
         .fill('#e2e8f0');

      const total = report.summary.total || 1;
      const wCovered = (report.summary.covered / total) * writeWidth;
      const wPartial = (report.summary.partial / total) * writeWidth;
      const wMissing = (report.summary.missing / total) * writeWidth;

      if (wCovered > 0) doc.rect(margin, trackY, wCovered, trackH).fill('#16a34a');
      if (wPartial > 0) doc.rect(margin + wCovered, trackY, wPartial, trackH).fill('#fbbf24');
      if (wMissing > 0) doc.rect(margin + wCovered + wPartial, trackY, wMissing, trackH).fill('#f87171');

      doc.y = trackY + 22;

      // ── Summary message ─────────────────────────────────────────────────
      if (nonCompliancesCount === 0) {
        doc.moveDown(2);
        const alertY = doc.y;
        doc.rect(margin, alertY, writeWidth, 70)
           .lineWidth(1)
           .strokeColor('#bbf7d0')
           .fillAndStroke('#f0fdf4', '#bbf7d0');

        doc.fillColor('#15803d')
           .font('Helvetica-Bold')
           .fontSize(12)
           .text('¡ENHORABUENA! CUMPLIMIENTO TOTAL', margin + 15, alertY + 16);

        doc.fillColor('#166534')
           .font('Helvetica')
           .fontSize(9)
           .text('El programa analizado cumple en su totalidad con los requisitos normativos del documento de referencia. No se han detectado brechas de cumplimiento ni no conformidades en este análisis.', margin + 15, alertY + 36, { width: writeWidth - 30 });
        
        doc.y = alertY + 80;
      } else {
        doc.moveDown(1.5);
        doc.fillColor('#475569')
           .font('Helvetica')
           .fontSize(9)
           .text(
             `Se han identificado un total de ${nonCompliancesCount} no conformidades en la guía docente. ` +
             `A continuación se desglosan por nivel de severidad, detallando la evidencia en el texto y las sugerencias pedagógicas recomendadas para su subsanación.`,
             { align: 'justify', width: writeWidth }
           );

        // Divider
        doc.moveDown(1.5);
        doc.strokeColor('#e2e8f0')
           .lineWidth(0.5)
           .moveTo(margin, doc.y)
           .lineTo(pageWidth - margin, doc.y)
           .stroke();
        doc.moveDown(1);

        // ── Render Missing Requirements (Critical) ────────────────────────
        if (missingItems.length > 0) {
          doc.fillColor('#dc2626')
             .font('Helvetica-Bold')
             .fontSize(12)
             .text(`NO CONFORMIDADES CRÍTICAS (REQUISITOS FALTANTES: ${missingItems.length})`);
          
          doc.moveDown(0.5);

          for (let idx = 0; idx < missingItems.length; idx++) {
            const item = missingItems[idx];

            // Overflow check
            if (doc.y > pageHeight - 160) {
              doc.addPage();
            }

            const cardY = doc.y;
            // Let's draw a card structure
            doc.rect(margin, cardY, writeWidth, 8)
               .fill('#ef4444'); // Red header strip for critical

            // Compute text sizes to make card height dynamic
            doc.fontSize(8);
            const titleText = `[${item.item.id}] [${item.item.category.toUpperCase()}] ${item.item.requirement}`;
            
            doc.font('Helvetica-Bold')
               .fontSize(9.5)
               .fillColor('#1e293b')
               .text(titleText, margin + 12, cardY + 18, { width: writeWidth - 24 });

            doc.moveDown(0.4);

            // Description
            doc.fillColor('#64748b')
               .font('Helvetica-Bold')
               .fontSize(8)
               .text('Requisito: ', margin + 12, doc.y, { continued: true })
               .font('Helvetica')
               .fillColor('#334155')
               .text(item.item.description || item.item.requirement, { width: writeWidth - 24 });

            doc.moveDown(0.3);

            // Evidence
            doc.fillColor('#dc2626')
               .font('Helvetica-Bold')
               .fontSize(8)
               .text('Evidencia del Incumplimiento: ', margin + 12, doc.y, { continued: true })
               .font('Helvetica')
               .fillColor('#475569')
               .text(item.evidence || 'No se encuentra mención ni cobertura semántica de este requisito en el documento analizado.', { width: writeWidth - 24 });

            doc.moveDown(0.3);

            // Suggestion
            doc.fillColor('#b45309')
               .font('Helvetica-Bold')
               .fontSize(8)
               .text('Acción de Subsanación Sugerida: ', margin + 12, doc.y, { continued: true })
               .font('Helvetica')
               .fillColor('#1e293b')
               .text(item.suggestion || 'Incorporar este aspecto de forma explícita o transversal según corresponda.', { width: writeWidth - 24 });

            const cardH = doc.y - cardY;
            
            // Draw card border
            doc.rect(margin, cardY, writeWidth, cardH + 12)
               .lineWidth(0.5)
               .strokeColor('#fca5a5');

            doc.y = doc.y + 24; // margin between cards
          }
        }

        // ── Render Partial Requirements (Moderate) ────────────────────────
        if (partialItems.length > 0) {
          // Check if we need a new page for the section header
          if (doc.y > pageHeight - 120) {
            doc.addPage();
          }

          doc.fillColor('#d97706')
             .font('Helvetica-Bold')
             .fontSize(12)
             .text(`NO CONFORMIDADES MODERADAS (REQUISITOS PARCIALES: ${partialItems.length})`);
          
          doc.moveDown(0.5);

          for (let idx = 0; idx < partialItems.length; idx++) {
            const item = partialItems[idx];

            // Overflow check
            if (doc.y > pageHeight - 160) {
              doc.addPage();
            }

            const cardY = doc.y;
            // Let's draw a card structure
            doc.rect(margin, cardY, writeWidth, 8)
               .fill('#fbbf24'); // Yellow header strip for moderate/partial

            doc.fontSize(8);
            const titleText = `[${item.item.id}] [${item.item.category.toUpperCase()}] ${item.item.requirement}`;
            
            doc.font('Helvetica-Bold')
               .fontSize(9.5)
               .fillColor('#1e293b')
               .text(titleText, margin + 12, cardY + 18, { width: writeWidth - 24 });

            doc.moveDown(0.4);

            // Description
            doc.fillColor('#64748b')
               .font('Helvetica-Bold')
               .fontSize(8)
               .text('Requisito: ', margin + 12, doc.y, { continued: true })
               .font('Helvetica')
               .fillColor('#334155')
               .text(item.item.description || item.item.requirement, { width: writeWidth - 24 });

            doc.moveDown(0.3);

            // Evidence
            doc.fillColor('#d97706')
               .font('Helvetica-Bold')
               .fontSize(8)
               .text('Evidencia / Cobertura Parcial: ', margin + 12, doc.y, { continued: true })
               .font('Helvetica')
               .fillColor('#475569')
               .text(item.evidence || 'Se menciona de forma incompleta o ambigua.', { width: writeWidth - 24 });

            doc.moveDown(0.3);

            // Suggestion
            doc.fillColor('#b45309')
               .font('Helvetica-Bold')
               .fontSize(8)
               .text('Acción de Subsanación Sugerida: ', margin + 12, doc.y, { continued: true })
               .font('Helvetica')
               .fillColor('#1e293b')
               .text(item.suggestion || 'Completar o redactar con mayor precisión el detalle del aspecto.', { width: writeWidth - 24 });

            const cardH = doc.y - cardY;
            
            // Draw card border
            doc.rect(margin, cardY, writeWidth, cardH + 12)
               .lineWidth(0.5)
               .strokeColor('#fde047');

            doc.y = doc.y + 24; // margin between cards
          }
        }
      }

      // ── Headers and Footers ──────────────────────────────────────────
      const pages = doc.bufferedPageRange();
      for (let j = 0; j < pages.count; j++) {
        doc.switchToPage(j);

        const oldBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;

        // Header (skip first page)
        if (j > 0) {
          doc.fontSize(7.5)
             .fillColor('#94a3b8')
             .font('Helvetica')
             .text(`REPORTE DE NO CONFORMIDADES — ${programTitle.toUpperCase()}`, margin, 32, { align: 'left' });

          doc.strokeColor('#e2e8f0')
             .lineWidth(0.5)
             .moveTo(margin, 44)
             .lineTo(pageWidth - margin, 44)
             .stroke();
        }

        // Footer
        doc.strokeColor('#e2e8f0')
           .lineWidth(0.5)
           .moveTo(margin, pageHeight - 42)
           .lineTo(pageWidth - margin, pageHeight - 42)
           .stroke();

        doc.fontSize(7.5)
           .fillColor('#94a3b8')
           .font('Helvetica')
           .text('Reporte de Auditoría Curricular generado automáticamente.', margin, pageHeight - 32, { align: 'left', continued: true })
           .text(`Pág. ${j + 1} de ${pages.count}`, pageWidth - margin - 80, pageHeight - 32, { width: 80, align: 'right' });

        doc.page.margins.bottom = oldBottom;
      }

      doc.end();
    } catch (error) {
      logger.error('NonCompliancePDF', 'Error generating non-compliance PDF', error as Error);
      reject(error);
    }
  });
}
