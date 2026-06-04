export interface FunctionalHttpResult {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
}

export function parseFunctionalHttpResult(raw: string): FunctionalHttpResult {
  const marker = "\nHTTP_CODE:";
  const index = raw.lastIndexOf(marker);
  if (index < 0) return { ok: false, status: 0, body: raw };

  const body = raw.slice(0, index);
  const status = Number.parseInt(raw.slice(index + marker.length).trim(), 10);
  const normalizedStatus = Number.isFinite(status) ? status : 0;
  return {
    ok: normalizedStatus >= 200 && normalizedStatus < 300,
    status: normalizedStatus,
    body,
  };
}
