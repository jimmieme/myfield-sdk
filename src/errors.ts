// Public error classes. Exported unprefixed — the @myfield/sdk package
// scope is the namespace; `error.name` matches the class name.

/**
 * A local data operation requires an authorized connection.
 * @public
 */
export class NotConnectedError extends Error {
  constructor() {
    super("bucket is not connected; call connect() first");
    this.name = "NotConnectedError";
  }
}

/**
 * HTTP and retry hints; retryability does not determine commit outcome.
 * @public
 */
export type ClientErrorOptions = {
  status?: number;
  requestId?: string;
  retryable?: boolean;
  retryAfterMs?: number;
  maxBytes?: number;
  cause?: unknown;
};

/**
 * An HTTP, network, invalid-input or invalid-response failure.
 * @public
 */
export class ClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly maxBytes?: number;

  constructor(code: string, message: string, options: ClientErrorOptions = {}) {
    super(message, { cause: options.cause });
    this.name = "ClientError";
    this.code = code;
    this.status = options.status;
    this.requestId = options.requestId;
    this.retryable = options.retryable ?? false;
    this.retryAfterMs = options.retryAfterMs;
    this.maxBytes = options.maxBytes;
  }
}
