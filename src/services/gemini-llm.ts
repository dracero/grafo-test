import { BaseLlm, LlmRequest, LlmResponse } from '@google/adk';
import { createLogger } from './logger';

const logger = createLogger();

export class GeminiLlm extends BaseLlm {
  private apiKey: string;
  private defaultModel: string;

  constructor({ model, apiKey }: { model?: string; apiKey?: string } = {}) {
    const selectedModel = model || 'gemini-2.5-flash';
    super({ model: selectedModel });
    this.apiKey = apiKey || process.env.GOOGLE_API_KEY || '';
    this.defaultModel = selectedModel;

    if (!this.apiKey) {
      logger.error('GeminiLlm', 'GOOGLE_API_KEY is not defined in the environment or constructor.', new Error('Missing Google API Key'));
    }
  }

  async *generateContentAsync(
    llmRequest: LlmRequest,
    stream?: boolean,
    abortSignal?: AbortSignal
  ): AsyncGenerator<LlmResponse, void> {
    const modelName = llmRequest.model || this.model;
    logger.info('GeminiLlm', `Sending request to Gemini model: ${modelName}`);

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
      try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${this.apiKey}`, {
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
            yield {
              errorCode: String(response.status),
              errorMessage: `Gemini API ${errLabel} after ${maxRetries} retry attempts.`
            };
            return;
          }
          logger.warn('GeminiLlm', `${errLabel} received from Gemini. Retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries})`);
          await new Promise(resolve => setTimeout(resolve, delay));
          delay *= 2; // exponential backoff
          continue;
        }

        if (!response.ok) {
          const errText = await response.text();
          logger.error('GeminiLlm', `Gemini API returned error status ${response.status}: ${errText}`, new Error('Gemini API Error'));
          yield {
            errorCode: String(response.status),
            errorMessage: `Gemini API Error: ${errText}`
          };
          return;
        }

        const json = await response.json() as any;
        const contentText = json.candidates?.[0]?.content?.parts?.[0]?.text || '';

        yield {
          content: {
            role: 'model',
            parts: [{ text: contentText }]
          }
        };
        return; // Success!

      } catch (err: any) {
        attempt++;
        if (attempt >= maxRetries) {
          logger.error('GeminiLlm', `Fetch error calling Gemini API (failed after ${attempt} attempts): ${err.message}`, err);
          yield {
            errorCode: 'FETCH_ERROR',
            errorMessage: err.message
          };
          return;
        }
        logger.warn('GeminiLlm', `Fetch error from Gemini. Retrying in ${delay}ms... (Attempt ${attempt}/${maxRetries}): ${err.message}`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
      }
    }
  }

  async connect(llmRequest: LlmRequest): Promise<any> {
    throw new Error('connect() is not supported by GeminiLlm');
  }
}
