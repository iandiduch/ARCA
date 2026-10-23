import { describe, it, expect } from 'vitest';
import { isValidCuit, isValidDni, cleanDocumentNumber, formatCuit } from '../../src/core/fiscal/cuit-validator.js';

describe('Validador Fiscal de Documentos (cuit-validator.ts)', () => {
  it('debe validar CUITs reales válidos según Módulo 11', () => {
    // CUITs de ejemplo oficiales ARCA
    expect(isValidCuit('30503612891')).toBe(true); // De delegacion_webservices.md
    expect(isValidCuit('30-50361289-1')).toBe(true);
    expect(isValidCuit('30710955057')).toBe(true);
    expect(isValidCuit('20223626719')).toBe(true);
  });

  it('debe rechazar CUITs con dígito verificador erróneo o longitud inválida', () => {
    expect(isValidCuit('30503612890')).toBe(false); // Verificador alterado
    expect(isValidCuit('3050361289')).toBe(false); // 10 dígitos
    expect(isValidCuit('11503612891')).toBe(false); // Prefijo 11 no válido
    expect(isValidCuit('abc12345678')).toBe(false);
  });

  it('debe validar DNIs numéricos de 6 a 8 dígitos', () => {
    expect(isValidDni('35123456')).toBe(true);
    expect(isValidDni('8123456')).toBe(true);
    expect(isValidDni('123')).toBe(false);
    expect(isValidDni('123456789')).toBe(false);
  });

  it('cleanDocumentNumber debe eliminar guiones, espacios y puntos', () => {
    expect(cleanDocumentNumber('30-50.361.289/1')).toBe('30503612891');
  });

  it('formatCuit debe formatear con guiones XX-XXXXXXXX-X', () => {
    expect(formatCuit('30503612891')).toBe('30-50361289-1');
  });
});
