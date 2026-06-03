export interface MemoryV2HttpRequest<TBody = unknown> {
  readonly method: string;
  readonly body: TBody;
}

export interface MemoryV2HttpResponse<TBody = unknown> {
  readonly status: number;
  readonly body: TBody;
}
