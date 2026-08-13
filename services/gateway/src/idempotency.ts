import { randomUUID } from "node:crypto";

export const IDEMPOTENCY_CONFORMANCE_PROTOCOL = "pharos-idempotency-conformance-v1";

export interface IdempotencyConformanceOptions {
  target: string;
  probePath: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ProbeResponse {
  protocol?: unknown;
  idempotencyKey?: unknown;
  executions?: unknown;
  resultId?: unknown;
}

/**
 * Actively prove that an upstream persists idempotency keys before the gateway serves traffic.
 *
 * The configured conformance endpoint must use the same durable idempotency implementation as the
 * real side-effect routes. It receives the same key and body twice. Both responses must name one
 * execution and the same durable result; the second must explicitly identify a replay.
 */
export async function assertUpstreamIdempotencyConformance(
  options: IdempotencyConformanceOptions,
): Promise<{ resultId: string }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const idempotencyKey = `pharos-conformance-${randomUUID()}`;
  const requestBody = JSON.stringify({
    protocol: IDEMPOTENCY_CONFORMANCE_PROTOCOL,
    idempotencyKey,
  });

  const invoke = async (attempt: 1 | 2): Promise<ProbeResponse> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();
    let response: Response;
    try {
      response = await fetchImpl(`${options.target}${options.probePath}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          "x-pharos-conformance": IDEMPOTENCY_CONFORMANCE_PROTOCOL,
        },
        body: requestBody,
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(
        `upstream idempotency conformance attempt ${attempt} failed: ${(error as Error).message}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }

    if (response.status !== 200) {
      throw new Error(
        `upstream idempotency conformance attempt ${attempt} returned HTTP ${response.status}`,
      );
    }
    const replayed = response.headers.get("x-idempotency-replayed");
    if (attempt === 1 && replayed === "true") {
      throw new Error(
        "upstream idempotency conformance first attempt was incorrectly marked as a replay",
      );
    }
    if (attempt === 2 && replayed !== "true") {
      throw new Error(
        "upstream idempotency conformance retry did not return x-idempotency-replayed: true",
      );
    }
    const contentLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(contentLength) && contentLength > 65_536) {
      throw new Error("upstream idempotency conformance response exceeds 65536 bytes");
    }
    const text = await response.text();
    if (text.length > 65_536) {
      throw new Error("upstream idempotency conformance response exceeds 65536 characters");
    }
    try {
      return JSON.parse(text) as ProbeResponse;
    } catch {
      throw new Error("upstream idempotency conformance response is not JSON");
    }
  };

  const first = await invoke(1);
  const second = await invoke(2);
  for (const [attempt, response] of [
    [1, first],
    [2, second],
  ] as const) {
    if (
      response.protocol !== IDEMPOTENCY_CONFORMANCE_PROTOCOL ||
      response.idempotencyKey !== idempotencyKey ||
      response.executions !== 1 ||
      typeof response.resultId !== "string" ||
      response.resultId.length === 0
    ) {
      throw new Error(
        `upstream idempotency conformance attempt ${attempt} returned an invalid proof`,
      );
    }
  }
  if (first.resultId !== second.resultId) {
    throw new Error("upstream idempotency conformance retry returned a different result");
  }
  return { resultId: first.resultId as string };
}
