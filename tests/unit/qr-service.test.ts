import { describe, it, expect } from 'vitest';
import { QrService } from '../../src/modules/documents/application/qr-service.js';

describe('QrService — Generación de Códigos QR Fiscales', () => {
  const sampleQrUrl = 'https://www.afip.gob.ar/fe/qr/?p=eyJ2ZXIiOjEsImZlY2hhIjoiMjAyNi0xMC0yMyJ9';

  it('1. Debe generar un Buffer PNG válido (con firma mágica PNG)', async () => {
    const buffer = await QrService.generatePngBuffer(sampleQrUrl, 200);
    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(100);

    // Firma mágica PNG: 0x89 0x50 0x4E 0x47
    expect(buffer[0]).toBe(0x89);
    expect(buffer[1]).toBe(0x50);
    expect(buffer[2]).toBe(0x4e);
    expect(buffer[3]).toBe(0x47);
  });

  it('2. Debe generar un Data URL en Base64', async () => {
    const dataUrl = await QrService.generateDataUrl(sampleQrUrl, 150);
    expect(dataUrl.startsWith('data:image/png;base64,')).toBe(true);
    expect(dataUrl.length).toBeGreaterThan(150);
  });

  it('3. Debe generar un código QR vectorial SVG', async () => {
    const svg = await QrService.generateSvg(sampleQrUrl, 200);
    expect(svg).toContain('<svg');
    expect(svg).toContain('</svg>');
  });
});
