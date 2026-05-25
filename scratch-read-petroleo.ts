import * as dotenv from 'dotenv';
import { KnowledgeGraphBuilderImpl } from './src/services/knowledge-graph-builder';

dotenv.config();

async function run() {
  const graphBuilder = new KnowledgeGraphBuilderImpl();
  await graphBuilder.connect({
    uri: process.env.NEO4J_URI || '',
    username: process.env.NEO4J_USERNAME || '',
    password: process.env.NEO4J_PASSWORD || ''
  });

  const progName = 'RESCS_2023_1600_PETROLEO_Plan_de_Estudios_Texto_ordenado_681ce83c8e.pdf';
  const text = await graphBuilder.getProgramText(progName);
  
  if (!text) {
    console.log('No text found for Petroleum program.');
    await graphBuilder.disconnect();
    return;
  }

  console.log(`Successfully retrieved Petroleum program text. Length: ${text.length}`);

  // Search for occurrence of key terms
  const lines = text.split('\n');
  console.log('Searching for "Proyecto Integrador" or "TIF" or "Integrador":');
  lines.forEach((line, idx) => {
    if (/integrador|tif|petróleo/i.test(line)) {
      console.log(`Line ${idx + 1}: ${line.trim()}`);
    }
  });

  await graphBuilder.disconnect();
}

run().catch(console.error);
