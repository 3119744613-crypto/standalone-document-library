/**
 * Generic, bounded fetch/SSE transport. No React, model, or domain dependencies.
 * Reconnection, durable history, cursor acknowledgement and UI state stay with
 * the caller. Only a blank-line-terminated event is delivered; EOF drops a tail.
 *
 * Budget unit: normalized UTF-16 wire characters per pending event, including
 * fields/comments/newlines. This is NOT a token, byte, or total browser heap cap.
 */
export const DEFAULT_MAX_SSE_EVENT_CHARS = 256 * 1024;

export class SSEProtocolError extends Error {
  constructor(code, message, {status} = {}) {
    super(message);
    this.name = 'SSEProtocolError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

const validateLimit = value => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError('maxEventChars must be a positive safe integer');
  }
  return value;
};
const validateEventIdMode = value => {
  if (value !== 'inherited' && value !== 'explicit') {
    throw new TypeError('eventIdMode must be inherited or explicit');
  }
};

/**
 * Incremental SSE framing. Fully consume each feed() iterator before the next
 * feed(). Each iterator yields at most one event at a time, avoiding a second,
 * unbounded array when a network chunk contains many events.
 *
 * The default follows SSE ID inheritance. The explicit compatibility mode
 * reports only a valid id field from the delivered frame, for legacy consumers
 * that otherwise mistake unnumbered messages for duplicate replay events.
 *
 * @param {{lastEventId?: string, maxEventChars?: number,
 *   eventIdMode?: 'inherited'|'explicit'}} options
 * @returns {{feed: (text: string) => Generator<object>, end: () => void}}
 */
export function createSSEParser({lastEventId = '', maxEventChars = DEFAULT_MAX_SSE_EVENT_CHARS, eventIdMode = 'inherited'} = {}) {
  const limit = validateLimit(maxEventChars);
  validateEventIdMode(eventIdMode);
  let line = '';
  let eventType = '';
  let eventId = eventIdMode === 'explicit' ? '' : String(lastEventId);
  let data = [];
  let frameChars = 0;
  let skipLF = false;
  let firstText = true;
  let ended = false;

  const charge = count => {
    if (frameChars + count > limit) {
      throw new SSEProtocolError('SSE_EVENT_TOO_LARGE', 'SSE event exceeded the configured character limit');
    }
    frameChars += count;
  };
  const finishLine = () => {
    const value = line;
    line = '';
    if (value === '') {
      const event = data.length
        ? {type: eventType || 'message', data: data.join('\n'), lastEventId: eventId}
        : null;
      eventType = '';
      if (eventIdMode === 'explicit') eventId = '';
      data = [];
      frameChars = 0;
      return event;
    }
    if (value.startsWith(':')) return null;
    const colon = value.indexOf(':');
    const field = colon < 0 ? value : value.slice(0, colon);
    let text = colon < 0 ? '' : value.slice(colon + 1);
    if (text.startsWith(' ')) text = text.slice(1); // exactly one optional space
    if (field === 'data') data.push(text);
    else if (field === 'event') eventType = text;
    else if (field === 'id' && !text.includes('\0')) eventId = text;
    // retry/unknown fields do not change this application's reconnect policy.
    return null;
  };

  return {
    *feed(text) {
      if (ended) throw new TypeError('Cannot feed an ended SSE parser');
      if (typeof text !== 'string') throw new TypeError('SSE parser expects decoded text');
      if (!text.length) return;
      if (firstText) {
        firstText = false;
        if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      }
      let start = 0;
      if (skipLF && text.length) {
        if (text[0] === '\n') start = 1;
        skipLF = false;
      }
      const breaks = /[\r\n]/g;
      breaks.lastIndex = start;
      let match;
      while ((match = breaks.exec(text)) !== null) {
        const stop = match.index;
        charge(stop - start + 1); // normalize CRLF to a single newline
        line += text.slice(start, stop);
        start = stop + 1;
        if (text[stop] === '\r') {
          if (text[start] === '\n') start += 1;
          else if (start === text.length) skipLF = true;
        }
        breaks.lastIndex = start;
        const event = finishLine();
        if (event) yield event;
      }
      if (start < text.length) {
        charge(text.length - start);
        line += text.slice(start);
      }
    },
    end() {
      // Never turn transport EOF into an application-level commit boundary.
      line = '';
      data = [];
      eventType = '';
      frameChars = 0;
      ended = true;
    },
  };
}

const throwIfAborted = signal => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Stream aborted', 'AbortError');
};
const cancelBody = async body => {
  try { await body?.cancel(); } catch { /* preserve the original error */ }
};

/**
 * Read ONE response, not an autonomous retry loop.
 *
 * onEvent is awaited: consumer failures propagate and deliveries stay ordered.
 * Cancellation is checked between deliveries, including within a single chunk.
 * A callback already running must cooperate with its own cancellation needs.
 *
 * @param {string|URL} url
 * @param {{headers?: HeadersInit, lastEventId?: string|number,
 *   signal?: AbortSignal, onEvent?: (event: {type:string,data:string,lastEventId:string}) => unknown,
 *   maxEventChars?: number, eventIdMode?: 'inherited'|'explicit',
 *   fetchImpl?: typeof fetch}} options
 */
export async function readDeepEventStream(url, {
  headers = {},
  lastEventId = 0,
  signal,
  onEvent,
  maxEventChars = DEFAULT_MAX_SSE_EVENT_CHARS,
  eventIdMode = 'inherited',
  fetchImpl = globalThis.fetch,
} = {}) {
  validateLimit(maxEventChars);
  validateEventIdMode(eventIdMode);
  if (onEvent !== undefined && typeof onEvent !== 'function') {
    throw new TypeError('onEvent must be a function');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is not available');
  throwIfAborted(signal);
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', 'text/event-stream');
  requestHeaders.set('Last-Event-ID', String(lastEventId || 0));
  const response = await fetchImpl(url, {headers: requestHeaders, signal});
  try {
    throwIfAborted(signal);
    if (!response.ok) {
      throw new SSEProtocolError('SSE_HTTP_ERROR', `SSE request failed (${response.status})`, {status: response.status});
    }
    const mime = (response.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase();
    if (mime !== 'text/event-stream') {
      throw new SSEProtocolError('SSE_CONTENT_TYPE', 'Expected a text/event-stream response');
    }
    if (typeof response.body?.getReader !== 'function') {
      throw new SSEProtocolError('SSE_MISSING_BODY', 'SSE response has no readable body');
    }
  } catch (error) {
    await cancelBody(response.body);
    throw error;
  }

  const reader = response.body.getReader();
  // Preserve the BOM here; the framing parser removes exactly one leading BOM.
  const decoder = new TextDecoder('utf-8', {ignoreBOM: true});
  const parser = createSSEParser({lastEventId: String(lastEventId || 0), maxEventChars, eventIdMode});
  let exhausted = false;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, {once: true});
  try {
    while (true) {
      throwIfAborted(signal);
      const {value, done} = await reader.read();
      throwIfAborted(signal);
      const text = done ? decoder.decode() : decoder.decode(value, {stream: true});
      for (const event of parser.feed(text)) {
        throwIfAborted(signal);
        await onEvent?.(event);
        throwIfAborted(signal);
      }
      if (done) {
        exhausted = true;
        return;
      }
    }
  } finally {
    parser.end();
    signal?.removeEventListener('abort', onAbort);
    if (!exhausted) await cancelBody(reader);
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
