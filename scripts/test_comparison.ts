import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { getServices } from '../src/lib/services';
import pdfParse from 'pdf-parse';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const { comparisonService } = await getServices();

  const normPath = './.pdf-cache/rubrica_multiagente_Anuncio_GL.pdf';
  const progPath = './.pdf-cache/2025_200230_gl.pdf';

  if (!fs.existsSync(normPath) || !fs.existsSync(progPath)) {
    console.error(`PDF files do not exist at expected paths. normPath exists: ${fs.existsSync(normPath)}, progPath exists: ${fs.existsSync(progPath)}`);
    return;
  }

  const normBuffer = fs.readFileSync(normPath);
  const progBuffer = fs.readFileSync(progPath);

  const normPdf = await pdfParse(normBuffer);
  const progPdf = await pdfParse(progBuffer);

  console.log('Running comparisonService.fullComparison...');
  const report = await comparisonService.fullComparison(
    normPdf.text,
    progPdf.text,
    'rubrica_multiagente_Anuncio_GL.pdf',
    '2025_200230_gl.pdf',
    'gemini'
  );

  console.log('\n--- Comparison results count ---');
  console.log(`Total items: ${report.results.length}`);
  const statusCounts: Record<string, number> = {};
  for (const r of report.results) {
    statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  }
  console.log('Status counts:', statusCounts);

  console.log('\nSample results with partial/missing:');
  const nonCovered = report.results.filter(r => r.status !== 'covered');
  console.log(nonCovered.slice(0, 5).map(r => ({
    id: r.item.id,
    requirement: r.item.requirement,
    status: r.status
  })));
}

main().catch(console.error);
