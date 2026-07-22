import { randomBytes } from "node:crypto";

/**
 * Lightweight OTel-style tracing. Each span carries a trace id and span id and emits a
 * structured log line on completion (which an OTel collector or log pipeline ingests).
 * Spans cover the SDK→verdict→seal path. This is intentionally minimal; a full OTel SDK can
 * be swapped in behind the same `span()` call.
 */
export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
}

export type LogSink = (line: Record<string, unknown>) => void;

const defaultSink: LogSink = (line) => process.stdout.write(JSON.stringify(line) + "\n");

export class Tracer {
  constructor(
    private readonly sink: LogSink = defaultSink,
    private readonly clock: () => number = () => Number(process.hrtime.bigint() / 1000n),
  ) {}

  newTrace(): SpanContext {
    return { traceId: randomBytes(16).toString("hex"), spanId: randomBytes(8).toString("hex") };
  }

  child(parent: SpanContext): SpanContext {
    return {
      traceId: parent.traceId,
      spanId: randomBytes(8).toString("hex"),
      parentSpanId: parent.spanId,
    };
  }

  async span<T>(
    name: string,
    ctx: SpanContext,
    attrs: Record<string, unknown>,
    fn: (ctx: SpanContext) => Promise<T> | T,
  ): Promise<T> {
    const start = this.clock();
    let status = "ok";
    try {
      return await fn(ctx);
    } catch (err) {
      status = "error";
      this.sink({
        kind: "span",
        name,
        traceId: ctx.traceId,
        spanId: ctx.spanId,
        parentSpanId: ctx.parentSpanId,
        status,
        error: (err as Error).message,
        ...attrs,
      });
      throw err;
    } finally {
      if (status === "ok") {
        this.sink({
          kind: "span",
          name,
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          parentSpanId: ctx.parentSpanId,
          durationUs: this.clock() - start,
          status,
          ...attrs,
        });
      }
    }
  }
}
