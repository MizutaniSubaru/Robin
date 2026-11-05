// TDLib answered a request with an `error` object
export class TdError extends Error {
  override readonly name = "TdError";
  constructor(
    readonly code: number,
    readonly tdMessage: string,
    readonly method: string,
  ) {
    super(`${method} failed: ${code} ${tdMessage}`);
  }
}

export class TdTimeoutError extends Error {
  override readonly name = "TdTimeoutError";
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`${method} got no response within ${timeoutMs} ms`);
  }
}

// The client or the whole hub is gone; the request will never be answered
export class TdClosedError extends Error {
  override readonly name = "TdClosedError";
}
