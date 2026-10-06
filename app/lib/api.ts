/** HTTP client for LED Poster ESP firmware (v1 REST API). */

import type { AnimationData, Frame } from './types';

/** Default timeout — RN fetch has no built-in limit; unreachable LAN hosts can hang for minutes. */
const DEFAULT_TIMEOUT_MS = 20_000;

/** Response from GET /caps — device memory & grid capabilities. */
export interface DeviceCaps {
  /** Maximum number of GIF frames the device can hold given current free heap. */
  maxFrames: number;
  width: number;
  height: number;
  /** Total free heap bytes at the time of the request. */
  freeHeap: number;
  /** Largest contiguous free block — honest view of heap fragmentation. */
  largestBlock: number;
}

export function normalizeBaseUrl(raw: string): string {
  const t = raw.trim().replace(/\/+$/, '');
  if (!t) return '';
  if (!/^https?:\/\//i.test(t)) return `http://${t}`;
  return t;
}

async function parseResponse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * fetch with AbortSignal timeout so the UI never spins forever on dead IPs / wrong Wi‑Fi.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') {
      throw new Error(
        `Request timed out after ${timeoutMs / 1000}s. Check: same Wi‑Fi as ESP, correct IP in Settings (Save), ESP powered and connected.`
      );
    }
    throw e;
  } finally {
    clearTimeout(id);
  }
}

/**
 * GET /caps — fetch device memory & grid capabilities.
 * Use the returned `maxFrames` as `ledOptions.maxGifFrames` so the app
 * automatically adapts to whatever heap the ESP has free right now.
 * Falls back gracefully — if the endpoint is unavailable (old firmware)
 * the caller should use the hardcoded default of 24.
 */
export async function getDeviceCaps(
  baseUrl: string
): Promise<{ ok: boolean; caps?: DeviceCaps; error?: string }> {
  const url = `${normalizeBaseUrl(baseUrl)}/caps`;
  try {
    const res = await fetchWithTimeout(url, {}, 5_000);
    const data = await parseResponse(res);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    if (typeof data !== 'object' || data === null) {
      return { ok: false, error: 'Unexpected /caps response format' };
    }
    const d = data as Record<string, unknown>;
    const caps: DeviceCaps = {
      maxFrames:    typeof d.max_frames    === 'number' ? d.max_frames    : 24,
      width:        typeof d.width         === 'number' ? d.width         : 32,
      height:       typeof d.height        === 'number' ? d.height        : 48,
      freeHeap:     typeof d.free_heap     === 'number' ? d.free_heap     : 0,
      largestBlock: typeof d.largest_block === 'number' ? d.largest_block : 0,
    };
    return { ok: true, caps };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getStatus(baseUrl: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const url = `${normalizeBaseUrl(baseUrl)}/status`;
  try {
    const res = await fetchWithTimeout(url, {});
    const data = await parseResponse(res);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postEmpty(
  baseUrl: string,
  path: string
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const url = `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    const data = await parseResponse(res);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function postJson(
  baseUrl: string,
  path: string,
  body: unknown
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const url = `${normalizeBaseUrl(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await parseResponse(res);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Optional callbacks while uploading chunked frames (Import / Gallery UX). */
export type PostAnimationUploadOptions = {
  /** Fires after each frame POST succeeds (`frame` is 1-based). */
  onFrameUploaded?: (info: { frame: number; total: number }) => void;
};

const BEGIN_TIMEOUT_MS = 15_000;
const FRAME_TIMEOUT_MS = 30_000;
/** Per-request tries before giving up on a frame. */
const REQUEST_ATTEMPTS = 4;
/** Full begin→frames→commit rounds, used when the frame cursor desyncs. */
const UPLOAD_ATTEMPTS = 2;

type UploadOutcome =
  | { kind: 'ok'; data?: unknown }
  | { kind: 'desync'; error: string; data?: unknown }
  | { kind: 'fatal'; error: string; data?: unknown };

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function messageFrom(data: unknown): string | undefined {
  if (typeof data === 'object' && data !== null && 'message' in data) {
    return String((data as Record<string, unknown>).message);
  }
  return undefined;
}

function numberFrom(data: unknown, key: string): number | undefined {
  if (typeof data === 'object' && data !== null && key in data) {
    const v = (data as Record<string, unknown>)[key];
    if (typeof v === 'number') return v;
  }
  return undefined;
}

/**
 * POST a JSON body, retrying transient failures with linear backoff.
 *
 * Dropped connections and timeouts are retried. A 4xx/5xx reply means the
 * firmware rejected the request, so retrying cannot help — except 503, which
 * the WebServer emits when it is briefly busy.
 */
async function postWithRetry(
  url: string,
  body: string,
  timeoutMs: number
): Promise<{ ok: boolean; status?: number; data?: unknown; error?: string }> {
  let lastError = 'request failed';
  for (let tries = 1; tries <= REQUEST_ATTEMPTS; tries++) {
    try {
      const res = await fetchWithTimeout(
        url,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
        timeoutMs
      );
      const data = await parseResponse(res);
      if (res.ok) return { ok: true, status: res.status, data };
      if (res.status !== 503) {
        const detail = messageFrom(data) ?? `HTTP ${res.status}`;
        return { ok: false, status: res.status, data, error: detail };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
    if (tries < REQUEST_ATTEMPTS) await delay(400 * tries);
  }
  return { ok: false, error: `${lastError} (after ${REQUEST_ATTEMPTS} attempts)` };
}

function animationPayloadFromSource(
  source: string | AnimationData
): { meta: unknown; config: unknown; frames: Frame[] } | { error: string } {
  if (typeof source === 'object' && source !== null && 'frames' in source) {
    const frames = source.frames;
    if (!Array.isArray(frames) || frames.length === 0) {
      return { error: 'Animation has no frames' };
    }
    return { meta: source.meta, config: source.config, frames: frames as Frame[] };
  }
  if (typeof source !== 'string') {
    return { error: 'Invalid animation source' };
  }
  try {
    const anim = JSON.parse(source) as { meta: unknown; config: unknown; frames: unknown[] };
    if (!Array.isArray(anim.frames) || anim.frames.length === 0) {
      return { error: 'Animation has no frames' };
    }
    return { meta: anim.meta, config: anim.config, frames: anim.frames as Frame[] };
  } catch {
    return { error: 'Invalid animation JSON — could not parse' };
  }
}

/**
 * Upload an animation using the chunked frame protocol (port 80).
 *
 * Why chunked?  The ESP32 WebServer buffers the entire HTTP body before calling
 * any handler.  A 4-frame 32×48 pretty-printed JSON is ~300 KB — far above the
 * ~220 KB free heap with Wi-Fi active — causing an OOM crash and "Network
 * request failed".  Sending one compact frame at a time (~22 KB per request)
 * keeps peak WebServer RAM at ~44 KB, well within limits.  Everything stays on
 * port 80, so router firewall rules are never an issue.
 *
 * Pass an {@link AnimationData} object from Import to avoid parsing a large JSON
 * string twice on the phone.
 *
 * Protocol:
 *   POST /animation/begin   {"meta":{...},"config":{...},"frame_count":N}
 *   POST /animation/frame   [[R,G,B],...] × pixelsPerFrame  (compact, no indent)
 *   POST /animation/commit  {}
 *   POST /animation/abort   {}  (on error — resets firmware state)
 */
export async function postAnimationJson(
  baseUrl: string,
  source: string | AnimationData,
  options?: PostAnimationUploadOptions
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const base = normalizeBaseUrl(baseUrl);

  const payload = animationPayloadFromSource(source);
  if ('error' in payload) {
    return { ok: false, error: payload.error };
  }
  const { meta, config, frames } = payload;

  const abort = () =>
    fetchWithTimeout(`${base}/animation/abort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).catch(() => {});

  // Congested 2.4 GHz networks drop packets, and one lost frame used to fail the
  // whole upload. Each step is retried; a frame whose reply is lost after the
  // firmware accepted it desyncs the cursor, which restarts the upload.
  const attempt = async (): Promise<UploadOutcome> => {
    const beginBody = JSON.stringify({ meta, config, frame_count: frames.length });
    const begun = await postWithRetry(`${base}/animation/begin`, beginBody, BEGIN_TIMEOUT_MS);
    if (!begun.ok) {
      // 507 = ESP32 could not allocate the frame buffers; message carries the max.
      if (begun.status === 507) {
        const msg = messageFrom(begun.data) ?? 'Device out of memory';
        return { kind: 'fatal', error: `Device memory full — reduce frame count. ${msg}`, data: begun.data };
      }
      return { kind: 'fatal', error: begun.error ?? 'begin failed', data: begun.data };
    }

    for (let i = 0; i < frames.length; i++) {
      const frameBody = JSON.stringify(frames[i]); // compact, ~14 KB for 32×48
      const sent = await postWithRetry(`${base}/animation/frame`, frameBody, FRAME_TIMEOUT_MS);
      if (!sent.ok) {
        return { kind: 'fatal', error: sent.error ?? `frame ${i + 1} failed`, data: sent.data };
      }
      // The firmware appends to framePtrs[receivedFrames], so its count is the
      // source of truth. Anything but i+1 means a duplicate landed.
      const received = numberFrom(sent.data, 'frames_received');
      if (received !== undefined && received !== i + 1) {
        return { kind: 'desync', error: `frame cursor desync at ${i + 1} (device has ${received})` };
      }
      options?.onFrameUploaded?.({ frame: i + 1, total: frames.length });
    }

    const committed = await postWithRetry(`${base}/animation/commit`, '{}', BEGIN_TIMEOUT_MS);
    if (!committed.ok) {
      return { kind: 'fatal', error: committed.error ?? 'commit failed', data: committed.data };
    }
    return { kind: 'ok', data: committed.data };
  };

  let last: UploadOutcome = { kind: 'fatal', error: 'upload not attempted' };
  for (let round = 0; round < UPLOAD_ATTEMPTS; round++) {
    last = await attempt();
    if (last.kind === 'ok') return { ok: true, data: last.data };
    await abort();
    if (last.kind === 'fatal') break;
  }
  return { ok: false, error: last.error, data: last.data };
}

export async function postProfileJson(
  baseUrl: string,
  profileJson: string
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  const url = `${normalizeBaseUrl(baseUrl)}/profile`;
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: profileJson,
    });
    const data = await parseResponse(res);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, data };
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
