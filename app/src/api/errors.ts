import type { ErrorCode } from "./quote/model";

/** An error that answers with `{ error, message, reason? }` and the given status. */
export class ApiError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 429 | 502 | 503, readonly apiError: ErrorCode, message: string, readonly reason?: string) {
    super(message);
    this.name = "ApiError";
  }
}
