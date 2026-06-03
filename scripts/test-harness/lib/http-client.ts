import { config } from "../config.js";

export interface HttpResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  durationMs: number;
}

export async function httpPost(
  url: string,
  body: unknown,
  options?: { token?: string; timeout?: number; headers?: Record<string, string> },
): Promise<HttpResponse> {
  const token = options?.token ?? config.wrapperToken;
  const start = Date.now();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
    headers["X-API-Key"] = token;
  }
  Object.assign(headers, options?.headers ?? {});
  const resp = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(options?.timeout ?? 30000),
  });
  const durationMs = Date.now() - start;
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => { respHeaders[k] = v; });
  let respBody: unknown;
  const ct = resp.headers.get("content-type") ?? "";
  try {
    respBody = ct.includes("json") ? await resp.json() : await resp.text();
  } catch {
    respBody = await resp.text();
  }
  return { status: resp.status, body: respBody, headers: respHeaders, durationMs };
}

export async function httpGet(
  url: string,
  options?: { token?: string; timeout?: number },
): Promise<HttpResponse> {
  const token = options?.token ?? config.wrapperToken;
  const start = Date.now();
  const headers: Record<string, string> = {};
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
    headers["X-API-Key"] = token;
  }
  const resp = await fetch(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(options?.timeout ?? 15000),
  });
  const durationMs = Date.now() - start;
  const respHeaders: Record<string, string> = {};
  resp.headers.forEach((v, k) => { respHeaders[k] = v; });
  let respBody: unknown;
  const ct = resp.headers.get("content-type") ?? "";
  try {
    respBody = ct.includes("json") ? await resp.json() : await resp.text();
  } catch {
    respBody = await resp.text();
  }
  return { status: resp.status, body: respBody, headers: respHeaders, durationMs };
}

export function apiUrl(path: string): string {
  return `${config.wrapperUrl}${path}`;
}
