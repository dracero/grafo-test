import type { APIRoute } from 'astro';
import { getUserByEmail } from '../../../../lib/mongodb';
import { KnowledgeGraphBuilderImpl } from '../../../../services/knowledge-graph-builder';

export const GET: APIRoute = async ({ url, locals }) => {
  try {
    // 1. Authorize: check if user is admin
    const userEmail = locals.user?.email;
    console.log('[LangSmith API] Request received, user:', userEmail);
    
    if (!userEmail) {
      console.log('[LangSmith API] Unauthorized: No user email');
      return new Response(JSON.stringify({ success: false, error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const dbUser = await getUserByEmail(userEmail);
    console.log('[LangSmith API] User from DB:', dbUser?.email, 'role:', dbUser?.role);
    
    if (!dbUser || dbUser.role !== 'admin') {
      console.log('[LangSmith API] Forbidden: User is not admin');
      return new Response(JSON.stringify({ success: false, error: 'Forbidden' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 2. Read query params
    const agentName = url.searchParams.get('agentName');
    console.log('[LangSmith API] Agent name:', agentName);
    
    if (!agentName) {
      console.log('[LangSmith API] Missing agentName parameter');
      return new Response(JSON.stringify({ success: false, error: 'Missing agentName parameter' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const limitVal = parseInt(url.searchParams.get('limit') || '20', 10);
    const limit = isNaN(limitVal) ? 20 : limitVal;

    // 3. Query Langsmith
    const apiKey = process.env.LANGSMITH_API_KEY;
    const project = process.env.LANGSMITH_PROJECT || 'trazas_gepa';
    const langsmithEndpoint = process.env.LANGSMITH_ENDPOINT || 'https://api.smith.langchain.com';

    console.log('[LangSmith API] Config:', {
      hasApiKey: !!apiKey,
      apiKeyPrefix: apiKey ? apiKey.substring(0, 10) + '...' : 'undefined',
      project,
      endpoint: langsmithEndpoint
    });

    if (!apiKey) {
      console.error('[LangSmith API] LANGSMITH_API_KEY is not defined in environment');
      console.error('[LangSmith API] Available env vars:', Object.keys(process.env).filter(k => k.includes('LANG')));
      return new Response(JSON.stringify({ 
        success: false, 
        error: 'LANGSMITH_API_KEY is not defined in the environment. Please restart the server to reload environment variables.' 
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // A. Resolve project name to project UUID (session id)
    console.log('[LangSmith API] Resolving project name to UUID...');
    const sessionsUrl = `${langsmithEndpoint}/api/v1/sessions?name=${encodeURIComponent(project)}`;
    console.log('[LangSmith API] Sessions URL:', sessionsUrl);
    
    const sessionsRes = await fetch(sessionsUrl, {
      headers: { 'x-api-key': apiKey }
    });
    
    console.log('[LangSmith API] Sessions response status:', sessionsRes.status, sessionsRes.statusText);
    
    if (!sessionsRes.ok) {
      const errText = await sessionsRes.text();
      console.error('[LangSmith API] Project resolution failed:', errText);
      return new Response(JSON.stringify({ success: false, error: `Langsmith API Project Resolution Error: ${sessionsRes.statusText} - ${errText}` }), {
        status: sessionsRes.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    const sessionsJson = await sessionsRes.json() as any;
    console.log('[LangSmith API] Sessions found:', sessionsJson.length);
    
    if (!Array.isArray(sessionsJson) || sessionsJson.length === 0) {
      console.error('[LangSmith API] Project not found:', project);
      return new Response(JSON.stringify({ success: false, error: `Langsmith Project "${project}" not found` }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    
    const projectId = sessionsJson[0].id;
    console.log('[LangSmith API] Project ID resolved:', projectId);

    // B. Query Langsmith runs using the resolved projectId
    const queryUrl = `${langsmithEndpoint}/api/v1/runs/query`;
    // We search for run name exactly matching the monkey-patch prefix "Agent: " + agentName
    const runNameFilter = `Agent: ${agentName}`;

    const response = await fetch(queryUrl, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        session: [projectId],
        filter: `and(eq(name, "${runNameFilter}"), eq(run_type, "chain"))`,
        select: ['id', 'name', 'inputs', 'outputs', 'status', 'start_time', 'error'],
        limit: limit,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ success: false, error: `Langsmith API Error: ${response.statusText} - ${errText}` }), {
        status: response.status,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const resJson = await response.json() as any;
    const runsList = resJson.runs || [];

    // 4. Map, download S3 inputs, and enrich with Neo4j texts/ontologies
    const mappedRuns = [];
    for (const run of runsList) {
      // A. Parse or download inputs from S3 presigned URL
      let inputsParsed = run.inputs;
      if (!inputsParsed && run.inputs_s3_urls?.ROOT?.presigned_url) {
        try {
          const s3Res = await fetch(run.inputs_s3_urls.ROOT.presigned_url);
          if (s3Res.ok) {
            inputsParsed = await s3Res.json();
          }
        } catch (err: any) {
          console.error(`Failed to fetch inputs from S3 for run ${run.id}:`, err.message);
        }
      }

      if (typeof inputsParsed === 'string') {
        try {
          inputsParsed = JSON.parse(inputsParsed);
        } catch {
          // Keep as is
        }
      }

      // B. Parse outputs with outputs_preview fallback
      let outputText = '';
      if (run.outputs && typeof run.outputs === 'object') {
        outputText = run.outputs.output?.content || run.outputs.output?.value || run.outputs.outputs || '';
      }
      if (!outputText && run.outputs_preview) {
        outputText = String(run.outputs_preview);
      }

      // C. Connect to Neo4j and fetch documents/ontologies if present
      let state = inputsParsed || {};
      let hasNestedInputs = false;
      if (inputsParsed && typeof inputsParsed === 'object' && inputsParsed.inputs) {
        hasNestedInputs = true;
        try {
          state = JSON.parse(inputsParsed.inputs);
        } catch {
          state = inputsParsed.inputs;
        }
      }

      const progDoc = state['app:program_doc'];
      const normDoc = state['app:normative_doc'];
      const email = state['app:user_email'] || userEmail || '';

      if (progDoc || normDoc) {
        const neo4jConfig = {
          uri: process.env.NEO4J_URI || 'bolt://localhost:7687',
          username: process.env.NEO4J_USERNAME || 'neo4j',
          password: process.env.NEO4J_PASSWORD || 'password',
          database: process.env.NEO4J_DATABASE || 'neo4j'
        };

        const graphBuilder = new KnowledgeGraphBuilderImpl();
        try {
          await graphBuilder.connect(neo4jConfig);

          if (agentName === 'ComplianceValidatorAgent' || agentName === 'ProgramFixerAgent' || agentName === 'StructureAnalyzerAgent') {
            state.originalText = await graphBuilder.getProgramText(progDoc, email);
          }
          if (agentName === 'NormativeOntologyAgent') {
            state.ontology = await graphBuilder.getProgramOntology(progDoc, email);
          }
          if (agentName === 'ProgramOntologyAgent') {
            state.ontology = await graphBuilder.getNormativeOntology(normDoc || '', email);
          }
          if (agentName === 'ComplianceGapsAgent') {
            state.gaps = await graphBuilder.getComplianceGaps(normDoc || '', progDoc, email);
          }
          if (agentName === 'OntologyAnalyzerAgent') {
            state.ontology = await graphBuilder.getNormativeOntology(normDoc || '', email);
          }
          if (agentName === 'SchemaOntologyAdjusterAgent') {
            state.ontology = await graphBuilder.getNormativeOntology(normDoc || '', email);
            state.evaluationSchema = await graphBuilder.getEvaluationSchema(email);
            state.ontologyAnalysis = state['app:ontology_analysis'] || '';
          }
          if (agentName === 'RubricSynthesizerAgent') {
            state.evaluationSchema = await graphBuilder.getEvaluationSchema(email);
            state.ontologyAnalysis = state['app:ontology_analysis'] || '';
            state.adjustedOntology = state['app:adjusted_ontology'] || '';
          }

          // Inject intermediate state values required by signatures
          if (agentName === 'ComplianceValidatorAgent') {
            state.complianceAnalysis = state['app:compliance_analysis'] || '';
          }
          if (agentName === 'ProgramFixerAgent') {
            state.normativeAnalysis = state['app:normative_analysis'] || '';
            state.validatedComplianceAnalysis = state['app:validated_compliance_analysis'] || '';
            state.originalStructure = state['app:original_structure'] || '';

            // Count validated gaps count
            let validatedGapsCount = 0;
            try {
              const cleanedText = String(state.validatedComplianceAnalysis).replace(/^```(?:json)?\n?/m, '').replace(/```\s*$/m, '').trim();
              const parsed = JSON.parse(cleanedText);
              validatedGapsCount = parsed?.validatedGaps?.length || 0;
            } catch {}
            state.validatedGapsCount = validatedGapsCount;
          }

          // Infer language
          const isGalician = String(progDoc || normDoc || '').toLowerCase().includes('_gl') || String(progDoc || normDoc || '').toLowerCase().includes('gl.');
          state.targetLangName = isGalician ? 'Gallego' : 'Español';

        } catch (err: any) {
          console.error(`Failed to enrich inputs from Neo4j for run ${run.id}:`, err.message);
        } finally {
          await graphBuilder.disconnect().catch(() => {});
        }
      }

      // Serialize state back into inputsParsed
      if (inputsParsed && typeof inputsParsed === 'object') {
        if (hasNestedInputs) {
          inputsParsed.inputs = JSON.stringify(state);
        } else {
          Object.assign(inputsParsed, state);
        }
      }

      mappedRuns.push({
        id: run.id,
        name: run.name,
        status: run.status,
        createdAt: run.start_time,
        inputs: inputsParsed,
        output: outputText,
        error: run.error || null,
      });
    }

    return new Response(JSON.stringify({ success: true, data: mappedRuns }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    console.error('[LangSmith API] Unhandled error:', error.message);
    console.error('[LangSmith API] Stack trace:', error.stack);
    return new Response(JSON.stringify({ success: false, error: error.message, stack: error.stack }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
