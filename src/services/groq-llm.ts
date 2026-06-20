import { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';
import { createLogger } from './logger';
import { tracer, SpanKind, SpanStatusCode, activeAgentSpans, context, trace } from '../utils/tracing';

const logger = createLogger();

export class GroqLlm extends BaseLlm {
  private apiKey: string;
  private defaultModel: string;

  constructor({ model, apiKey }: { model?: string; apiKey?: string } = {}) {
    const selectedModel = model || 'llama-3.3-70b-versatile';
    super({ model: selectedModel });
    this.apiKey = apiKey || process.env.GROQ_API_KEY || '';
    this.defaultModel = selectedModel;

    if (!this.apiKey) {
      logger.error('GroqLlm', 'GROQ_API_KEY is not defined in the environment or constructor.', new Error('Missing Groq API Key'));
    }
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    const modelName = llmRequest.model || this.model;
    logger.info('GroqLlm', `Sending request to Groq model: ${modelName}`);

    const agentName = llmRequest.config?.labels?.adk_agent_name;
    const parentSpan = agentName ? activeAgentSpans.get(agentName) : undefined;
    let parentCtx = context.active();
    if (parentSpan) {
      parentCtx = trace.setSpan(parentCtx, parentSpan);
    }

    const span = tracer.startSpan(`GroqLlm: ${modelName}`, {
      kind: SpanKind.CLIENT,
      attributes: {
        'langsmith.span.kind': 'LLM',
        'gen_ai.system': 'groq',
        'gen_ai.request.model': modelName,
        'inputs': JSON.stringify({ contents: llmRequest.contents, config: llmRequest.config })
      }
    }, parentCtx);

    try {
      // Map ADK/Gemini contents to OpenAI/Groq messages
      const messages: Array<{ role: string; content: string }> = [];

      // Prepend system instruction if present in request config
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
          messages.push({ role: 'system', content: systemText });
        }
      }

      // Map content history
      if (llmRequest.contents) {
        for (const content of llmRequest.contents) {
          const role = content.role === 'model' ? 'assistant' : content.role || 'user';
          let text = '';
          if (content.parts) {
            text = content.parts.map((p: any) => p.text || '').join('\n');
          }
          
          // Skip empty contents
          if (!text.trim()) continue;

          messages.push({ role, content: text });
        }
      }

      let attempt = 0;
      const maxRetries = 5;
      let delay = 2500; // Start with 2.5s delay

      while (attempt < maxRetries) {
        try {
          const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: modelName,
              messages,
              temperature: llmRequest.config?.temperature ?? 0.2,
              max_tokens: llmRequest.config?.maxOutputTokens ?? 4096,
            }),
            signal: abortSignal
          });

          if (response.status === 429) {
            attempt++;
            if (attempt >= maxRetries) {
              const errMsg = 'Groq API rate limit exceeded after maximum retry attempts.';
              span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
              yield {
                errorCode: '429',
                errorMessage: errMsg
              };
              return;
            }
            logger.warn('GroqLlm', `Rate limit (429) received from Groq. Retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delay));
            delay *= 2; // exponential backoff
            continue;
          }

          if (!response.ok) {
            const errText = await response.text();
            const errMsg = `Groq API Error: ${errText}`;
            logger.error('GroqLlm', `Groq API returned error status ${response.status}: ${errText}`, new Error('Groq API Error'));
            span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
            yield {
              errorCode: String(response.status),
              errorMessage: errMsg
            };
            return;
          }

          const json = await response.json() as any;
          const content = json.choices?.[0]?.message?.content || '';

          const usage = json.usage;
          if (usage) {
            logger.info('GroqLlm', `Token usage for ${modelName} - Prompt: ${usage.prompt_tokens}, Completion: ${usage.completion_tokens}, Total: ${usage.total_tokens}`);
            span.setAttributes({
              'gen_ai.usage.prompt_tokens': usage.prompt_tokens,
              'gen_ai.usage.completion_tokens': usage.completion_tokens,
              'gen_ai.usage.total_tokens': usage.total_tokens
            });
          }

          const outputObj = {
            role: 'model',
            parts: [{ text: content }]
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
            logger.error('GroqLlm', `Fetch error calling Groq API (failed after ${attempt} attempts): ${err.message}`, err);
            span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
            span.recordException(err);
            yield {
              errorCode: 'FETCH_ERROR',
              errorMessage: err.message
            };
            return;
          }
          logger.warn('GroqLlm', `Fetch error from Groq. Retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries}): ${err.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2;
        }
      }
    } finally {
      span.end();
    }
  }

  async connect(llmRequest: LlmRequest): Promise<any> {
    throw new Error('connect() is not supported by GroqLlm');
  }
}
