import { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';
import { createLogger } from './logger';
import { apiKeyManager } from '../utils/api-key-manager';
import { tracer, SpanKind, SpanStatusCode, activeAgentSpans, context, trace } from '../utils/tracing';

const logger = createLogger();

export class GeminiLlm extends BaseLlm {
  private apiKey: string;
  private defaultModel: string;

  constructor({ model, apiKey }: { model?: string; apiKey?: string } = {}) {
    const selectedModel = model || 'gemini-2.5-flash';
    super({ model: selectedModel });
    this.apiKey = apiKey || ''; // If not explicitly passed, keep it empty to enable dynamic rotation
    this.defaultModel = selectedModel;

    if (!this.apiKey && !apiKeyManager.getCurrentKey()) {
      logger.error('GeminiLlm', 'GOOGLE_API_KEY or GOOGLE_API_KEYS is not defined in the environment.', new Error('Missing Google API Key'));
    }
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    const modelName = llmRequest.model || this.model;
    logger.info('GeminiLlm', `Sending request to Gemini model: ${modelName}`);

    const agentName = llmRequest.config?.labels?.adk_agent_name;
    const parentSpan = agentName ? activeAgentSpans.get(agentName) : undefined;
    let parentCtx = context.active();
    if (parentSpan) {
      parentCtx = trace.setSpan(parentCtx, parentSpan);
    }

    const span = tracer.startSpan(`GeminiLlm: ${modelName}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'langsmith.span.kind': 'LLM',
        'gen_ai.system': 'gemini',
        'gen_ai.request.model': modelName,
        'inputs': JSON.stringify({ contents: llmRequest.contents, config: llmRequest.config })
      }
    }, parentCtx);

    try {
      // Map system instruction
      let systemInstruction: any = undefined;
      if (llmRequest.config?.systemInstruction) {
        if (typeof llmRequest.config.systemInstruction === 'string') {
          systemInstruction = {
            parts: [{ text: llmRequest.config.systemInstruction }]
          };
        } else if (typeof llmRequest.config.systemInstruction === 'object') {
          const parts = (llmRequest.config.systemInstruction as any).parts;
          if (Array.isArray(parts)) {
            systemInstruction = { parts };
          }
        }
      }

      // Map content history
      const contents: any[] = [];
      if (llmRequest.contents) {
        for (const content of llmRequest.contents) {
          const role = content.role === 'model' || content.role === 'assistant' ? 'model' : 'user';
          let parts: any[] = [];
          if (content.parts) {
            parts = content.parts.map((p: any) => {
              if (typeof p === 'string') return { text: p };
              if (p.text) return { text: p.text };
              return p;
            });
          }

          // Skip empty contents
          if (parts.length === 0) continue;

          contents.push({ role, parts });
        }
      }

      const payload: any = {
        contents,
        generationConfig: {
          temperature: llmRequest.config?.temperature ?? 0.2,
          maxOutputTokens: llmRequest.config?.maxOutputTokens ?? 65536,
        }
      };

      if (systemInstruction) {
        payload.systemInstruction = systemInstruction;
      }

      let attempt = 0;
      const maxRetries = 7;
      let delay = 5000; // Start with 5s delay (503 high-demand spikes can last 10-30s)

      while (attempt < maxRetries) {
        const currentKey = this.apiKey || apiKeyManager.getCurrentKey();
        try {
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${currentKey}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload),
            signal: abortSignal
          });

          // Retry on transient errors: 429 (rate limit) and 503 (service unavailable / high demand)
          if (response.status === 429 || response.status === 503) {
            attempt++;
            const errLabel = response.status === 429 ? 'Rate limit (429)' : 'Service unavailable (503)';
            if (attempt >= maxRetries) {
              const errMsg = `Gemini API ${errLabel} after ${maxRetries} retry attempts.`;
              span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
              yield {
                errorCode: String(response.status),
                errorMessage: errMsg
              };
              return;
            }

            if (!this.apiKey) {
              apiKeyManager.rotateKey(currentKey);
            }

            // If we have multiple keys and just rotated, we can retry with a shorter delay.
            // Otherwise, we perform exponential backoff.
            const sleepDelay = (!this.apiKey && apiKeyManager.getKeyCount() > 1) ? 1000 : delay;
            logger.warn('GeminiLlm', `${errLabel} received from Gemini. Retrying in ${sleepDelay}ms with current/next key... (Attempt ${attempt}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, sleepDelay));
            
            if (this.apiKey || apiKeyManager.getKeyCount() <= 1) {
              delay *= 2; // exponential backoff only if single key
            }
            continue;
          }

          if (!response.ok) {
            const errText = await response.text();
            const errMsg = `Gemini API Error: ${errText}`;
            logger.error('GeminiLlm', `Gemini API returned error status ${response.status}: ${errText}`, new Error('Gemini API Error'));
            span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
            yield {
              errorCode: String(response.status),
              errorMessage: errMsg
            };
            return;
          }

          const json = await response.json() as any;
          const contentText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';

          const usage = json.usageMetadata;
          if (usage) {
            logger.info('GeminiLlm', `Token usage for ${modelName} - Prompt: ${usage.promptTokenCount}, Completion: ${usage.candidatesTokenCount}, Total: ${usage.totalTokenCount}`);
            span.setAttributes({
              'gen_ai.usage.prompt_tokens': usage.promptTokenCount,
              'gen_ai.usage.completion_tokens': usage.candidatesTokenCount,
              'gen_ai.usage.total_tokens': usage.totalTokenCount
            });
          }

          const outputObj = {
            role: 'model',
            parts: [{ text: contentText }]
          };
          span.setAttribute('outputs', JSON.stringify(outputObj));
          span.setStatus({ code: SpanStatusCode.OK });

          yield {
            content: outputObj
          };
          return; // Success!

        } catch (err: any) {
          attempt++;
          if (attempt >= maxRetries) {
            logger.error('GeminiLlm', `Fetch error calling Gemini API (failed after ${attempt} attempts): ${err.message}`, err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
            yield {
              errorCode: 'FETCH_ERROR',
              errorMessage: err.message
            };
            return;
          }

          // Also rotate key on connection errors, just in case
          if (!this.apiKey) {
            apiKeyManager.rotateKey(currentKey);
          }

          const sleepDelay = (!this.apiKey && apiKeyManager.getKeyCount() > 1) ? 1000 : delay;
          logger.warn('GeminiLlm', `Fetch error from Gemini. Retrying in ${sleepDelay}ms... (Attempt ${attempt}/${maxRetries}): ${err.message}`);
          await new Promise(resolve => setTimeout(resolve, sleepDelay));
          if (this.apiKey || apiKeyManager.getKeyCount() <= 1) {
            delay *= 2;
          }
        }
      }
    } finally {
      span.end();
    }
  }

  async connect(llmRequest: LlmRequest): Promise<any> {
    throw new Error('connect() is not supported by GeminiLlm');
  }
}
