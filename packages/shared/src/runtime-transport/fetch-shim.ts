/**
 * Fetch shim over the runtime transport frame protocol.
 *
 * `createRuntimeTransportFetch` returns a function with real-`fetch`
 * semantics whose "wire" is a `RuntimeTransportLink` (a MessagePort in
 * production) instead of HTTP. It synthesizes a spec-faithful `Response`
 * (`.ok` / `.status` / `.headers` / `.text()` / `.body.getReader()`), so
 * existing HTTP/SSE clients — the generated DesktopService client,
 * `invokeHttpSse`, the UI SSE parsers — consume it without changes.
 *
 * Error mapping mirrors the app:// protocol handler so the transport swap is
 * behavior-preserving:
 * - `stream-error` before `response-start`: code `aborted` -> 499 null body;
 *   anything else -> 502 JSON `{ error, message }` with
 *   `local_runtime_unavailable` as the default code.
 * - `stream-error` after `response-start`: the body stream errors.
 * - Caller aborts (init.signal) reject with an `AbortError`, like real fetch,
 *   and post an `abort` frame so the host releases the in-flight request.
 * - Body cancellation (`reader.cancel()`) posts an `abort` frame too —
 *   per-stream cancel; turn aborts stay a business `POST .../abort` request.
 */

import { RUNTIME_TRANSPORT_DEFAULT_STREAM_WINDOW } from './frames.js';
import type {
  RuntimeTransportClientFrame,
  RuntimeTransportHeaders,
  RuntimeTransportResponseStartFrame,
  RuntimeTransportServerFrame,
  RuntimeTransportStreamErrorFrame,
} from './frames.js';
import type {
  RuntimeTransportDebugEvent,
  RuntimeTransportDebugSink,
  RuntimeTransportDiagnosticEvent,
  RuntimeTransportDiagnosticReasonCode,
  RuntimeTransportDiagnosticSink,
  RuntimeTransportDiagnosticTerminal,
} from './debug.js';

/** Minimal bidirectional frame pipe; MessagePort/contextBridge implement it. */
export interface RuntimeTransportLink {
  post(frame: RuntimeTransportClientFrame): void;
  /** Returns an unsubscribe function. */
  subscribe(listener: (frame: RuntimeTransportServerFrame) => void): () => void;
  /**
   * Transport-lost signal (utility crash / port gone). When fired, every
   * in-flight request fails: pending ones resolve to a 502 `runtime_lost`
   * response, streaming bodies error — the proposal's runtime-lost contract.
   * Required: a link without it would leave in-flight requests hanging
   * forever after a crash (the shim has no per-request timeout by design).
   */
  subscribeLost(listener: (info: { message?: string }) => void): () => void;
}

export interface CreateRuntimeTransportFetchOptions {
  link: RuntimeTransportLink;
  /** Override request id generation (defaults to crypto.randomUUID). */
  generateRequestId?: () => string;
  /** Best-effort observer fired once when the tunneled request reaches a terminal state. */
  onRequestComplete?: (request: RuntimeTransportRequestComplete) => void;
  /** Best-effort observer for fixed, low-cardinality transport failures. */
  onTransportError?: (failure: RuntimeTransportFailure) => void;
  /** Best-effort observer for renderer/runtime transport debugging. */
  debugSink?: RuntimeTransportDebugSink;
  /** Best-effort metadata-only lifecycle observer for durable diagnostics. */
  diagnosticSink?: RuntimeTransportDiagnosticSink;
}

export type RuntimeTransportRequestKind = 'request' | 'stream';

export interface RuntimeTransportRequestComplete {
  /** Normalized HTTP method used by the tunneled request. */
  method: string;
  /** Original request URL passed to the transport. */
  url: string;
  /**
   * Terminal HTTP status. Caller aborts before response-start report 0;
   * synthesized pre-response failures report 499 or 502. Stream failures
   * after response-start retain the response status already received.
   */
  status: number;
  /**
   * Elapsed time from request start through terminal response/body cleanup.
   * For streams this is the full stream lifetime, not connection time or TTFB.
   */
  durationMs: number;
  /** Whether the response was handled as an ordinary request or a stream. */
  requestKind: RuntimeTransportRequestKind;
}

export type RuntimeTransportFailureReasonCode =
  | 'request_post_failed'
  | 'response_malformed'
  | 'response_missing'
  | 'seq_gap';

export type RuntimeTransportFailurePhase = 'request' | 'response' | 'stream';

export interface RuntimeTransportFailure {
  reasonCode: RuntimeTransportFailureReasonCode;
  phase: RuntimeTransportFailurePhase;
  requestKind: RuntimeTransportRequestKind;
}

export type RuntimeTransportFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
const DEFAULT_ERROR_CODE = 'local_runtime_unavailable';
const ABORTED_ERROR_CODE = 'aborted';
const TRACE_ID_HEADER = 'x-trace-id';
const DIAGNOSTIC_IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function defaultGenerateRequestId(): string {
  return globalThis.crypto.randomUUID();
}

function toAbortError(reason: unknown): unknown {
  if (reason !== undefined && reason !== null) return reason;
  return new DOMException('This operation was aborted', 'AbortError');
}

function toHeaderMap(init: RequestInit['headers'] | Headers | undefined): RuntimeTransportHeaders {
  const map: RuntimeTransportHeaders = {};
  if (!init) return map;
  const headers = init instanceof Headers ? init : new Headers(init);
  headers.forEach((value, key) => {
    map[key] = value;
  });
  return map;
}

function toBytes(payload: string | Uint8Array): Uint8Array {
  return typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
}

interface NormalizedRequest {
  method: string;
  url: string;
  headers: RuntimeTransportHeaders;
  body: string | Uint8Array | undefined;
  signal: AbortSignal | undefined;
}

async function normalizeBody(
  body: RequestInit['body'] | undefined,
  headers: RuntimeTransportHeaders,
): Promise<string | Uint8Array | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  }
  if (body instanceof URLSearchParams) {
    if (!hasHeader(headers, 'content-type')) {
      headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    }
    return body.toString();
  }
  if (typeof Blob !== 'undefined' && body instanceof Blob) {
    if (body.type && !hasHeader(headers, 'content-type')) {
      headers['content-type'] = body.type;
    }
    return new Uint8Array(await body.arrayBuffer());
  }
  throw new TypeError(
    'runtime transport fetch does not support streaming or multipart request bodies; ' +
      'large payloads must go through the asset store',
  );
}

function hasHeader(headers: RuntimeTransportHeaders, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((key) => key.toLowerCase() === lower);
}

function readHeader(headers: RuntimeTransportHeaders, name: string): string | undefined {
  const lower = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1];
}

function toDiagnosticIdentifier(value: string | undefined): string | undefined {
  return value && DIAGNOSTIC_IDENTIFIER_RE.test(value) ? value : undefined;
}

function toDiagnosticPathname(url: string): string {
  try {
    return new URL(url, 'http://runtime-transport.invalid').pathname || '/';
  } catch {
    return '/';
  }
}

function diagnosticReasonFromStreamError(
  frame: RuntimeTransportStreamErrorFrame,
  portLost: boolean,
): RuntimeTransportDiagnosticReasonCode {
  if (portLost || frame.code === 'runtime_lost') return 'runtime_lost';
  return frame.code === ABORTED_ERROR_CODE ? 'remote_aborted' : 'remote_error';
}

function hasEventStreamHeader(headers: RuntimeTransportHeaders): boolean {
  return Object.entries(headers).some(
    ([key, value]) =>
      (key.toLowerCase() === 'accept' || key.toLowerCase() === 'content-type') &&
      value.toLowerCase().includes('text/event-stream'),
  );
}

function hasEventStreamContentType(headers: RuntimeTransportHeaders): boolean {
  return Object.entries(headers).some(
    ([key, value]) =>
      key.toLowerCase() === 'content-type' && value.toLowerCase().includes('text/event-stream'),
  );
}

async function normalizeFetchArgs(
  input: string | URL | Request,
  init: RequestInit | undefined,
): Promise<NormalizedRequest> {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    const method = (init?.method ?? input.method).toUpperCase();
    const headers = toHeaderMap(init?.headers ?? input.headers);
    let body: string | Uint8Array | undefined;
    if (init && 'body' in init) {
      body = await normalizeBody(init.body, headers);
    } else if (input.body !== null) {
      body = new Uint8Array(await input.arrayBuffer());
    }
    if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
      throw new TypeError(`Request with GET/HEAD method cannot have body.`);
    }
    return {
      method,
      url: input.url,
      headers,
      body,
      signal: init?.signal ?? input.signal ?? undefined,
    };
  }

  const method = (init?.method ?? 'GET').toUpperCase();
  const headers = toHeaderMap(init?.headers);
  const body = await normalizeBody(init?.body, headers);
  if (body !== undefined && (method === 'GET' || method === 'HEAD')) {
    throw new TypeError(`Request with GET/HEAD method cannot have body.`);
  }
  return {
    method,
    url: typeof input === 'string' ? input : input.toString(),
    headers,
    body,
    signal: init?.signal ?? undefined,
  };
}

function synthesizeErrorResponse(frame: RuntimeTransportStreamErrorFrame): Response {
  if (frame.code === ABORTED_ERROR_CODE) {
    return new Response(null, { status: 499 });
  }
  return new Response(
    JSON.stringify({
      error: frame.code ?? DEFAULT_ERROR_CODE,
      message: frame.message,
      transportError: true,
    }),
    { status: 502, headers: { 'Content-Type': 'application/json' } },
  );
}

function synthesizeResponse(
  frame: RuntimeTransportResponseStartFrame,
  body: ReadableStream<Uint8Array> | null,
  onMalformed?: () => void,
): Response {
  try {
    return new Response(body, {
      status: frame.status,
      ...(frame.statusText !== undefined ? { statusText: frame.statusText } : {}),
      headers: frame.headers,
    });
  } catch (error) {
    // Defense in depth behind the boundary validator: a frame that slips
    // through with Response-hostile fields (illegal header names, ...) must
    // degrade to a transport error instead of throwing inside a MessagePort
    // message handler.
    onMalformed?.();
    return synthesizeErrorResponse({
      type: 'stream-error',
      id: frame.id,
      seq: frame.seq,
      message: `malformed response-start frame: ${error instanceof Error ? error.message : String(error)}`,
    });
  }
}

/**
 * Creates a fetch-compatible function that tunnels requests over `link`.
 * One instance shares a single lazy link subscription across all in-flight
 * requests and routes server frames back by request id.
 */
export function createRuntimeTransportFetch(
  options: CreateRuntimeTransportFetchOptions,
): RuntimeTransportFetch {
  const { link } = options;
  const generateRequestId = options.generateRequestId ?? defaultGenerateRequestId;
  const onRequestComplete = options.onRequestComplete;
  const debugSink = options.debugSink;
  const diagnosticSink = options.diagnosticSink;

  function isDebugEnabled(): boolean {
    if (!debugSink) return false;
    if (!debugSink.isEnabled) return true;
    try {
      return debugSink.isEnabled();
    } catch {
      return false;
    }
  }

  function emitDebug(event: RuntimeTransportDebugEvent): void {
    if (!isDebugEnabled()) return;
    if (!debugSink) return;
    try {
      debugSink.emit(event);
    } catch {
      // Debug observers must never enter the transport control path.
    }
  }

  function emitDiagnostic(createEvent: () => RuntimeTransportDiagnosticEvent): void {
    if (!diagnosticSink) return;
    try {
      diagnosticSink.onDiagnosticEvent(createEvent());
    } catch {
      // Diagnostics must never enter the transport control path.
    }
  }

  function reportTransportError(failure: RuntimeTransportFailure): void {
    try {
      options.onTransportError?.(failure);
    } catch {
      // Observability must never enter the transport control path.
    }
  }

  function reportAndEmitTransportError(
    failure: RuntimeTransportFailure,
    id?: string,
    message?: string,
  ): void {
    reportTransportError(failure);
    if (!isDebugEnabled()) return;
    emitDebug({
      type: 'transport-error',
      id,
      reasonCode: failure.reasonCode,
      phase: failure.phase,
      requestKind: failure.requestKind,
      ...(message !== undefined ? { message } : {}),
      timestampMs: Date.now(),
    });
  }

  const routes = new Map<string, (frame: RuntimeTransportServerFrame) => void>();
  let portLostRequestIds: Set<string> | undefined;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeLost: (() => void) | null = null;

  function dispatch(frame: RuntimeTransportServerFrame): void {
    routes.get(frame.id)?.(frame);
  }

  function dispatchLost(info: { message?: string }): void {
    const message = info.message ?? 'runtime transport lost';
    const trackPortLoss = isDebugEnabled() || diagnosticSink !== undefined;
    if (trackPortLoss) {
      portLostRequestIds = new Set<string>();
      emitDiagnostic(() => ({
        type: 'port-lost',
        timestampMs: Date.now(),
        activeRequestCount: routes.size,
      }));
      emitDebug({ type: 'port-lost', message, timestampMs: Date.now() });
    }
    try {
      for (const [id, onFrame] of [...routes]) {
        if (trackPortLoss) portLostRequestIds?.add(id);
        onFrame({ type: 'stream-error', id, seq: 0, message, code: 'runtime_lost' });
      }
    } finally {
      if (trackPortLoss) portLostRequestIds = undefined;
    }
  }

  function attachRoute(id: string, onFrame: (frame: RuntimeTransportServerFrame) => void): void {
    routes.set(id, onFrame);
    if (!unsubscribe) unsubscribe = link.subscribe(dispatch);
    if (!unsubscribeLost) unsubscribeLost = link.subscribeLost(dispatchLost);
  }

  function detachRoute(id: string): void {
    routes.delete(id);
    if (routes.size === 0) {
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
      if (unsubscribeLost) {
        unsubscribeLost();
        unsubscribeLost = null;
      }
    }
  }

  return async function runtimeTransportFetch(input, init): Promise<Response> {
    const normalized = await normalizeFetchArgs(input, init);
    const { method, url, headers, body, signal } = normalized;
    if (signal?.aborted) throw toAbortError(signal.reason);

    const id = generateRequestId();
    if (!hasHeader(headers, TRACE_ID_HEADER)) headers[TRACE_ID_HEADER] = id;
    const traceId = toDiagnosticIdentifier(readHeader(headers, TRACE_ID_HEADER));
    const pathname = toDiagnosticPathname(url);
    const requestStartedAtMs = onRequestComplete ? Date.now() : 0;

    return await new Promise<Response>((resolve, reject) => {
      /** Response resolved (response-start seen or synthesized). */
      let responseSettled = false;
      /** Body finished (closed, errored or cancelled); route detached. */
      let bodyFinished = false;
      let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
      let lastSeq = -1;
      let responseStatus = 0;
      const streamWindow = RUNTIME_TRANSPORT_DEFAULT_STREAM_WINDOW;
      let outstandingStreamCredits = streamWindow;
      let flowControlledResponse = false;
      let requestKind: RuntimeTransportRequestKind = hasEventStreamHeader(headers)
        ? 'stream'
        : 'request';
      let firstDiagnosticChunkSeen = false;

      const diagnosticRequest = () => ({
        id,
        ...(traceId ? { traceId } : {}),
        method,
        pathname,
        requestKind,
      });

      function reportRequestComplete(): void {
        const observer = onRequestComplete;
        if (!observer) return;
        const completedRequest: RuntimeTransportRequestComplete = {
          method,
          url,
          status: responseStatus,
          durationMs: Math.max(0, Date.now() - requestStartedAtMs),
          requestKind,
        };
        try {
          globalThis.setTimeout(() => {
            try {
              observer(completedRequest);
            } catch {
              // Observability must never enter the transport control path.
            }
          }, 0);
        } catch {
          // Scheduling telemetry is best-effort and must not affect fetch completion.
        }
      }

      function finish(terminal: {
        type: RuntimeTransportDiagnosticTerminal;
        reasonCode?: RuntimeTransportDiagnosticReasonCode;
      }): void {
        if (bodyFinished) return;
        bodyFinished = true;
        if (signal) signal.removeEventListener('abort', onAbort);
        detachRoute(id);
        emitDiagnostic(() => ({
          ...diagnosticRequest(),
          type: 'terminal',
          terminal: terminal.type,
          ...(responseStatus ? { status: responseStatus } : {}),
          ...(terminal.reasonCode ? { reasonCode: terminal.reasonCode } : {}),
          timestampMs: Date.now(),
          activeRequestCount: routes.size,
        }));
        reportRequestComplete();
      }

      function failBody(
        error: unknown,
        terminal: {
          type: RuntimeTransportDiagnosticTerminal;
          reasonCode?: RuntimeTransportDiagnosticReasonCode;
        },
      ): void {
        if (bodyFinished) return;
        finish(terminal);
        try {
          bodyController?.error(error);
        } catch {
          // Stream may already be closed by the consumer; nothing to do.
        }
      }

      /**
       * Fire-and-forget frame send. `link.post` may throw synchronously
       * (e.g. the preload bridge throws while the transport port is down);
       * for abort/cancel notifications that is best-effort — the host side
       * reaps the request when the port dies anyway.
       */
      function postQuiet(frame: Parameters<RuntimeTransportLink['post']>[0]): void {
        try {
          link.post(frame);
        } catch {
          // Port gone — the down signal / host port-close reaps the request.
        }
      }

      /**
       * Keep host output aligned with the ReadableStream's remaining queue
       * capacity. Credits are granted only after queued chunks are consumed;
       * receiving a frame merely transfers one existing credit into the
       * renderer queue and must not grow the window.
       */
      function replenishStreamCredits(): void {
        if (!flowControlledResponse || bodyFinished || !bodyController) return;
        const desiredSize = Math.max(0, Math.floor(bodyController.desiredSize ?? 0));
        const credits = desiredSize - outstandingStreamCredits;
        if (credits <= 0) return;

        // Increment before posting because an in-memory link may synchronously
        // dispatch the resulting host frame back into this route.
        outstandingStreamCredits += credits;
        try {
          link.post({ type: 'stream-credit', id, credits });
        } catch {
          outstandingStreamCredits -= credits;
          // Port gone — the down signal / host port-close reaps the request.
        }
      }

      function onAbort(): void {
        if (isDebugEnabled()) {
          emitDebug({
            type: 'request-abort',
            id,
            reason: 'client_aborted',
            timestampMs: Date.now(),
          });
        }
        postQuiet({ type: 'abort', id, reason: 'client_aborted' });
        if (!responseSettled) {
          responseSettled = true;
          finish({ type: 'abort', reasonCode: 'client_aborted' });
          reject(toAbortError(signal?.reason));
          return;
        }
        failBody(toAbortError(signal?.reason), { type: 'abort', reasonCode: 'client_aborted' });
      }

      function onFrame(frame: RuntimeTransportServerFrame): void {
        switch (frame.type) {
          case 'response-start': {
            if (responseSettled) return;
            responseSettled = true;
            lastSeq = frame.seq;
            flowControlledResponse = hasEventStreamContentType(frame.headers);
            if (flowControlledResponse) requestKind = 'stream';
            emitDiagnostic(() => ({
              ...diagnosticRequest(),
              type: 'response-start',
              status: frame.status,
              timestampMs: Date.now(),
              activeRequestCount: routes.size,
            }));
            if (isDebugEnabled()) {
              emitDebug({
                type: 'response-start',
                id,
                status: frame.status,
                ...(frame.statusText !== undefined ? { statusText: frame.statusText } : {}),
                headers: { ...frame.headers },
                timestampMs: Date.now(),
              });
            }
            let responseMalformed = false;
            const reportMalformedResponse = () => {
              responseMalformed = true;
              reportAndEmitTransportError(
                {
                  reasonCode: 'response_malformed',
                  phase: 'response',
                  requestKind,
                },
                id,
              );
              postQuiet({ type: 'abort', id, reason: 'malformed_response' });
            };
            if (NULL_BODY_STATUSES.has(frame.status) || method === 'HEAD') {
              const response = synthesizeResponse(frame, null, reportMalformedResponse);
              responseStatus = response.status;
              if (!responseMalformed && isDebugEnabled()) {
                emitDebug({ type: 'response-complete', id, timestampMs: Date.now() });
              }
              finish(
                responseMalformed
                  ? { type: 'error', reasonCode: 'response_malformed' }
                  : { type: 'complete' },
              );
              resolve(response);
              return;
            }
            const stream = new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  bodyController = controller;
                },
                pull() {
                  replenishStreamCredits();
                },
                cancel() {
                  if (bodyFinished) return;
                  finish({ type: 'abort', reasonCode: 'stream_cancelled' });
                  if (isDebugEnabled()) {
                    emitDebug({
                      type: 'request-abort',
                      id,
                      reason: 'stream_cancelled',
                      timestampMs: Date.now(),
                    });
                  }
                  postQuiet({ type: 'abort', id, reason: 'stream_cancelled' });
                },
              },
              { highWaterMark: flowControlledResponse ? streamWindow : 1 },
            );
            const response = synthesizeResponse(frame, stream, reportMalformedResponse);
            responseStatus = response.status;
            if (responseMalformed) finish({ type: 'error', reasonCode: 'response_malformed' });
            resolve(response);
            return;
          }
          case 'stream-chunk': {
            if (!responseSettled || bodyFinished) return;
            if (frame.seq <= lastSeq) return; // wire duplicate — no new host credit was spent
            if (frame.seq !== lastSeq + 1) {
              reportAndEmitTransportError(
                {
                  reasonCode: 'seq_gap',
                  phase: 'stream',
                  requestKind,
                },
                id,
              );
              postQuiet({ type: 'abort', id, reason: 'stream_seq_gap' });
              failBody(
                new Error(
                  `runtime_transport_seq_gap: expected seq ${lastSeq + 1}, got ${frame.seq}`,
                ),
                { type: 'error', reasonCode: 'seq_gap' },
              );
              return;
            }
            lastSeq = frame.seq;
            if (!firstDiagnosticChunkSeen) {
              firstDiagnosticChunkSeen = true;
              emitDiagnostic(() => ({
                ...diagnosticRequest(),
                type: 'response-chunk',
                seq: frame.seq,
                timestampMs: Date.now(),
                activeRequestCount: routes.size,
              }));
            }
            if (isDebugEnabled()) {
              emitDebug({
                type: 'response-chunk',
                id,
                seq: frame.seq,
                payload:
                  frame.payload instanceof Uint8Array ? frame.payload.slice() : frame.payload,
                timestampMs: Date.now(),
              });
            }
            if (flowControlledResponse && outstandingStreamCredits > 0) {
              outstandingStreamCredits -= 1;
            }
            try {
              bodyController?.enqueue(toBytes(frame.payload));
              replenishStreamCredits();
            } catch {
              // Consumer closed the stream between cancel and frame delivery.
            }
            return;
          }
          case 'stream-done': {
            if (!responseSettled) {
              // Protocol violation: body ended before a status line arrived.
              reportAndEmitTransportError(
                {
                  reasonCode: 'response_missing',
                  phase: 'response',
                  requestKind,
                },
                id,
                'runtime transport closed before response-start',
              );
              responseSettled = true;
              responseStatus = 502;
              finish({ type: 'error', reasonCode: 'response_missing' });
              resolve(
                synthesizeErrorResponse({
                  type: 'stream-error',
                  id,
                  seq: frame.seq,
                  message: 'runtime transport closed before response-start',
                }),
              );
              return;
            }
            if (bodyFinished) return;
            // A terminal frame must be exactly the next seq. A stale/colliding
            // seq is failed like a gap instead of being dropped: dropping the
            // only terminal frame would leave the body open forever.
            if (frame.seq !== lastSeq + 1) {
              reportAndEmitTransportError(
                {
                  reasonCode: 'seq_gap',
                  phase: 'stream',
                  requestKind,
                },
                id,
              );
              postQuiet({ type: 'abort', id, reason: 'stream_seq_gap' });
              failBody(
                new Error(
                  `runtime_transport_seq_gap: expected seq ${lastSeq + 1}, got ${frame.seq}`,
                ),
                { type: 'error', reasonCode: 'seq_gap' },
              );
              return;
            }
            lastSeq = frame.seq;
            if (isDebugEnabled()) {
              emitDebug({ type: 'response-complete', id, timestampMs: Date.now() });
            }
            finish({ type: 'complete' });
            try {
              bodyController?.close();
            } catch {
              // Stream already closed/errored; nothing to do.
            }
            return;
          }
          case 'stream-error': {
            if (!responseSettled) {
              if (isDebugEnabled()) {
                emitDebug({
                  type: 'transport-error',
                  id,
                  reasonCode: frame.code ?? DEFAULT_ERROR_CODE,
                  phase: portLostRequestIds?.has(id) ? 'connection' : 'response',
                  requestKind,
                  message: frame.message,
                  timestampMs: Date.now(),
                });
              }
              responseSettled = true;
              responseStatus = frame.code === ABORTED_ERROR_CODE ? 499 : 502;
              const portLost = portLostRequestIds?.has(id) === true;
              finish({
                type: frame.code === ABORTED_ERROR_CODE ? 'abort' : 'error',
                reasonCode: diagnosticReasonFromStreamError(frame, portLost),
              });
              resolve(synthesizeErrorResponse(frame));
              return;
            }
            if (isDebugEnabled()) {
              emitDebug({
                type: 'transport-error',
                id,
                reasonCode: frame.code ?? DEFAULT_ERROR_CODE,
                phase: portLostRequestIds?.has(id) ? 'connection' : 'stream',
                requestKind,
                message: frame.message,
                timestampMs: Date.now(),
              });
            }
            const portLost = portLostRequestIds?.has(id) === true;
            // Keep the transport code on a body that fails after response-start, so the request
            // layer can tell a dropped SSH connection from a server failure, as it does for the
            // synthesized 502 before response-start.
            failBody(
              Object.assign(new Error(frame.message || 'runtime_transport_stream_error'), {
                code: frame.code ?? DEFAULT_ERROR_CODE,
              }),
              {
                type: frame.code === ABORTED_ERROR_CODE ? 'abort' : 'error',
                reasonCode: diagnosticReasonFromStreamError(frame, portLost),
              },
            );
          }
        }
      }

      attachRoute(id, onFrame);
      if (signal) signal.addEventListener('abort', onAbort, { once: true });

      emitDiagnostic(() => ({
        ...diagnosticRequest(),
        type: 'request-start',
        timestampMs: Date.now(),
        activeRequestCount: routes.size,
      }));

      if (isDebugEnabled()) {
        emitDebug({
          type: 'request-start',
          id,
          method,
          url,
          headers: { ...headers },
          ...(body !== undefined ? { body: body instanceof Uint8Array ? body.slice() : body } : {}),
          requestKind,
          timestampMs: Date.now(),
        });
      }

      try {
        link.post({
          type: 'request',
          id,
          method,
          url,
          headers,
          streamWindow,
          ...(body !== undefined ? { body } : {}),
        });
      } catch (error) {
        // The transport is down (e.g. the preload bridge throws while no
        // port is attached). Fail like a lost runtime — an HTTP-shaped 502
        // response, with the route/listeners fully released — instead of
        // leaking the route and surfacing a bare exception.
        responseSettled = true;
        responseStatus = 502;
        finish({ type: 'error', reasonCode: 'request_post_failed' });
        const message = error instanceof Error ? error.message : String(error);
        reportAndEmitTransportError(
          {
            reasonCode: 'request_post_failed',
            phase: 'request',
            requestKind,
          },
          id,
          message,
        );
        resolve(
          synthesizeErrorResponse({
            type: 'stream-error',
            id,
            seq: 0,
            message,
            code: 'runtime_lost',
          }),
        );
      }
    });
  };
}
