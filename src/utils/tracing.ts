import { trace, SpanStatusCode, SpanKind, Span, Context, context } from '@opentelemetry/api';

export const tracer = trace.getTracer('pdf-knowledge-graph');

export { SpanStatusCode, SpanKind, context, trace };
export type { Span, Context };

export interface TraceSpanOptions {
  kind?: SpanKind;
  spanKind?: 'LLM' | 'chain' | 'tool' | 'retriever' | 'embedding';
  inputs?: any;
  attributes?: Record<string, any>;
  parentCtx?: Context;
}

/**
 * Executes a function within an active OpenTelemetry span.
 * Handles setting LangSmith specific attributes, status codes, and exceptions.
 */
export async function withActiveSpan<T>(
  name: string,
  options: TraceSpanOptions,
  fn: (span: Span, ctx: Context) => Promise<T>
): Promise<T> {
  const spanOptions = {
    kind: options.kind ?? SpanKind.INTERNAL,
  };
  
  const parentContext = options.parentCtx ?? context.active();
  
  return tracer.startActiveSpan(name, spanOptions, parentContext, async (span) => {
    try {
      if (options.spanKind) {
        span.setAttribute('langsmith.span.kind', options.spanKind);
      }
      if (options.inputs !== undefined) {
        const inputVal = typeof options.inputs === 'string' 
          ? options.inputs 
          : JSON.stringify(options.inputs);
        span.setAttribute('inputs', inputVal);
      }
      if (options.attributes) {
        for (const [k, v] of Object.entries(options.attributes)) {
          if (v !== undefined) {
            span.setAttribute(k, typeof v === 'object' ? JSON.stringify(v) : v);
          }
        }
      }
      
      const currentCtx = context.active();
      const res = await fn(span, currentCtx);
      
      span.setStatus({ code: SpanStatusCode.OK });
      return res;
    } catch (err: any) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

// Global tracking variables for ADK agent trajectory hierarchy
export let activePipelineSpan: Span | undefined = undefined;
export const activeAgentSpans = new Map<string, Span>();

// Asynchronously load ADK and apply monkey patching to decouple tracing from circular dependencies
import('@google/adk')
  .then((adk) => {
    // 1. Patch LlmAgent.prototype.runAsyncImpl
    const LlmAgent = adk.LlmAgent;
    if (LlmAgent && LlmAgent.prototype) {
      const originalRunAsync = LlmAgent.prototype.runAsyncImpl;
      if (originalRunAsync) {
        LlmAgent.prototype.runAsyncImpl = function (ctx: any, ...args: any[]) {
          const agentName = this.name || this.constructor.name;
          const state = ctx?.session?.state || {};
          
          let parentCtx = context.active();
          if (activePipelineSpan) {
            parentCtx = trace.setSpan(parentCtx, activePipelineSpan);
          }
          
          const span = tracer.startSpan(`Agent: ${agentName}`, {
            kind: SpanKind.INTERNAL,
            attributes: {
              'langsmith.span.kind': 'chain',
              'inputs': JSON.stringify(state),
            }
          }, parentCtx);
          
          activeAgentSpans.set(agentName, span);
          
          const agentCtx = trace.setSpan(context.active(), span);
          const innerIterable = context.with(agentCtx, () => originalRunAsync.call(this, ctx, ...args));
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
    }

    // 2. Patch SequentialAgent.prototype.runAsyncImpl
    const SequentialAgent = adk.SequentialAgent;
    if (SequentialAgent && SequentialAgent.prototype) {
      const originalRunAsync = SequentialAgent.prototype.runAsyncImpl;
      if (originalRunAsync) {
        SequentialAgent.prototype.runAsyncImpl = function (ctx: any, ...args: any[]) {
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
          const innerIterable = context.with(pipelineCtx, () => originalRunAsync.call(this, ctx, ...args));
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
    }
  })
  .catch((err) => {
    // Fail-silent if ADK cannot be loaded/patched (e.g. in some isolated test runners)
  });
