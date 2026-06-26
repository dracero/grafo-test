import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

async function main() {
  const apiKey = process.env.LANGSMITH_API_KEY;
  const project = process.env.LANGSMITH_PROJECT || 'trazas_gepa';
  const langsmithEndpoint = process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com';

  const sessionsUrl = `${langsmithEndpoint}/api/v1/sessions?name=${encodeURIComponent(project)}`;
  const sessionsRes = await fetch(sessionsUrl, { headers: { 'x-api-key': apiKey } });
  const sessionsJson = await sessionsRes.json() as any;
  const projectId = sessionsJson[0].id;

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
      select: ['id', 'inputs'],
      limit: 1,
    }),
  });

  const resJson = await response.json() as any;
  const run = resJson.runs[0];
  let inputsParsed = run.inputs;
  if (typeof inputsParsed === 'string') {
    inputsParsed = JSON.parse(inputsParsed);
  }
  let state = inputsParsed || {};
  if (inputsParsed && typeof inputsParsed === 'object' && inputsParsed.inputs) {
    state = JSON.parse(inputsParsed.inputs);
  }

  console.log('--- app:validated_compliance_analysis FULL TEXT ---');
  console.log(state['app:validated_compliance_analysis']);
}

main().catch(console.error);
