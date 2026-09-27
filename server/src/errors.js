/** Error carrying a stable machine code and an HTTP status. */
export class ChaosError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'ChaosError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

/** Refusal raised by a safety guard. Always 403. */
export class GuardError extends ChaosError {
  constructor(code, message, details) {
    super(code, message, 403, details);
    this.name = 'GuardError';
  }
}
