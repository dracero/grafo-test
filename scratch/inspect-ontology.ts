import { KnowledgeGraphBuilderImpl } from '../src/services/knowledge-graph-builder';
import { ConfigurationManager } from '../src/config';

async function main() {
  const configManager = new ConfigurationManager();
  configManager.load();
  const config = configManager.getConfig();

  const graphBuilder = new KnowledgeGraphBuilderImpl();
  await graphBuilder.connect(config.neo4j);

  const driver = (graphBuilder as any).driver;
  const session = driver.session();

  const userEmail = 'dracero@fi.uba.ar';

  console.log('--- ALL ONTOLOGY ITEMS AND EXTRACTED_FROM ---');
  const result = await session.run(`
    MATCH (o:OntologyItem)-[r:EXTRACTED_FROM]->(d)
    RETURN o.name as item_name, o.id as item_id, d.name as doc_name
  `);
  result.records.forEach(r => {
    console.log(`- Item Name: "${r.get('item_name')}", ID: "${r.get('item_id')}", Doc Name: "${r.get('doc_name')}"`);
  });

  console.log('--- PROGRAM DOCUMENTS AND THEIR RELATIONS ---');
  const progResult = await session.run(`
    MATCH (p:ProgramDocument)-[r]->(target)
    RETURN p.name as program, type(r) as relType, labels(target) as targetLabels, target.name as targetName
  `);
  progResult.records.forEach(r => {
    console.log(`- Program: "${r.get('program')}", Rel: "${r.get('relType')}", Target: "${r.get('targetName')}" (${r.get('targetLabels')})`);
  });

  await session.close();
  await graphBuilder.disconnect();
}

main().catch(console.error);
