import { KnowledgeGraphBuilderImpl } from '../src/services/knowledge-graph-builder';
import { ConfigurationManager } from '../src/config';

async function main() {
  const configManager = new ConfigurationManager();
  configManager.load();
  const config = configManager.getConfig();

  const graphBuilder = new KnowledgeGraphBuilderImpl();
  await graphBuilder.connect(config.neo4j);

  const report = await graphBuilder.getLatestComparison('dracero@fi.uba.ar');
  console.log('Report object:', JSON.stringify(report, null, 2));

  await graphBuilder.disconnect();
}

main().catch(console.error);
