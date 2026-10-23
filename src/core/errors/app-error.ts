export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 400, 'VALIDATION_ERROR', details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Credenciales no válidas o ausentes') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Acceso no permitido al recurso') {
    super(message, 403, 'FORBIDDEN');
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Recurso no encontrado') {
    super(message, 404, 'NOT_FOUND');
  }
}

export class ConflictError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 409, 'CONFLICT', details);
  }
}

export class FiscalError extends AppError {
  public readonly arcaErrors?: Array<{ code: number | string; message: string }> | undefined;

  constructor(
    message: string,
    arcaErrors?: Array<{ code: number | string; message: string }>,
    details?: unknown
  ) {
    super(message, 422, 'FISCAL_ERROR', details);
    this.arcaErrors = arcaErrors;
  }
}

export class InfrastructureError extends AppError {
  constructor(message: string, code = 'INFRASTRUCTURE_ERROR', details?: unknown) {
    super(message, 502, code, details);
  }
}
