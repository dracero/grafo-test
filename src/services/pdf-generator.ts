import PDFDocument from 'pdfkit';
import { createLogger } from './logger';

const logger = createLogger();

export async function generateCorrectedProgramPDF(
  programName: string,
  text: string
): Promise<Buffer> {
  logger.info('PDFGenerator', `Generating high-fidelity PDF for program: ${programName}`);

  return new Promise((resolve, reject) => {
    try {
      const chunks: Buffer[] = [];
      const doc = new PDFDocument({
        size: 'A4',
        margin: 54, // 0.75 in (54 pt)
        bufferPages: true
      });

      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', (err) => reject(err));

      // Page width & height calculations
      const margin = 54;
      const pageWidth = doc.page.width;
      const pageHeight = doc.page.height;
      const writeWidth = pageWidth - margin * 2;

      // Split text into lines
      const lines = text.split('\n');
      let i = 0;

      // Document title (usually the first few lines contain the title, or we can format it dynamically)
      let title = programName.replace(/\.pdf$/i, '').replace(/_/g, ' ');
      doc.fillColor('#1e293b')
         .font('Helvetica-Bold')
         .fontSize(20)
         .text(title.toUpperCase(), { align: 'center' });
      doc.moveDown(1.5);

      while (i < lines.length) {
        const line = lines[i].trim();

        if (!line) {
          i++;
          continue;
        }

        // 1. Detect Markdown Table
        if (line.startsWith('|') && i + 1 < lines.length && lines[i + 1].trim().includes('|-')) {
          const tableRows: string[][] = [];
          
          // Collect all contiguous table rows
          while (i < lines.length && lines[i].trim().startsWith('|')) {
            const rawRow = lines[i].trim();
            // Skip separator line like |---|---|
            if (!rawRow.includes('|-')) {
              const cells = rawRow
                .split('|')
                .map(c => c.trim())
                .filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
              tableRows.push(cells);
            }
            i++;
          }

          if (tableRows.length > 0) {
            renderTable(doc, tableRows, writeWidth);
            doc.moveDown(1);
          }
          continue;
        }

        // 2. Detect Main Section (e.g. "1. DATOS GENERALES" or "I. OBJETIVOS")
        const isMainSection = /^(?:[0-9]+|[A-Z]+)\.\s+[A-ZÁÉÍÓÚÑ\s\(\),]+$/i.test(line);
        if (isMainSection) {
          doc.moveDown(1);
          // Left-side colored bar design
          const currentY = doc.y;
          doc.rect(margin, currentY, 4, 18).fill('#4f46e5');
          
          doc.fillColor('#1e293b')
             .font('Helvetica-Bold')
             .fontSize(13)
             .text(line, margin + 12, currentY + 2);
          
          doc.moveDown(1.2);
          i++;
          continue;
        }

        // 3. Detect Subsection (e.g. "1.1 Cátedra" or "A. Objetivos específicos")
        const isSubsection = /^(?:[0-9]+\.[0-9]+|[A-Z]\.)\s+.+$/i.test(line);
        if (isSubsection) {
          doc.moveDown(0.5);
          doc.fillColor('#334155')
             .font('Helvetica-Bold')
             .fontSize(11)
             .text(line, { width: writeWidth });
          doc.moveDown(0.6);
          i++;
          continue;
        }

        // 4. Detect List Item (e.g. "- Tema 1" or "• Tema 2")
        const isListItem = /^(?:[\-\*•]|\d+[\)\.])\s+(.+)$/.exec(line);
        if (isListItem) {
          const content = isListItem[1];
          doc.fillColor('#475569')
             .font('Helvetica')
             .fontSize(10)
             .text('•', margin + 15, doc.y, { continued: true })
             .text('  ' + content, margin + 25, doc.y, {
               width: writeWidth - 25,
               align: 'justify',
               lineGap: 3
             });
          doc.moveDown(0.4);
          i++;
          continue;
        }

        // 5. Default Paragraph
        doc.fillColor('#475569')
           .font('Helvetica')
           .fontSize(10)
           .text(line, {
             width: writeWidth,
             align: 'justify',
             lineGap: 3
           });
        doc.moveDown(0.6);
        i++;
      }

      // Add Headers and Footers (Dynamic two-pass for total page count)
      const pages = doc.bufferedPageRange();
      for (let j = 0; j < pages.count; j++) {
        doc.switchToPage(j);

        // Header (Skip first page)
        if (j > 0) {
          doc.fontSize(8)
             .fillColor('#94a3b8')
             .font('Helvetica')
             .text(`PROGRAMA DE ESTUDIOS — ${title.toUpperCase()}`, margin, 30, { align: 'left' });
          
          // Header line
          doc.strokeColor('#e2e8f0')
             .lineWidth(0.5)
             .moveTo(margin, 42)
             .lineTo(pageWidth - margin, 42)
             .stroke();
        }

        // Footer line
        doc.strokeColor('#e2e8f0')
           .lineWidth(0.5)
           .moveTo(margin, pageHeight - 45)
           .lineTo(pageWidth - margin, pageHeight - 45)
           .stroke();

        // Footer Text
        doc.fontSize(8)
           .fillColor('#94a3b8')
           .font('Helvetica')
           .text('Documento oficial corregido bajo conformidad normativa.', margin, pageHeight - 36, { align: 'left', continued: true })
           .text(`Página ${j + 1} de ${pages.count}`, pageWidth - margin - 100, pageHeight - 36, {
             width: 100,
             align: 'right'
           });
      }

      doc.end();
    } catch (error) {
      logger.error('PDFGenerator', 'Error in PDF generation', error as Error);
      reject(error);
    }
  });
}

function renderTable(doc: PDFKit.PDFDocument, rows: string[][], writeWidth: number) {
  const colCount = rows[0].length;
  const colWidth = writeWidth / colCount;

  const startX = doc.x;
  let currentY = doc.y;

  // Render header
  const headers = rows[0];
  let maxHeaderHeight = 0;

  // Calculate cell height
  headers.forEach((text) => {
    const height = doc.heightOfString(text, { width: colWidth - 10 });
    if (height > maxHeaderHeight) maxHeaderHeight = height;
  });
  maxHeaderHeight += 12; // cell padding

  // Draw header backgrounds
  doc.rect(startX, currentY, writeWidth, maxHeaderHeight).fill('#f1f5f9');

  // Draw header texts
  headers.forEach((text, idx) => {
    doc.fillColor('#1e293b')
       .font('Helvetica-Bold')
       .fontSize(9)
       .text(text, startX + idx * colWidth + 5, currentY + 6, {
         width: colWidth - 10,
         align: 'left'
       });
  });

  // Draw borders
  doc.strokeColor('#cbd5e1')
     .lineWidth(0.5)
     .rect(startX, currentY, writeWidth, maxHeaderHeight)
     .stroke();

  for (let c = 1; c < colCount; c++) {
    doc.moveTo(startX + c * colWidth, currentY)
       .lineTo(startX + c * colWidth, currentY + maxHeaderHeight)
       .stroke();
  }

  currentY += maxHeaderHeight;

  // Render data rows
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    let maxRowHeight = 0;

    row.forEach((text) => {
      const height = doc.heightOfString(text, { width: colWidth - 10 });
      if (height > maxRowHeight) maxRowHeight = height;
    });
    maxRowHeight += 10; // cell padding

    // Page overflow safety
    if (currentY + maxRowHeight > doc.page.height - 70) {
      doc.addPage();
      currentY = doc.y;
      
      // Draw grid top border for the new page
      doc.strokeColor('#cbd5e1')
         .lineWidth(0.5)
         .moveTo(startX, currentY)
         .lineTo(startX + writeWidth, currentY)
         .stroke();
    }

    row.forEach((text, idx) => {
      doc.fillColor('#334155')
         .font('Helvetica')
         .fontSize(8.5)
         .text(text, startX + idx * colWidth + 5, currentY + 5, {
           width: colWidth - 10,
           align: 'left'
         });
    });

    // Draw borders
    doc.strokeColor('#cbd5e1')
       .lineWidth(0.5)
       .rect(startX, currentY, writeWidth, maxRowHeight)
       .stroke();

    for (let c = 1; c < colCount; c++) {
      doc.moveTo(startX + c * colWidth, currentY)
         .lineTo(startX + c * colWidth, currentY + maxRowHeight)
         .stroke();
    }

    currentY += maxRowHeight;
  }

  doc.y = currentY + 5;
}
