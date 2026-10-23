import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { AppError } from './app-error.js';
import { logger } from '../../app/logger.js';

export function errorHandler(error: FastifyError | AppError | Error, request: FastifyRequest, reply: FastifyReply) {
  const timestamp = new Date().toISOString();

  // Caso 1: Error de dominio o aplicación (AppError)
  if (error instanceof AppError) {
    if (error.statusCode >= 500) {
      logger.error({ err: error, reqId: request.id }, `[${error.code}] ${error.message}`);
    } else {
      logger.warn({ err: error, reqId: request.id }, `[${error.code}] ${error.message}`);
    }

    return reply.status(error.statusCode).send({
      statusCode: error.statusCode,
      error: error.code,
      message: error.message,
      details: error.details,
      timestamp
    });
  }

  // Caso 2: Error de validación de esquema de Fastify (TypeBox / Schema validation)
  if ('validation' in error && error.validation) {
    logger.warn({ err: error, reqId: request.id }, 'Error de validación de payload Fastify');
    return reply.status(400).send({
      statusCode: 400,
      error: 'VALIDATION_ERROR',
      message: error.message,
      details: error.validation,
      timestamp
    });
  }

  // Caso 3: Errores no controlados (500)
  logger.error({ err: error, reqId: request.id }, 'Error no controlado en el servidor');
  return reply.status(500).send({
    statusCode: 500,
    error: 'INTERNAL_SERVER_ERROR',
    message: 'Ocurrió un error inesperado en el servidor',
    timestamp
  });
}
