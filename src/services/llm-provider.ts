import { BaseLlm } from '@google/adk';
import { GeminiLlm } from './gemini-llm';
import { GroqLlm } from './groq-llm';

/**
 * Returns an instance of the configured LLM provider.
 * Falls back to Gemini if no provider is specified or if the provider is unknown.
 * 
 * @param provider - 'gemini' | 'groq' | 'groq-fast'
 */
export function getLlmProvider(provider?: string): BaseLlm {
  const normProvider = (provider || process.env.LLM_PROVIDER || 'gemini').toLowerCase().trim();
  if (normProvider === 'groq') {
    return new GroqLlm({ model: 'llama-3.3-70b-versatile' });
  }
  if (normProvider === 'groq-fast') {
    return new GroqLlm({ model: 'llama-3.1-8b-instant' });
  }
  return new GeminiLlm();
}
