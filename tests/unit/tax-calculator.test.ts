import { describe, it, expect } from 'vitest';
import { TaxCalculator } from '../../src/modules/invoices/domain/tax-calculator.js';

describe('TaxCalculator — Motor de Cálculo Fiscal para WSFEv1', () => {
  it('1. Factura B (Consumidor Final, precios con IVA incluido)', () => {
    // 1 producto con 21% de IVA ($1210 final) y 1 producto con 10.5% ($1105 final)
    const result = TaxCalculator.calculate(
      [
        {
          description: 'Café Especial 1kg',
          quantity: 1,
          unitPrice: 1210,
          vatRate: 21.0
        },
        {
          description: 'Pan Artesanal 1kg',
          quantity: 1,
          unitPrice: 1105,
          vatRate: 10.5
        }
      ],
      6, // Factura B
      true // Precios con IVA incluido (POS minorista)
    );

    expect(result.totalAmount).toBe(2315);
    expect(result.netTaxedAmount).toBe(2000);
    expect(result.vatAmount).toBe(315);
    expect(result.netUntaxedAmount).toBe(0);
    expect(result.exemptAmount).toBe(0);

    // Debe generar 2 grupos de IVA para ARCA WSFEv1
    expect(result.vatSubtotals).toHaveLength(2);

    const iva21 = result.vatSubtotals.find((v) => v.vatAfipCode === 5);
    expect(iva21).toBeDefined();
    expect(iva21!.baseAmount).toBe(1000);
    expect(iva21!.vatAmount).toBe(210);

    const iva105 = result.vatSubtotals.find((v) => v.vatAfipCode === 4);
    expect(iva105).toBeDefined();
    expect(iva105!.baseAmount).toBe(1000);
    expect(iva105!.vatAmount).toBe(105);

    // Regla matemática obligatoria de ARCA
    expect(result.totalAmount).toBe(
      result.netTaxedAmount + result.netUntaxedAmount + result.exemptAmount + result.vatAmount + result.specialTaxesAmount
    );
  });

  it('2. Factura A (Precios netos sin IVA)', () => {
    const result = TaxCalculator.calculate(
      [
        {
          description: 'Servidor Rack 1U',
          quantity: 2,
          unitPrice: 50000,
          vatRate: 21.0
        }
      ],
      1, // Factura A
      false // Precios netos
    );

    expect(result.netTaxedAmount).toBe(100000);
    expect(result.vatAmount).toBe(21000);
    expect(result.totalAmount).toBe(121000);
    expect(result.vatSubtotals).toHaveLength(1);
    expect(result.vatSubtotals[0]!.baseAmount).toBe(100000);
    expect(result.vatSubtotals[0]!.vatAmount).toBe(21000);
  });

  it('3. Factura C (Monotributo: no discrimina IVA)', () => {
    const result = TaxCalculator.calculate(
      [
        {
          description: 'Consultoría TI',
          quantity: 1,
          unitPrice: 75000,
          vatRate: 21.0 // Incluso si el ítem tiene IVA configurado, Factura C no lo discrimina
        }
      ],
      11, // Factura C
      true
    );

    expect(result.totalAmount).toBe(75000);
    expect(result.netTaxedAmount).toBe(75000);
    expect(result.vatAmount).toBe(0);
    expect(result.vatSubtotals).toHaveLength(0); // WSFEv1 prohíbe array de IVA en comprobantes C
  });

  it('4. Manejo de descuentos por ítem', () => {
    const result = TaxCalculator.calculate(
      [
        {
          description: 'Monitor 27 Pulgadas',
          quantity: 1,
          unitPrice: 1210,
          discount: 242, // Descuento de $242 con IVA -> total línea $968
          vatRate: 21.0
        }
      ],
      6,
      true
    );

    expect(result.totalAmount).toBe(968);
    expect(result.netTaxedAmount).toBe(800);
    expect(result.vatAmount).toBe(168);
  });
});
