import { getServices } from '../src/lib/services';
import { runCorrectionPipeline } from '../src/services/multi-agent-service';
import { generateCorrectedProgramPDF, parseCorrections } from '../src/services/pdf-generator';
import { generateNonCompliancePDF } from '../src/services/non-compliance-pdf-generator';
import * as fs from 'fs';
import * as path from 'path';
const pdfParse = require('pdf-parse');

function normalizeStatus(status: string): 'covered' | 'partial' | 'missing' {
  const s = (status || '').toLowerCase().trim();
  if (s === 'covered' || s === 'cubierto' || s === 'cumple' || s === 'cuberto') return 'covered';
  if (s === 'partial' || s === 'parcial' || s === 'parciais') return 'partial';
  return 'missing';
}

async function main() {
  const userEmail = 'dracero@fi.uba.ar';
  const programName = '2025_200237_gl.pdf';
  const normativeName = 'rubrica_multiagente_Anuncio GL.pdf';
  const lang = 'gl';
  const provider = 'gemini';

  const services = await getServices();
  const { comparisonService, graphBuilder } = services;

  const normPath = path.join(process.cwd(), '.pdf-cache', 'rubrica_multiagente_Anuncio_GL.pdf');
  const progPath = path.join(process.cwd(), '.pdf-cache', programName);

  if (!fs.existsSync(normPath) || !fs.existsSync(progPath)) {
    console.error(`Missing files in .pdf-cache: normPath=${normPath}, progPath=${progPath}`);
    return;
  }

  const normBuffer = fs.readFileSync(normPath);
  const progBuffer = fs.readFileSync(progPath);

  console.log(`Extracting text from original PDFs...`);
  const normPdf = await pdfParse(normBuffer);
  const progPdf = await pdfParse(progBuffer);

  console.log(`Running Initial Comparison...`);
  const report = await comparisonService.fullComparison(
    normPdf.text,
    progPdf.text,
    normativeName,
    programName,
    provider,
    (content) => console.log(`[Comparison] ${content}`)
  );

  console.log(`Saving initial report to Neo4j...`);
  await graphBuilder.saveComparisonReport(report, userEmail);

  console.log(`Running Multi-Agent pipeline...`);
  const pipeline = runCorrectionPipeline(normativeName, programName, graphBuilder, provider, lang, userEmail);
  let correctedText = '';
  let validatedComplianceText = '';

  for await (const update of pipeline) {
    console.log(`  [Progress] ${update.step}: ${update.isFinal ? 'DONE' : 'RUNNING...'}`);
    if (update.step === 'ProgramFixerAgent' && update.isFinal) {
      correctedText = update.content;
    }
    if (update.step === 'ComplianceValidatorAgent' && update.isFinal) {
      validatedComplianceText = update.content;
    }
  }

  if (!correctedText) {
    throw new Error('Fixer agent did not output any corrected text.');
  }

  console.log(`Parsing corrections...`);
  const corrections = parseCorrections(correctedText);

  let validatedGaps: any[] = [];
  let excludedGaps: any[] = [];
  if (validatedComplianceText) {
    try {
      const cleanedText = validatedComplianceText.replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
      const parsed = JSON.parse(cleanedText);
      validatedGaps = parsed.validatedGaps || [];
      excludedGaps = parsed.excludedGaps || [];
      console.log(`Parsed validated gaps: ${validatedGaps.length}, excluded: ${excludedGaps.length}`);
    } catch (err) {
      console.error('Could not parse validated compliance analysis output', err);
    }
  }

  const validatedGapsMap = new Map(validatedGaps.map((g: any) => [g.id, g]));
  const excludedGapsMap = new Map(excludedGaps.map((g: any) => [g.id, g]));

  for (const result of report.results) {
    const reqId = result.item.id;
    if (excludedGapsMap.has(reqId)) {
      const excl = excludedGapsMap.get(reqId);
      result.status = 'covered';
      result.evidence = excl.reason || result.evidence;
      result.suggestion = 'Ninguna';
    } else if (validatedGapsMap.has(reqId)) {
      const val = validatedGapsMap.get(reqId);
      result.status = normalizeStatus(val.status);
      result.evidence = val.evidence || result.evidence;
      result.suggestion = val.suggestion || result.suggestion;
    }
  }

  const covered = report.results.filter((r) => r.status === 'covered').length;
  const partial = report.results.filter((r) => r.status === 'partial').length;
  const missing = report.results.filter((r) => r.status === 'missing').length;
  const total   = report.results.length;
  const coveragePercent = total > 0 ? Math.round(((covered + partial * 0.5) / total) * 100) : 0;

  report.summary = { total, covered, partial, missing, coveragePercent };

  console.log(`Updating comparison report with final results...`);
  await graphBuilder.saveComparisonReport(report, userEmail);

  console.log(`Aligning corrections and saving to Neo4j...`);
  const nonCompliances = report.results.filter(r => r.status === 'partial' || r.status === 'missing');
  const alignedCorrections = nonCompliances.map(r => {
    const match = corrections.find(c => c.gapId && c.gapId.toLowerCase() === r.item.id.toLowerCase());
    return {
      gapId: r.item.id,
      section: match?.section || r.item.category || 'General',
      action: match?.action || (r.status === 'missing' ? 'agregar' : 'enriquecer'),
      evidence: r.evidence || '',
      suggestion: r.suggestion || '',
      justification: match?.justification || 'Adecuación requerida para cumplir coa normativa de referencia.',
      correctedText: match?.correctedText || 'Incorporar este aspecto de forma explícita na sección correspondente del programa.',
      priority: match?.priority || (r.status === 'missing' ? 'alta' : 'media')
    };
  });

  await graphBuilder.saveCorrections(programName, alignedCorrections, correctedText, userEmail);

  console.log(`Generating Non-Conformities PDF...`);
  const nonCompliancePdfBuffer = await generateNonCompliancePDF(report);
  const nonCompliancePath = path.join(process.cwd(), 'pdfs', 'rubrica_multiagente_Anuncio_GL_no_conformidades.pdf');
  fs.writeFileSync(nonCompliancePath, nonCompliancePdfBuffer);
  console.log(`Non-Conformities PDF written to: ${nonCompliancePath}`);

  console.log(`Generating Corrected Program PDF (with Annex)...`);
  const correctedPdfBuffer = await generateCorrectedProgramPDF(
    programName,
    progBuffer,
    alignedCorrections,
    correctedText,
    lang,
    report.results
  );
  const correctedPath = path.join(process.cwd(), 'pdfs', '2025_200237_gl_corregido.pdf');
  fs.writeFileSync(correctedPath, correctedPdfBuffer);
  console.log(`Corrected Program PDF written to: ${correctedPath}`);

  console.log('Done!');
  await graphBuilder.disconnect();
}

main().catch(console.error);
