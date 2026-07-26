export class AppError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class InsufficientCreditsError extends AppError {
  constructor(message = 'User does not have enough credits') {
    super(message, 402, 'INSUFFICIENT_CREDITS');
  }
}

export class InvalidStateTransitionError extends AppError {
  constructor(message = 'Content is not in a state that allows this operation') {
    super(message, 409, 'INVALID_STATE_TRANSITION');
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request data') {
    super(message, 400, 'VALIDATION_ERROR');
  }
}
