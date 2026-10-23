import { describe, it, expect } from 'vitest';
import {
  AppError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  NotFoundError,
  ConflictError,
  FiscalError,
  InfrastructureError
} from '../../src/core/errors/app-error.js';

describe('Jerarquía de Errores (AppError)', () => {
  it('AppError base asigna status code y código por defecto', () => {
    const error = new AppError('Error base');
    expect(error.statusCode).toBe(500);
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).toBe('Error base');
  });

  it('ValidationError tiene código 400 y almacena detalles', () => {
    const details = [{ field: 'cuit', message: 'Inválido' }];
    const error = new ValidationError('Datos inválidos', details);
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details).toEqual(details);
  });

  it('UnauthorizedError tiene código 401', () => {
    const error = new UnauthorizedError();
    expect(error.statusCode).toBe(401);
    expect(error.code).toBe('UNAUTHORIZED');
  });

  it('ForbiddenError tiene código 403', () => {
    const error = new ForbiddenError();
    expect(error.statusCode).toBe(403);
    expect(error.code).toBe('FORBIDDEN');
  });

  it('NotFoundError tiene código 404', () => {
    const error = new NotFoundError('Comprobante no hallado');
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
  });

  it('ConflictError tiene código 409', () => {
    const error = new ConflictError('La clave de idempotencia ya fue utilizada');
    expect(error.statusCode).toBe(409);
    expect(error.code).toBe('CONFLICT');
  });

  it('FiscalError tiene código 422 y soporta lista de observaciones/errores de ARCA', () => {
    const arcaErrors = [{ code: 10016, message: 'El punto de venta no está habilitado para factura electrónica' }];
    const error = new FiscalError('Rechazado por ARCA', arcaErrors);
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('FISCAL_ERROR');
    expect(error.arcaErrors).toEqual(arcaErrors);
  });

  it('InfrastructureError tiene código 502', () => {
    const error = new InfrastructureError('Fallo de conexión SOAP con WSAA');
    expect(error.statusCode).toBe(502);
    expect(error.code).toBe('INFRASTRUCTURE_ERROR');
  });
});
