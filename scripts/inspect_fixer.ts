import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const apiKey = process.env.LANGSMITH_API_KEY;
  const project = process.env.LANGSMITH_PROJECT || 'trazas_gepa';
  const langsmithEndpoint = process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com';

  if (!apiKey) {
    console.error('LANGSMITH_API_KEY is not defined');
    return;
  }

  // Resolve project UUID
  const sessionsUrl = `${langsmithEndpoint}/api/v1/sessions?name=${encodeURIComponent(project)}`;
  const sessionsRes = await fetch(sessionsUrl, { headers: { 'x-api-key': apiKey } });
  const sessionsJson = await sessionsRes.json() as any;
  const projectId = sessionsJson[0].id;

  // Query latest ProgramFixerAgent run
  const queryUrl = `${langsmithEndpoint}/api/v1/runs/query`;
  const response = await fetch(queryUrl, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      session: [projectId],
      filter: 'and(eq(name, "Agent: ProgramFixerAgent"), eq(run_type, "chain"))',
      select: ['id', 'name', 'inputs', 'outputs', 'status', 'start_time'],
      limit: 1,
    }),
  });

  const resJson = await response.json() as any;
  const runs = resJson.runs || [];

  if (runs.length === 0) {
    console.log('No ProgramFixerAgent runs found.');
    return;
  }

  const run = runs[0];
  console.log(`ProgramFixerAgent Run ID: ${run.id} | Start: ${run.start_time}`);
  
  let inputsParsed = run.inputs;
  if (typeof inputsParsed === 'string') {
    try {
      inputsParsed = JSON.parse(inputsParsed);
    } catch {}
  }

  let state = inputsParsed || {};
  if (inputsParsed && typeof inputsParsed === 'object' && inputsParsed.inputs) {
    try {
      state = JSON.parse(inputsParsed.inputs);
    } catch {}
  }

  console.log('\nKeys in state:', Object.keys(state));
  console.log('app:validated_compliance_analysis value length:', state['app:validated_compliance_analysis']?.length || 0);
  if (state['app:validated_compliance_analysis']) {
    console.log('app:validated_compliance_analysis preview (first 400 chars):');
    console.log(state['app:validated_compliance_analysis'].substring(0, 400));
  }
}

main().catch(console.error);
