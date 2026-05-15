import type { KeepaliveErrorCode } from './types.js';

export class KeepaliveError extends Error {
  readonly code: KeepaliveErrorCode;
  readonly requestId: string;
  override readonly cause?: unknown;

  constructor(code: KeepaliveErrorCode, message: string, requestId: string, cause?: unknown) {
    super(message);
    this.name = 'KeepaliveError';
    this.code = code;
    this.requestId = requestId;
    if (cause !== undefined) this.cause = cause;
  }
}
