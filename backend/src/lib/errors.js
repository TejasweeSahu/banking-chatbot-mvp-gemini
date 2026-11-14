/**
 * Typed application errors. `message` is always safe to show to the end user;
 * internal detail belongs in logs only.
 */

export class AppError extends Error {
  constructor(message, { status = 400, code = 'bad_request', details } = {}) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const badRequest = (message, details) => new AppError(message, { status: 400, code: 'validation_error', details });
export const unauthorized = (message = 'Please sign in to continue.') => new AppError(message, { status: 401, code: 'unauthorized' });
export const forbidden = (message = 'You do not have permission to perform this action.') => new AppError(message, { status: 403, code: 'forbidden' });
export const notFound = (message = 'Not found.') => new AppError(message, { status: 404, code: 'not_found' });
export const conflict = (message, details) => new AppError(message, { status: 409, code: 'conflict', details });
export const unprocessable = (message, code = 'business_rule', details) => new AppError(message, { status: 422, code, details });
export const tooManyRequests = (message = 'Too many requests. Please wait a moment and try again.') => new AppError(message, { status: 429, code: 'rate_limited' });
