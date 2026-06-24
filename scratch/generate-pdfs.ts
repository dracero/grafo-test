import { KnowledgeGraphBuilderImpl } from '../src/services/knowledge-graph-builder';
import { ConfigurationManager } from '../src/config';
import { generateNonCompliancePDF } from '../src/services/non-compliance-pdf-generator';
import { generateCorrectedProgramPDF } from '../src/services/pdf-generator';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const configManager = new ConfigurationManager();
  configManager.load();
  const config = configManager.getConfig();

  const graphBuilder = new KnowledgeGraphBuilderImpl();
  await graphBuilder.connect(config.neo4j);

  const driver = (graphBuilder as any).driver;
  const session = driver.session();

  // Find user email associated with 2025_200230_gl.pdf
  const userResult = await session.run(`
    MATCH (u:User)-[:OWNED_BY]->(p:ProgramDocument)
    WHERE p.name = '2025_200230_gl.pdf' OR p.name CONTAINS '2025_200230'
    RETURN u.email AS email, p.name AS programName LIMIT 1
  `);
  
  let userEmail = 'dracero@fi.uba.ar';
  let targetProgramName = '2025_200230_gl.pdf';
  
  if (userResult.records.length > 0) {
    userEmail = userResult.records[0].get('email');
    targetProgramName = userResult.records[0].get('programName');
    console.log(`Found target program: "${targetProgramName}" under user: "${userEmail}"`);
  } else {
    console.log('No specific document containing "2025_200230" found. Listing all program docs to help diagnose:');
    const allDocsResult = await session.run('MATCH (p:ProgramDocument) RETURN p.name AS name');
    allDocsResult.records.forEach(r => console.log(`- ${r.get('name')}`));
    await session.close();
    await graphBuilder.disconnect();
    return;
  }

  // Fetch target comparison report
  const query = `
    MATCH (u:User {email: $userEmail})-[:OWNED_BY]->(p:ProgramDocument {name: $programName})-[:COMPARED_TO]->(n:NormativeDocument)
    WHERE (u)-[:OWNED_BY]->(n)
    OPTIONAL MATCH (p)-[r:EVALUATED_AGAINST]->(o:OntologyItem)
    RETURN
      p.name AS programName,
      p.total AS total,
      p.covered AS covered,
      p.partial AS partial,
      p.missing AS missing,
      p.coveragePercent AS coveragePercent,
      p.correctionsJson AS correctionsJson,
      p.correctedText AS correctedText,
      n.name AS normativeName,
      o.id AS itemId,
      o.requirement AS requirement,
      o.category AS category,
      o.description AS description,
      o.keywords AS keywords,
      r.status AS status,
      r.confidence AS confidence,
      r.evidence AS evidence,
      r.suggestion AS suggestion
    ORDER BY o.id
  `;

  const reportResult = await session.run(query, { userEmail, programName: targetProgramName });
  await session.close();

  if (reportResult.records.length === 0) {
    console.error('No comparison report records found for target program!');
    await graphBuilder.disconnect();
    return;
  }

  // Construct report object
  const record0 = reportResult.records[0];
  const normativeDocument = record0.get('normativeName');
  const programDocument = record0.get('programName');
  const correctionsJson = record0.get('correctionsJson') || null;
  const correctedText = record0.get('correctedText') || null;

  const summary = {
    total: Number(record0.get('total')) || 0,
    covered: Number(record0.get('covered')) || 0,
    partial: Number(record0.get('partial')) || 0,
    missing: Number(record0.get('missing')) || 0,
    coveragePercent: Number(record0.get('coveragePercent')) || 0
  };

  const ontologyMap = new Map<string, any>();
  const results: any[] = [];

  for (const record of reportResult.records) {
    const id = record.get('itemId');

    if (id) {
      if (!ontologyMap.has(id)) {
        ontologyMap.set(id, {
          id,
          category: record.get('category'),
          requirement: record.get('requirement'),
          description: record.get('description'),
          keywords: record.get('keywords') || []
        });
      }

      results.push({
        item: ontologyMap.get(id),
        status: record.get('status'),
        confidence: record.get('confidence'),
        evidence: record.get('evidence'),
        suggestion: record.get('suggestion')
      });
    }
  }

  const report = {
    normativeDocument,
    programDocument,
    ontology: Array.from(ontologyMap.values()),
    results,
    summary,
    timestamp: new Date().toISOString(),
    correctionsJson,
    correctedText
  };

  console.log(`Comparison report details:`);
  console.log(`- Normative: ${report.normativeDocument}`);
  console.log(`- Program: ${report.programDocument}`);
  console.log(`- Results count: ${report.results.length}`);
  console.log(`- Summary: Total ${report.summary.total}, Covered ${report.summary.covered}, Partial ${report.summary.partial}, Missing ${report.summary.missing}`);

  const nonCompliances = report.results.filter(r => r.status === 'partial' || r.status === 'missing');
  console.log(`Non-conformities (partial + missing): ${nonCompliances.length}`);

  // Generate Non-Conformities PDF
  console.log('Generating Non-Conformities PDF...');
  const nonCompliancePdfBuffer = await generateNonCompliancePDF(report);
  if (!fs.existsSync(path.join(process.cwd(), 'pdfs'))) {
    fs.mkdirSync(path.join(process.cwd(), 'pdfs'), { recursive: true });
  }
  const nonCompliancePath = path.join(process.cwd(), 'pdfs', 'rubrica_multiagente_Anuncio_GL_no_conformidades.pdf');
  fs.writeFileSync(nonCompliancePath, nonCompliancePdfBuffer);
  console.log(`Non-Conformities PDF written to: ${nonCompliancePath}`);

  // Generate Corrected Program PDF with Annex of corrections
  console.log('Generating Corrected Program PDF (with Annex)...');
  // Load original program PDF from cache or folder
  const cachePath = path.join(process.cwd(), '.pdf-cache', targetProgramName);
  let originalBuffer: Buffer | null = null;
  if (fs.existsSync(cachePath)) {
    originalBuffer = fs.readFileSync(cachePath);
  } else {
    console.warn(`Original PDF not found at ${cachePath}, generating appendix-only PDF.`);
  }

  // Parse corrections
  const rawCorrections = report.correctionsJson ? JSON.parse(report.correctionsJson) : [];
  
  // Align corrections with report results
  const alignedCorrections = nonCompliances.map(r => {
    const match = rawCorrections.find((c: any) => c.gapId && c.gapId.toLowerCase() === r.item.id.toLowerCase());
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

  const correctedPdfBuffer = await generateCorrectedProgramPDF(
    report.programDocument,
    originalBuffer,
    alignedCorrections,
    report.correctedText || '',
    'gl', // Galician
    report.results
  );

  const correctedPath = path.join(process.cwd(), 'pdfs', '2025_200230_gl_corregido.pdf');
  fs.writeFileSync(correctedPath, correctedPdfBuffer);
  console.log(`Corrected Program PDF written to: ${correctedPath}`);

  await graphBuilder.disconnect();
  console.log('Done!');
}

main().catch(console.error);
