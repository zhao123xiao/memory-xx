export interface MemoryXXHttpRequest<TBody = unknown> {
  readonly method: string;
  readonly body: TBody;
}

export interface MemoryXXHttpResponse<TBody = unknown> {
  readonly status: number;
  readonly body: TBody;
}
