import { LlmAgent, SequentialAgent, InMemoryRunner } from '@google/adk';
import { GeminiLlm } from '../src/services/gemini-llm';
import * as dotenv from 'dotenv';
dotenv.config();

const originalLlmAgentRunAsyncImpl = (LlmAgent.prototype as any).runAsyncImpl;

(LlmAgent.prototype as any).runAsyncImpl = function (...args: any[]) {
  const result = originalLlmAgentRunAsyncImpl.apply(this, args);
  console.log('[LlmAgent.runAsyncImpl] returned:', typeof result);
  console.log('Is AsyncIterable?', result && Symbol.asyncIterator in result);
  console.log('Is Iterable?', result && Symbol.iterator in result);
  console.log('Methods:', result ? Object.getOwnPropertyNames(Object.getPrototypeOf(result)) : 'none');
  return result;
};

async function test() {
  const model = new GeminiLlm({ model: 'gemini-2.5-flash' });
  const agent1 = new LlmAgent({
    name: 'Agent1',
    model,
    instruction: 'Say hello'
  });
  
  const pipeline = new SequentialAgent({
    name: 'Pipeline',
    subAgents: [agent1]
  });

  const runner = new InMemoryRunner({ agent: pipeline });
  const iterator = runner.runEphemeral({
    userId: 'test',
    newMessage: { role: 'user', parts: [{ text: 'Go' }] },
    stateDelta: { 'app:normative_doc': 'normative.pdf' }
  });

  for await (const event of iterator) {
    // consume iterator
  }
}

test().catch(console.error);
