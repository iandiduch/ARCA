import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { errorHandler } from '../../src/core/errors/error-handler.js';

describe('errorHandler — errores de datos de Postgres (M7)', () => {
  it.each([
    ['22003', 'desborde numérico'],
    ['22021', 'byte nulo'],
    ['22P02', 'sintaxis inválida']
  ])('mapea %s (%s) a 400 aunque Drizzle lo envuelva en DrizzleQueryError', async (code) => {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    app.get('/', async () => {
      // Drizzle 0.45 lanza DrizzleQueryError y deja el error de pg (con el SQLSTATE) en `cause`
      throw Object.assign(new Error('Failed query: insert into "products" ...'), { name: 'DrizzleQueryError', cause: { code } });
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('INPUT_SYNTAX_ERROR');
    await app.close();
  });

  it('un error sin SQLSTATE de datos sigue siendo 500', async () => {
    const app = Fastify();
    app.setErrorHandler(errorHandler);
    app.get('/', async () => {
      throw Object.assign(new Error('Failed query'), { cause: { code: '23505' } });
    });
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(500);
    await app.close();
  });
});
