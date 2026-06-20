import { LlmAgent, SequentialAgent, InMemoryRunner } from '@google/adk';
import { GeminiLlm } from '../src/services/gemini-llm';
import { tracer, SpanKind, SpanStatusCode, context, trace, Span } from '../src/utils/tracing';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import * as dotenv from 'dotenv';
dotenv.config();

// Initialize OTel for testing
const provider = new BasicTracerProvider();
const exporter = new InMemorySpanExporter();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
provider.register();

// Global tracking variables
let activePipelineSpan: Span | undefined = undefined;
const activeAgentSpans = new Map<string, Span>();

// Monkey patch GeminiLlm to simulate the proposed change inside its generateContentAsync method
(GeminiLlm.prototype as any).generateContentAsync = async function* (llmRequest: any, stream?: boolean, abortSignal?: AbortSignal) {
  const modelName = llmRequest.model || (this as any).model;
  
  // LOOKUP PARENT SPAN EXPLICITLY
  const agentName = llmRequest.config?.labels?.adk_agent_name;
  const parentSpan = agentName ? activeAgentSpans.get(agentName) : undefined;
  let parentCtx = context.active();
  if (parentSpan) {
    parentCtx = trace.setSpan(parentCtx, parentSpan);
  }

  // START SPAN WITH EXPLICIT PARENT CONTEXT
  const span = tracer.startSpan(`GeminiLlm: ${modelName}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      'langsmith.span.kind': 'LLM',
      'gen_ai.system': 'gemini',
      'gen_ai.request.model': modelName,
    }
  }, parentCtx);

  try {
    span.setAttribute('outputs', JSON.stringify({ role: 'model', parts: [{ text: 'Hello!' }] }));
    span.setStatus({ code: SpanStatusCode.OK });
    yield {
      content: { role: 'model', parts: [{ text: 'Hello!' }] }
    };
  } catch (err: any) {
    span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
    span.recordException(err);
    throw err;
  } finally {
    span.end();
  }
};

// Patch LlmAgent
const originalLlmAgentRunAsync = (LlmAgent.prototype as any).runAsyncImpl;
if (originalLlmAgentRunAsync) {
  (LlmAgent.prototype as any).runAsyncImpl = function (ctx: any, ...args: any[]) {
    const agentName = this.name || this.constructor.name;
    const state = ctx?.session?.state || {};
    
    // Explicit parenting from activePipelineSpan
    let parentCtx = context.active();
    if (activePipelineSpan) {
      parentCtx = trace.setSpan(parentCtx, activePipelineSpan);
    }

    // Create span
    const span = tracer.startSpan(`Agent: ${agentName}`, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'langsmith.span.kind': 'chain',
        'inputs': JSON.stringify(state),
      }
    }, parentCtx);

    activeAgentSpans.set(agentName, span);

    const agentCtx = trace.setSpan(context.active(), span);
    const innerIterable = context.with(agentCtx, () => originalLlmAgentRunAsync.call(this, ctx, ...args));
    
    // Wrap async iterable to end the span on finish
    const iterator = innerIterable[Symbol.asyncIterator]();
    let accumulatedContent = '';

    return {
      [Symbol.asyncIterator]() {
        return {
          async next(...nArgs: any[]) {
            try {
              const result = await iterator.next(...nArgs);
              if (result.done) {
                if (accumulatedContent) {
                  span.setAttribute('outputs', JSON.stringify({ content: accumulatedContent }));
                }
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                activeAgentSpans.delete(agentName);
              } else {
                if (result.value && typeof result.value === 'object') {
                  const contentStr = result.value.content?.parts?.[0]?.text || '';
                  accumulatedContent += contentStr;
                }
              }
              return result;
            } catch (error: any) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
              span.recordException(error);
              span.end();
              activeAgentSpans.delete(agentName);
              throw error;
            }
          },
          async return(...rArgs: any[]) {
            if (typeof iterator.return === 'function') {
              try {
                const result = await iterator.return(...rArgs);
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                activeAgentSpans.delete(agentName);
                return result;
              } catch (error: any) {
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                span.recordException(error);
                span.end();
                activeAgentSpans.delete(agentName);
                throw error;
              }
            }
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            activeAgentSpans.delete(agentName);
            return { done: true, value: undefined };
          },
          async throw(...tArgs: any[]) {
            if (typeof iterator.throw === 'function') {
              try {
                const result = await iterator.throw(...tArgs);
                return result;
              } catch (error: any) {
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                span.recordException(error);
                span.end();
                activeAgentSpans.delete(agentName);
                throw error;
              }
            }
            span.setStatus({ code: SpanStatusCode.ERROR, message: tArgs[0]?.message || String(tArgs[0]) });
            span.end();
            activeAgentSpans.delete(agentName);
            throw tArgs[0];
          }
        };
      }
    };
  };
}

// Patch SequentialAgent
const originalSeqAgentRunAsync = (SequentialAgent.prototype as any).runAsyncImpl;
if (originalSeqAgentRunAsync) {
  (SequentialAgent.prototype as any).runAsyncImpl = function (ctx: any, ...args: any[]) {
    const pipelineName = this.name || this.constructor.name;
    const state = ctx?.session?.state || {};
    
    const span = tracer.startSpan(pipelineName, {
      kind: SpanKind.INTERNAL,
      attributes: {
        'langsmith.span.kind': 'chain',
        'inputs': JSON.stringify(state),
      }
    });

    activePipelineSpan = span;

    const pipelineCtx = trace.setSpan(context.active(), span);
    const innerIterable = context.with(pipelineCtx, () => originalSeqAgentRunAsync.call(this, ctx, ...args));
    
    const iterator = innerIterable[Symbol.asyncIterator]();

    return {
      [Symbol.asyncIterator]() {
        return {
          async next(...nArgs: any[]) {
            try {
              const result = await context.with(pipelineCtx, () => iterator.next(...nArgs));
              if (result.done) {
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                if (activePipelineSpan === span) {
                  activePipelineSpan = undefined;
                }
              }
              return result;
            } catch (error: any) {
              span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
              span.recordException(error);
              span.end();
              if (activePipelineSpan === span) {
                activePipelineSpan = undefined;
              }
              throw error;
            }
          },
          async return(...rArgs: any[]) {
            if (typeof iterator.return === 'function') {
              try {
                const result = await context.with(pipelineCtx, () => iterator.return!(...rArgs));
                span.setStatus({ code: SpanStatusCode.OK });
                span.end();
                if (activePipelineSpan === span) {
                  activePipelineSpan = undefined;
                }
                return result;
              } catch (error: any) {
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                span.recordException(error);
                span.end();
                if (activePipelineSpan === span) {
                  activePipelineSpan = undefined;
                }
                throw error;
              }
            }
            span.setStatus({ code: SpanStatusCode.OK });
            span.end();
            if (activePipelineSpan === span) {
              activePipelineSpan = undefined;
            }
            return { done: true, value: undefined };
          },
          async throw(...tArgs: any[]) {
            if (typeof iterator.throw === 'function') {
              try {
                const result = await context.with(pipelineCtx, () => iterator.throw!(...tArgs));
                return result;
              } catch (error: any) {
                span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
                span.recordException(error);
                span.end();
                if (activePipelineSpan === span) {
                  activePipelineSpan = undefined;
                }
                throw error;
              }
            }
            span.setStatus({ code: SpanStatusCode.ERROR, message: tArgs[0]?.message || String(tArgs[0]) });
            span.end();
            if (activePipelineSpan === span) {
              activePipelineSpan = undefined;
            }
            throw tArgs[0];
          }
        };
      }
    };
  };
}

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
  console.log('Starting execution...');
  const iterator = runner.runEphemeral({
    userId: 'test',
    newMessage: { role: 'user', parts: [{ text: 'Go' }] },
    stateDelta: { 'app:normative_doc': 'normative.pdf' }
  });

  for await (const event of iterator) {
    // consume iterator
  }

  // Print all captured spans
  console.log('\n--- Captured Spans ---');
  const spans = exporter.getFinishedSpans();
  spans.forEach(s => {
    console.log(`Span Name: ${s.name}`);
    console.log(`Span ID: ${s.spanContext().spanId}`);
    console.log(`Parent ID: ${s.parentSpanId || 'none'}`);
    console.log('--------------------');
  });
}

test().catch(console.error);
