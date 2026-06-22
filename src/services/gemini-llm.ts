import { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';
import { createLogger } from './logger';
import { apiKeyManager } from '../utils/api-key-manager';
import { googleRateLimiter } from '../utils/rate-limiter';
import { tracer, SpanKind, SpanStatusCode, activeAgentSpans, activePipelineSpan, context, trace } from '../utils/tracing';

const logger = createLogger();

async function parseRetryDelayFromResponse(response: Response): Promise<number> {
  try {
    const text = await response.clone().text();
    // 1. Try to find "Please retry in X.Ys"
    const match = text.match(/retry in ([\d.]+)s/i);
    if (match && match[1]) {
      const seconds = parseFloat(match[1]);
      if (!isNaN(seconds)) {
        return Math.ceil(seconds * 1000);
      }
    }
    // 2. Try to find "retryDelay": "Xs"
    const match2 = text.match(/"retryDelay":\s*"(\d+)s"/);
    if (match2 && match2[1]) {
      const seconds = parseInt(match2[1], 10);
      if (!isNaN(seconds)) {
        return seconds * 1000;
      }
    }
  } catch (e) {
    // Ignore parsing errors
  }
  return 0;
}

export class GeminiLlm extends BaseLlm {
  private apiKey: string;
  private defaultModel: string;

  constructor({ model, apiKey }: { model?: string; apiKey?: string } = {}) {
    const selectedModel = model || 'gemini-2.5-flash';
    super({ model: selectedModel });
    this.defaultModel = selectedModel;

    // Enable dynamic rotation if using the default environment key
    const defaultEnvKey = typeof process !== 'undefined' && process.env ? process.env.GOOGLE_API_KEY : '';
    if (apiKey === defaultEnvKey) {
      this.apiKey = '';
    } else {
      this.apiKey = apiKey || '';
    }

    if (!this.apiKey && !apiKeyManager.getCurrentGoogleKey()) {
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
    let parentSpan = agentName ? activeAgentSpans.get(agentName) : undefined;
    if (!parentSpan && activeAgentSpans.size > 0) {
      parentSpan = Array.from(activeAgentSpans.values())[0];
    }
    if (!parentSpan) {
      parentSpan = activePipelineSpan;
    }
    let parentCtx = context.active();
    if (parentSpan) {
      parentCtx = trace.setSpan(parentCtx, parentSpan);
    }

    let plainTextInputs = '';
    if (llmRequest.config?.systemInstruction) {
      let systemText = '';
      if (typeof llmRequest.config.systemInstruction === 'string') {
        systemText = llmRequest.config.systemInstruction;
      } else if (typeof llmRequest.config.systemInstruction === 'object') {
        const parts = (llmRequest.config.systemInstruction as any).parts;
        if (Array.isArray(parts)) {
          systemText = parts.map((p: any) => p.text || '').join('\n');
        }
      }
      if (systemText) {
        plainTextInputs += `System: ${systemText}\n\n`;
      }
    }
    if (llmRequest.contents) {
      for (const content of llmRequest.contents) {
        const role = content.role === 'model' || content.role === 'assistant' ? 'Assistant' : 'User';
        let text = '';
        if (content.parts) {
          text = content.parts.map((p: any) => {
            if (typeof p === 'string') return p;
            if (p.text) return p.text;
            return '';
          }).join('\n');
        }
        if (text.trim()) {
          plainTextInputs += `${role}: ${text}\n\n`;
        }
      }
    }
    plainTextInputs = plainTextInputs.trim();

    const span = tracer.startSpan(`GeminiLlm: ${modelName}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'langsmith.span.kind': 'LLM',
        'openinference.span.kind': 'LLM',
        'gen_ai.system': 'gemini',
        'gen_ai.request.model': modelName,
        'inputs': plainTextInputs,
        'input.value': plainTextInputs,
        'gen_ai.content.prompt': plainTextInputs
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
        const currentKey = this.apiKey || apiKeyManager.getCurrentGoogleKey();
        try {
          await googleRateLimiter.throttle();
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
              apiKeyManager.rotateGoogleKey(currentKey);
            }

            let sleepDelay = delay;
            let parsedDelay = 0;
            if (response.status === 503) {
              sleepDelay = Math.max(sleepDelay, 5000);
              logger.warn('GeminiLlm', `Gemini service overloaded (503). Waiting ${sleepDelay}ms...`);
            } else {
              if (!this.apiKey) {
                apiKeyManager.rotateGoogleKey(currentKey);
              }
              parsedDelay = await parseRetryDelayFromResponse(response);
              if (parsedDelay > 0) {
                sleepDelay = Math.max(sleepDelay, parsedDelay + 1500);
                logger.info('GeminiLlm', `Parsed rate limit retry delay of ${parsedDelay}ms from Gemini response.`);
              } else {
                sleepDelay = (!this.apiKey && apiKeyManager.getGoogleKeyCount() > 1 && attempt < 3) ? 1500 : delay;
              }
            }

            logger.warn('GeminiLlm', `${errLabel} received from Gemini. Retrying in ${sleepDelay}ms with current/next key... (Attempt ${attempt}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, sleepDelay));

            if (this.apiKey || apiKeyManager.getGoogleKeyCount() <= 1 || response.status === 503 || parsedDelay > 0) {
              delay *= 2; // exponential backoff only if single key or if rate limited
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
          span.setAttribute('outputs', contentText);
          span.setAttribute('output.value', contentText);
          span.setAttribute('gen_ai.content.completion', contentText);
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
            apiKeyManager.rotateGoogleKey(currentKey);
          }

          let sleepDelay = delay;
          let parsedDelay = 0;
          const errMsg = String(err.message || '').toLowerCase();
          const is503 = errMsg.includes('503') || errMsg.includes('overloaded') || errMsg.includes('service unavailable') || errMsg.includes('high demand');
          
          if (is503) {
            sleepDelay = Math.max(sleepDelay, 5000);
            logger.warn('GeminiLlm', `Gemini service overloaded (503) caught from fetch error. Waiting ${sleepDelay}ms...`);
          } else {
            parsedDelay = err?.message ? (() => {
              const text = String(err.message).toLowerCase();
              const match = text.match(/retry in ([\d.]+)s/);
              if (match && match[1]) {
                const seconds = parseFloat(match[1]);
                if (!isNaN(seconds)) return Math.ceil(seconds * 1000);
              }
              return 0;
            })() : 0;

            if (parsedDelay > 0) {
              sleepDelay = Math.max(sleepDelay, parsedDelay + 1500);
              logger.info('GeminiLlm', `Parsed rate limit retry delay of ${parsedDelay}ms from fetch error.`);
            } else {
              sleepDelay = (!this.apiKey && apiKeyManager.getGoogleKeyCount() > 1 && attempt < 3) ? 1500 : delay;
            }
          }

          logger.warn('GeminiLlm', `Fetch error from Gemini. Retrying in ${sleepDelay}ms... (Attempt ${attempt}/${maxRetries}): ${err.message}`);
          await new Promise(resolve => setTimeout(resolve, sleepDelay));
          if (this.apiKey || apiKeyManager.getGoogleKeyCount() <= 1 || is503 || parsedDelay > 0) {
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
