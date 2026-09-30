/**
 * A request Verdix refused to make or pay for (bad input, price above your
 * cap, budget exhausted, unexpected payment terms), or an answer it could
 * not use. Nothing is paid when this is thrown before the request is sent.
 */
export class VerdixError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VerdixError';
  }
}
