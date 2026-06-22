import PDFDocumentKit from 'pdfkit';
import pdfParse from 'pdf-parse';

async function generatePDF(programName: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
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

    const title = programName.replace(/\.pdf$/i, '').replace(/_/g, ' ');

    doc.rect(0, 0, pageWidth, 8).fill('#1e40af');
    doc.moveDown(4);

    doc.fillColor('#1e293b')
       .font('Helvetica-Bold')
       .fontSize(22)
       .text('ANEXO DE ADECUACIÓN CURRICULAR', { align: 'center' });

    doc.moveDown(0.8);

    doc.fillColor('#475569')
       .font('Helvetica')
       .fontSize(12)
       .text('PROPUESTA DE MEJORA Y CUMPLIMIENTO NORMATIVO', { align: 'center' });

    doc.moveDown(2);

    const boxY = doc.y;
    const BOX_LINE_H = 18;
    const BOX_PAD_V = 12;
    const infoBoxHeight = BOX_LINE_H * 3 + BOX_PAD_V * 2;

    doc.rect(margin, boxY, writeWidth, infoBoxHeight)
       .lineWidth(1)
       .strokeColor('#cbd5e1')
       .fillAndStroke('#f8fafc', '#cbd5e1');

    doc.fillColor('#334155')
       .font('Helvetica-Bold')
       .fontSize(10)
       .text('Programa:', margin + 15, boxY + BOX_PAD_V, { continued: true })
       .font('Helvetica')
       .text(`  ${title}`);

    doc.fillColor('#334155')
       .font('Helvetica-Bold')
       .fontSize(10)
       .text('Fecha:', margin + 15, boxY + BOX_PAD_V + BOX_LINE_H, { continued: true })
       .font('Helvetica')
       .text('  22 de junio de 2026');

    doc.fillColor('#334155')
       .font('Helvetica-Bold')
       .fontSize(10)
       .text('Modificaciones:', margin + 15, boxY + BOX_PAD_V + BOX_LINE_H * 2, { continued: true })
       .font('Helvetica')
       .text('  0 modificaciones propuestas');

    doc.y = boxY + infoBoxHeight + 10;
    doc.moveDown(0.8);

    doc.fillColor('#64748b')
       .font('Helvetica')
       .fontSize(9)
       .text('Nota explicativa...', { align: 'justify', width: writeWidth });

    // Header/Footer loop
    const pages = doc.bufferedPageRange();
    for (let j = 0; j < pages.count; j++) {
      doc.switchToPage(j);

      // Footer
      doc.strokeColor('#e2e8f0')
         .lineWidth(0.5)
         .moveTo(margin, pageHeight - 45)
         .lineTo(pageWidth - margin, pageHeight - 45)
         .stroke();

      doc.fontSize(8)
         .fillColor('#94a3b8')
         .font('Helvetica')
         .text(`Página: ${j + 1} de ${pages.count}`, margin, pageHeight - 36, { align: 'left' });
    }

    doc.end();
  });
}

import * as fs from 'fs';

async function run() {
  const shortName = '2025_200230_gl.pdf';
  const longName = 'RESCS_2023_1600_PETROLEO_Plan_de_Estudios_Texto_ordenado_681ce83c8e.pdf';

  try {
    console.log('Testing short name...');
    const bufShort = await generatePDF(shortName);
    fs.writeFileSync('scratch/test-short.pdf', bufShort);
    console.log('Saved scratch/test-short.pdf, size:', bufShort.length);
    await pdfParse(bufShort);
    console.log('Short name OK!');

    console.log('Testing long name...');
    const bufLong = await generatePDF(longName);
    fs.writeFileSync('scratch/test-long.pdf', bufLong);
    console.log('Saved scratch/test-long.pdf, size:', bufLong.length);
    await pdfParse(bufLong);
    console.log('Long name OK!');
  } catch (err: any) {
    console.error('Failed with error:', err.message, err.stack);
  }
}

run();
