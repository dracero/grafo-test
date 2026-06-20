/**
 * Rubric PDF Generator
 *
 * Generates a professional PDF rubric with:
 *   - 3 compliance levels: Cumple Totalmente (2pts) / Parcialmente (1pt) / No Cumple (0pts)
 *   - Dimensions grouping with numbered components
 *   - Landscape A4 layout for readability
 *   - Level-labeled descriptors (ÓPTIMO, ACEPTABLE CON OBSERVACIÓN, DEFICIENTE/CRÍTICO)
 */

import PDFDocumentKit from 'pdfkit';
import { createLogger } from './logger';
import { t } from '../lib/i18n';

const logger = createLogger();

export interface RubricCriterion {
  id: string;
  dimension: string;
  criterion: string;
  description: string;
  levels: {
    full: string;
    partial: string;
    none: string;
  };
}

export interface RubricData {
  title: string;
  subtitle: string;
  normativeDocument: string;
  criteria: RubricCriterion[];
  totalWeight: number;
  generatedAt: string;
}

/**
 * Generates a complete rubric PDF from the rubric data in CONEAU format.
 */
export async function generateRubricPDF(rubric: RubricData, lang: string = 'es'): Promise<Buffer> {
  logger.info('RubricPDF', `Generating rubric PDF in language '${lang}': ${rubric.criteria.length} criteria`);

  return new Promise((resolve, reject) => {
    try {
      const chunks: Buffer[] = [];
      const doc = new PDFDocumentKit({
        size: 'A4',
        layout: 'landscape',
        margin: 36,
        bufferPages: true,
      });

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      const margin = 36;
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const writeWidth = pageWidth - margin * 2;

      // ── Cover Page ─────────────────────────────────────────────────────
      doc.rect(0, 0, pageWidth, 10).fill('#1e3a5f');

      doc.moveDown(4);

      // Title
      doc.fillColor('#1e293b')
         .font('Helvetica-Bold')
         .fontSize(20)
         .text(rubric.title, { align: 'center' });

      doc.moveDown(0.6);

      // Subtitle
      doc.fillColor('#475569')
         .font('Helvetica-Bold')
         .fontSize(11)
         .text(rubric.subtitle.toUpperCase(), { align: 'center' });

      doc.moveDown(2.5);

      // Info box
      const boxY = doc.y;
      doc.rect(margin + 80, boxY, writeWidth - 160, 80)
         .lineWidth(1)
         .strokeColor('#cbd5e1')
         .fillAndStroke('#f8fafc', '#cbd5e1');

      const infoX = margin + 100;
      doc.fillColor('#334155')
         .font('Helvetica-Bold')
         .fontSize(9)
         .text(t('rubric.pdf.normative_document', lang), infoX, boxY + 14, { continued: true })
         .font('Helvetica')
         .text(`  ${rubric.normativeDocument}`);

      const numComp = rubric.criteria.length;
      const numDims = new Set(rubric.criteria.map(c => c.dimension)).size;
      const compWord = numComp > 1 ? t('rubric.js.components', lang) : t('rubric.js.component', lang);
      const dimWord = numDims > 1 ? (lang === 'en' ? 'dimensions' : lang === 'gl' ? 'dimensións' : lang === 'pt' ? 'dimensões' : 'dimensiones') : (lang === 'en' ? 'dimension' : lang === 'gl' ? 'dimensión' : lang === 'pt' ? 'dimensão' : 'dimensión');
      const inWord = t('rubric.pdf.in', lang);

      doc.fillColor('#334155')
         .font('Helvetica-Bold')
         .fontSize(9)
         .text(t('rubric.pdf.evaluated_components', lang), infoX, boxY + 32, { continued: true })
         .font('Helvetica')
         .text(`  ${numComp} ${compWord} ${inWord} ${numDims} ${dimWord}`);

      const pointsWord = t('rubric.pdf.points', lang);
      doc.fillColor('#334155')
         .font('Helvetica-Bold')
         .fontSize(9)
         .text(t('rubric.pdf.max_score', lang), infoX, boxY + 50, { continued: true })
         .font('Helvetica')
         .text(`  ${rubric.totalWeight} ${pointsWord} (${rubric.criteria.length} × 2 pts)`);

      doc.y = boxY + 100;

      doc.moveDown(1);

      // Scale explanation
      doc.fillColor('#64748b')
         .font('Helvetica')
         .fontSize(8)
         .text(
           t('rubric.pdf.evaluation_scale', lang),
           { align: 'center', width: writeWidth }
         );

      doc.moveDown(0.5);
      const dateLocale = lang === 'en' ? 'en-US' : lang === 'pt' ? 'pt-BR' : lang === 'gl' ? 'gl-ES' : 'es-AR';
      doc.fillColor('#64748b')
         .font('Helvetica')
         .fontSize(8)
         .text(
           `${t('rubric.pdf.generation_date', lang)} ${new Date(rubric.generatedAt).toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric' })}`,
           { align: 'center', width: writeWidth }
         );


      // ── Group criteria by dimension ────────────────────────────────────
      const dimensions = new Map<string, RubricCriterion[]>();
      for (const c of rubric.criteria) {
        const dim = c.dimension || 'General';
        if (!dimensions.has(dim)) dimensions.set(dim, []);
        dimensions.get(dim)!.push(c);
      }

      // Column widths
      const colComponent = 105;
      const colCriteria = 130;
      const colLevel = (writeWidth - colComponent - colCriteria) / 3;

      let dimIndex = 0;
      for (const [dimName, dimCriteria] of dimensions) {
        dimIndex++;

        // New page for each dimension (except if already at top)
        doc.addPage();

        // Dimension header
        const dimY = doc.y || margin + 10;
        doc.rect(margin, dimY, writeWidth, 28)
           .fill('#1e3a5f');

        doc.fillColor('#ffffff')
           .font('Helvetica-Bold')
           .fontSize(10)
           .text(`${t('rubric.js.dimension', lang, 'DIMENSIÓN')} ${dimIndex}: ${dimName.toUpperCase()}`, margin + 12, dimY + 9, { width: writeWidth - 24 });

        doc.y = dimY + 32;

        // Table header row
        const headerY = doc.y;
        const headerH = 34;

        // Component column
        doc.rect(margin, headerY, colComponent, headerH)
           .lineWidth(0.5)
           .fillAndStroke('#334155', '#94a3b8');
        doc.fillColor('#ffffff')
           .font('Helvetica-Bold')
           .fontSize(7)
           .text(t('rubric.js.table.evaluated_component', lang).replace(' ', '\n'), margin + 5, headerY + 7, { width: colComponent - 10, align: 'center' });

        // Criteria column
        let xPos = margin + colComponent;
        doc.rect(xPos, headerY, colCriteria, headerH)
           .lineWidth(0.5)
           .fillAndStroke('#475569', '#94a3b8');
        doc.fillColor('#ffffff')
           .font('Helvetica-Bold')
           .fontSize(7)
           .text(t('rubric.js.table.institutional_criterion', lang).replace(' ', '\n'), xPos + 5, headerY + 7, { width: colCriteria - 10, align: 'center' });

        // Level headers
        xPos += colCriteria;

        // Cumple Totalmente
        doc.rect(xPos, headerY, colLevel, headerH)
           .lineWidth(0.5)
           .fillAndStroke('#16a34a', '#94a3b8');
        doc.fillColor('#ffffff')
           .font('Helvetica-Bold')
           .fontSize(6.5)
           .text(t('rubric.js.table.level_excellent', lang).replace(' ', '\n'), xPos + 4, headerY + 7, { width: colLevel - 8, align: 'center' });

        xPos += colLevel;

        // Cumple Parcialmente
        doc.rect(xPos, headerY, colLevel, headerH)
           .lineWidth(0.5)
           .fillAndStroke('#d97706', '#94a3b8');
        doc.fillColor('#ffffff')
           .font('Helvetica-Bold')
           .fontSize(6.5)
           .text(t('rubric.js.table.level_acceptable', lang).replace(' ', '\n'), xPos + 4, headerY + 7, { width: colLevel - 8, align: 'center' });

        xPos += colLevel;

        // No Cumple
        doc.rect(xPos, headerY, colLevel, headerH)
           .lineWidth(0.5)
           .fillAndStroke('#dc2626', '#94a3b8');
        doc.fillColor('#ffffff')
           .font('Helvetica-Bold')
           .fontSize(6.5)
           .text(t('rubric.js.table.level_insufficient', lang).replace(' ', '\n'), xPos + 4, headerY + 7, { width: colLevel - 8, align: 'center' });

        doc.y = headerY + headerH;


        // Criteria rows
        for (let cIdx = 0; cIdx < dimCriteria.length; cIdx++) {
          const c = dimCriteria[cIdx];

          // Calculate row height
          const cellPad = 10;
          const componentText = `${c.id} ${c.criterion}`;
          doc.fontSize(7);
          const hComponent = doc.heightOfString(componentText, { width: colComponent - cellPad }) + 8;
          doc.fontSize(6.5);
          const hDesc = doc.heightOfString(c.description, { width: colCriteria - cellPad }) + 8;
          const hFull = doc.heightOfString(c.levels.full, { width: colLevel - cellPad }) + 18;
          const hPartial = doc.heightOfString(c.levels.partial, { width: colLevel - cellPad }) + 18;
          const hNone = doc.heightOfString(c.levels.none, { width: colLevel - cellPad }) + 18;
          const heights = [hComponent, hDesc, hFull, hPartial, hNone];
          const rowH = Math.max(...heights, 60);

          // Page overflow check
          if (doc.y + rowH > pageHeight - 50) {
            doc.addPage();
            doc.y = margin + 10;

            // Repeat dimension + table header on new page
            const rDimY = doc.y;
            doc.rect(margin, rDimY, writeWidth, 22)
               .fill('#1e3a5f');
            doc.fillColor('#ffffff')
               .font('Helvetica-Bold')
               .fontSize(9)
               .text(`${t('rubric.js.dimension', lang, 'DIMENSIÓN')} ${dimIndex}: ${dimName.toUpperCase()} (${lang === 'en' ? 'cont.' : 'cont.'})`, margin + 12, rDimY + 6, { width: writeWidth - 24 });
            doc.y = rDimY + 24;

            // Mini header
            const rHeaderY = doc.y;
            const rHeaderH = 20;
            doc.rect(margin, rHeaderY, colComponent, rHeaderH).lineWidth(0.5).fillAndStroke('#334155', '#94a3b8');
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6).text(t('rubric.js.component', lang, 'Componente'), margin + 5, rHeaderY + 6, { width: colComponent - 10, align: 'center' });

            let rx = margin + colComponent;
            doc.rect(rx, rHeaderY, colCriteria, rHeaderH).lineWidth(0.5).fillAndStroke('#475569', '#94a3b8');
            const critWord = lang === 'en' ? 'Criterion' : lang === 'gl' ? 'Criterio' : 'Criterio';
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6).text(critWord, rx + 5, rHeaderY + 6, { width: colCriteria - 10, align: 'center' });
            rx += colCriteria;

            const labelFullMini = lang === 'en' ? 'Full (2)' : lang === 'gl' ? 'Cumpre Tot. (2)' : lang === 'pt' ? 'Cumpre Tot. (2)' : 'Cumple Tot. (2)';
            doc.rect(rx, rHeaderY, colLevel, rHeaderH).lineWidth(0.5).fillAndStroke('#16a34a', '#94a3b8');
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6).text(labelFullMini, rx + 3, rHeaderY + 6, { width: colLevel - 6, align: 'center' });
            rx += colLevel;

            const labelPartMini = lang === 'en' ? 'Partial (1)' : lang === 'gl' ? 'Cumpre Parc. (1)' : lang === 'pt' ? 'Cumpre Parc. (1)' : 'Cumple Parc. (1)';
            doc.rect(rx, rHeaderY, colLevel, rHeaderH).lineWidth(0.5).fillAndStroke('#d97706', '#94a3b8');
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6).text(labelPartMini, rx + 3, rHeaderY + 6, { width: colLevel - 6, align: 'center' });
            rx += colLevel;

            const labelNoneMini = lang === 'en' ? 'None (0)' : lang === 'gl' ? 'Non Cumpre (0)' : lang === 'pt' ? 'Não Cumpre (0)' : 'No Cumple (0)';
            doc.rect(rx, rHeaderY, colLevel, rHeaderH).lineWidth(0.5).fillAndStroke('#dc2626', '#94a3b8');
            doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(6).text(labelNoneMini, rx + 3, rHeaderY + 6, { width: colLevel - 6, align: 'center' });

            doc.y = rHeaderY + rHeaderH;
          }

          const rowY = doc.y;
          const rowBg = cIdx % 2 === 0 ? '#f8fafc' : '#ffffff';

          // Component cell
          doc.rect(margin, rowY, colComponent, rowH).lineWidth(0.5).fillAndStroke(rowBg, '#e2e8f0');
          doc.fillColor('#1e40af')
             .font('Helvetica-Bold')
             .fontSize(7)
             .text(c.id, margin + 5, rowY + 5, { width: colComponent - 10 });

          const idH = doc.heightOfString(c.id, { width: colComponent - 10 });
          doc.fillColor('#1e293b')
             .font('Helvetica-Bold')
             .fontSize(7)
             .text(c.criterion, margin + 5, rowY + 5 + idH + 2, { width: colComponent - 10 });

          // Criteria cell
          xPos = margin + colComponent;
          doc.rect(xPos, rowY, colCriteria, rowH).lineWidth(0.5).fillAndStroke(rowBg, '#e2e8f0');
          doc.fillColor('#475569')
             .font('Helvetica')
             .fontSize(6.5)
             .text(c.description, xPos + 5, rowY + 5, { width: colCriteria - 10, lineGap: 1 });

          // Cumple Totalmente cell
          xPos += colCriteria;
          doc.rect(xPos, rowY, colLevel, rowH).lineWidth(0.5).fillAndStroke('#f0fdf4', '#e2e8f0');
          doc.fillColor('#166534')
             .font('Helvetica-Bold')
             .fontSize(6)
             .text(t('rubric.js.table.label_optimo', lang), xPos + 5, rowY + 4, { width: colLevel - 10 });
          doc.fillColor('#166534')
             .font('Helvetica')
             .fontSize(6.5)
             .text(c.levels.full, xPos + 5, rowY + 14, { width: colLevel - 10, lineGap: 1 });

          // Cumple Parcialmente cell
          xPos += colLevel;
          doc.rect(xPos, rowY, colLevel, rowH).lineWidth(0.5).fillAndStroke('#fffbeb', '#e2e8f0');
          doc.fillColor('#92400e')
             .font('Helvetica-Bold')
             .fontSize(6)
             .text(t('rubric.js.table.label_acceptable', lang), xPos + 5, rowY + 4, { width: colLevel - 10 });
          doc.fillColor('#92400e')
             .font('Helvetica')
             .fontSize(6.5)
             .text(c.levels.partial, xPos + 5, rowY + 14, { width: colLevel - 10, lineGap: 1 });

          // No Cumple cell
          xPos += colLevel;
          doc.rect(xPos, rowY, colLevel, rowH).lineWidth(0.5).fillAndStroke('#fef2f2', '#e2e8f0');
          doc.fillColor('#991b1b')
             .font('Helvetica-Bold')
             .fontSize(6)
             .text(t('rubric.js.table.label_deficiente', lang), xPos + 5, rowY + 4, { width: colLevel - 10 });
          doc.fillColor('#991b1b')
             .font('Helvetica')
             .fontSize(6.5)
             .text(c.levels.none, xPos + 5, rowY + 14, { width: colLevel - 10, lineGap: 1 });

          doc.y = rowY + rowH;
        }
      }

      // ── Headers and Footers ────────────────────────────────────────────
      const pages = doc.bufferedPageRange();
      const docName = rubric.normativeDocument.replace(/\.pdf$/i, '').toUpperCase();
      for (let j = 0; j < pages.count; j++) {
        doc.switchToPage(j);

        const oldBottom = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;

        // Header (skip cover)
        if (j > 0) {
          doc.fontSize(7)
             .fillColor('#94a3b8')
             .font('Helvetica')
             .text(`${rubric.title.toUpperCase()} — ${docName}`, margin, 18, { align: 'left', width: writeWidth * 0.7 });

          doc.strokeColor('#e2e8f0')
             .lineWidth(0.5)
             .moveTo(margin, 28)
             .lineTo(pageWidth - margin, 28)
             .stroke();
        }

        // Footer
        doc.strokeColor('#e2e8f0')
           .lineWidth(0.5)
           .moveTo(margin, pageHeight - 32)
           .lineTo(pageWidth - margin, pageHeight - 32)
           .stroke();

        doc.fontSize(7)
           .fillColor('#94a3b8')
           .font('Helvetica')
           .text(`${docName} — ${t('rubric.pdf.footer_title', lang)}`, margin, pageHeight - 24, { align: 'left', continued: true })
           .text(`${t('rubric.pdf.page', lang)} ${j + 1} ${t('rubric.pdf.page_of', lang)} ${pages.count}`, pageWidth - margin - 80, pageHeight - 24, { width: 80, align: 'right' });

        doc.page.margins.bottom = oldBottom;
      }

      doc.end();
    } catch (error) {
      logger.error('RubricPDF', 'Error generating rubric PDF', error as Error);
      reject(error);
    }
  });
}
