/** Wire values from matrix/chat/chat_server.thrift; independent of V1 scenes. */
export const SAFETY_CHECK_V2_SCENE = {
  AssistantReply: 1,
  GeneratedImage: 2,
  AssistantThinking: 3,
  DesktopAssistantReply: 11,
  DesktopAssistantThinking: 13,
  AppAssistantReply: 21,
  AppAssistantThinking: 23,
  WebAssistantReply: 31,
  WebAssistantThinking: 33,
  UserQuery: 100,
  UserUploadImage: 101,
  UserUploadFile: 102,
  DesktopUserQuery: 110,
  AppUserQuery: 120,
  WebUserQuery: 130,
  UserAvatar: 200,
  InterfaceImage: 201,
} as const;

export type SafetyCheckV2Scene = (typeof SAFETY_CHECK_V2_SCENE)[keyof typeof SAFETY_CHECK_V2_SCENE];

/** biz-gateway V2 HTTP verdicts; these values are not chat-server RPC actions. */
export const GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION = {
  Allow: 1,
  Block: 2,
  Replace: 3,
  Guide: 4,
} as const;

export type GatewaySafetyCheckV2HttpAction =
  (typeof GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION)[keyof typeof GATEWAY_SAFETY_CHECK_V2_HTTP_ACTION];

export type SafetyCheckV2Headers = NonNullable<RequestInit['headers']>;

export type SafetyCheckV2ErrorKind = 'auth' | 'http' | 'transport' | 'response' | 'upstream';

export type SafetyTransportKind = 'dns' | 'connect' | 'tls' | 'timeout' | 'aborted' | 'unknown';

/** Only allowlisted categories survive; never retain exception text, URLs or causes. */
export function classifySafetyTransportError(error: unknown): SafetyTransportKind {
  let current = error;
  for (let depth = 0; depth < 4 && isSafetyCheckV2Record(current); depth += 1) {
    const { name } = current;
    const code = typeof current.code === 'string' ? current.code : '';
    if (
      name === 'TimeoutError' ||
      [
        'ETIMEDOUT',
        'UND_ERR_CONNECT_TIMEOUT',
        'UND_ERR_HEADERS_TIMEOUT',
        'UND_ERR_BODY_TIMEOUT',
      ].includes(code)
    )
      return 'timeout';
    if (name === 'AbortError' || code === 'ABORT_ERR') return 'aborted';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns';
    if (
      ['ECONNREFUSED', 'ECONNRESET', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code)
    )
      return 'connect';
    if (
      [
        'CERT_HAS_EXPIRED',
        'DEPTH_ZERO_SELF_SIGNED_CERT',
        'SELF_SIGNED_CERT_IN_CHAIN',
        'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
        'ERR_TLS_CERT_ALTNAME_INVALID',
        'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
      ].includes(code)
    )
      return 'tls';
    current = current.cause;
  }
  return 'unknown';
}

/** A failed check has no verdict. Callers must handle it separately from Allow. */
export class SafetyCheckV2Error extends Error {
  constructor(
    readonly kind: SafetyCheckV2ErrorKind,
    readonly statusCode?: number,
    readonly transportKind?: SafetyTransportKind,
  ) {
    super(`SafetyCheckV2 ${kind} error`);
    this.name = 'SafetyCheckV2Error';
  }
}

export function isSafetyCheckV2Record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** No retry or V1 fallback: transport failures never manufacture an Allow verdict. */
export async function postSafetyCheckV2(input: {
  url: string;
  headers?: SafetyCheckV2Headers;
  body: unknown;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    const headers = new Headers(input.headers);
    headers.set('Content-Type', 'application/json');
    const timeout = AbortSignal.timeout(10_000);
    response = await (input.fetchImpl ?? fetch)(input.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input.body),
      signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
      redirect: 'error',
    });
  } catch (error) {
    throw new SafetyCheckV2Error('transport', undefined, classifySafetyTransportError(error));
  }
  if (!response.ok) {
    throw new SafetyCheckV2Error(
      response.status === 401 || response.status === 403 ? 'auth' : 'http',
      response.status,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    const transportKind = classifySafetyTransportError(error);
    throw new SafetyCheckV2Error(
      transportKind === 'unknown' ? 'response' : 'transport',
      response.status,
      transportKind,
    );
  }
  if (!isSafetyCheckV2Record(body)) throw new SafetyCheckV2Error('response');
  return body;
}
