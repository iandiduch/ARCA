import { resolveItemVat, requiresVatBreakdown } from '../../../core/fiscal/tax-catalogs.js';
import { ValidationError } from '../../../core/errors/app-error.js';

export interface InvoiceItemInput {
  productId?: string | undefined;
  internalCode?: string | undefined;
  description: string;
  quantity: number;
  unitPrice: number;
  discount?: number | undefined;
  vatRate?: number | undefined; // default 21 (o la alícuota del vatAfipCode)
  vatAfipCode?: number | undefined;
}

export interface CalculatedItem {
  productId?: string | undefined;
  internalCode?: string | undefined;
  description: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  vatRate: number;
  vatAfipCode: number;
  netSubtotal: number;
  vatSubtotal: number;
  totalSubtotal: number;
}

export interface VatSubtotalGroup {
  vatAfipCode: number;
  vatRate: number;
  baseAmount: number;
  vatAmount: number;
}

export interface TaxCalculationResult {
  items: CalculatedItem[];
  vatSubtotals: VatSubtotalGroup[];
  totalAmount: number;
  netTaxedAmount: number;
  netUntaxedAmount: number;
  exemptAmount: number;
  vatAmount: number;
  specialTaxesAmount: number;
}

export class TaxCalculator {
  /**
   * Calcula importes netos, IVA por ítem y totales consolidados para WSFEv1
   * @param items Lista de ítems
   * @param voucherType Código AFIP de comprobante (1=Factura A, 6=Factura B, 11=Factura C, etc.)
   * @param pricesIncludeVat Indica si unitPrice ya incluye el IVA (típico en POS minorista)
   */
  public static calculate(
    items: InvoiceItemInput[],
    voucherType: number,
    pricesIncludeVat: boolean = true
  ): TaxCalculationResult {
    const isVatApplicable = requiresVatBreakdown(voucherType);
    const calculatedItems: CalculatedItem[] = [];
    const vatGroupsMap = new Map<number, { vatAfipCode: number; vatRate: number; baseAmount: number; vatAmount: number }>();

    let totalAmount = 0;
    let netTaxedAmount = 0;
    let netUntaxedAmount = 0;
    let exemptAmount = 0;
    let totalVatAmount = 0;

    for (const item of items) {
      if (item.unitPrice < 0) {
        throw new ValidationError(`El precio unitario no puede ser negativo en "${item.description}"`);
      }
      if (item.quantity <= 0) {
        throw new ValidationError(`La cantidad vendida debe ser mayor a cero en "${item.description}"`);
      }
      if (item.discount !== undefined && item.discount < 0) {
        throw new ValidationError(`El descuento no puede ser negativo en "${item.description}"`);
      }

      const quantity = Math.max(0.0001, item.quantity);
      const unitPrice = Math.max(0, item.unitPrice);
      const discount = Math.max(0, item.discount ?? 0);
      const lineGross = this.round2(quantity * unitPrice);

      if (discount > lineGross + 0.0001) {
        throw new ValidationError(
          `El descuento ($${discount}) no puede superar el importe del ítem ($${lineGross}) en "${item.description}"`
        );
      }

      const { rate: vatRate, afipCode: vatAfipCode } = resolveItemVat(item.vatRate, item.vatAfipCode);

      let netSubtotal: number;
      let vatSubtotal: number;
      let totalSubtotal: number;

      if (!isVatApplicable) {
        // Factura C (Monotributo): no discrimina IVA
        totalSubtotal = this.round2(quantity * unitPrice - discount);
        netSubtotal = totalSubtotal;
        vatSubtotal = 0;
      } else if (pricesIncludeVat) {
        // Precio con IVA incluido (POS minorista / retail)
        totalSubtotal = this.round2(quantity * unitPrice - discount);
        if (vatRate > 0) {
          netSubtotal = this.round2(totalSubtotal / (1 + vatRate / 100));
          vatSubtotal = this.round2(totalSubtotal - netSubtotal);
        } else {
          netSubtotal = totalSubtotal;
          vatSubtotal = 0;
        }
      } else {
        // Precio neto más IVA (mayorista / Factura A)
        netSubtotal = this.round2(quantity * unitPrice - discount);
        vatSubtotal = vatRate > 0 ? this.round2(netSubtotal * (vatRate / 100)) : 0;
        totalSubtotal = this.round2(netSubtotal + vatSubtotal);
      }

      if (totalSubtotal < 0) {
        throw new ValidationError(
          `El subtotal del ítem "${item.description}" no puede ser negativo ($${totalSubtotal})`
        );
      }

      calculatedItems.push({
        productId: item.productId,
        internalCode: item.internalCode,
        description: item.description,
        quantity,
        unitPrice,
        discount,
        vatRate,
        vatAfipCode,
        netSubtotal,
        vatSubtotal,
        totalSubtotal
      });

      totalAmount = this.round2(totalAmount + totalSubtotal);

      if (!isVatApplicable) {
        netTaxedAmount = this.round2(netTaxedAmount + netSubtotal);
      } else if (vatAfipCode === 1) {
        // No Gravado
        netUntaxedAmount = this.round2(netUntaxedAmount + netSubtotal);
      } else if (vatAfipCode === 2) {
        // Exento
        exemptAmount = this.round2(exemptAmount + netSubtotal);
      } else if (vatRate > 0) {
        // Gravado (21%, 10.5%, 27%, etc.)
        netTaxedAmount = this.round2(netTaxedAmount + netSubtotal);
        totalVatAmount = this.round2(totalVatAmount + vatSubtotal);

        const existing = vatGroupsMap.get(vatAfipCode);
        if (existing) {
          existing.baseAmount = this.round2(existing.baseAmount + netSubtotal);
          existing.vatAmount = this.round2(existing.vatAmount + vatSubtotal);
        } else {
          vatGroupsMap.set(vatAfipCode, {
            vatAfipCode,
            vatRate,
            baseAmount: netSubtotal,
            vatAmount: vatSubtotal
          });
        }
      } else {
        // Tasa 0%
        netTaxedAmount = this.round2(netTaxedAmount + netSubtotal);
        const existing = vatGroupsMap.get(vatAfipCode);
        if (existing) {
          existing.baseAmount = this.round2(existing.baseAmount + netSubtotal);
        } else {
          vatGroupsMap.set(vatAfipCode, {
            vatAfipCode,
            vatRate: 0,
            baseAmount: netSubtotal,
            vatAmount: 0
          });
        }
      }
    }

    // Regla de consistencia ARCA WSFEv1: ImpTotal = ImpTotConc + ImpNeto + ImpOpEx + ImpTrib + ImpIVA
    const expectedSum = this.round2(netTaxedAmount + netUntaxedAmount + exemptAmount + totalVatAmount);
    if (Math.abs(totalAmount - expectedSum) > 0.001) {
      // Ajuste de centavo por redondeo si difiere por 1 centavo
      totalAmount = expectedSum;
    }

    if (totalAmount <= 0) {
      throw new ValidationError(
        `El importe total del comprobante debe ser mayor a cero ($${totalAmount.toFixed(2)})`
      );
    }

    return {
      items: calculatedItems,
      vatSubtotals: Array.from(vatGroupsMap.values()),
      totalAmount,
      netTaxedAmount,
      netUntaxedAmount,
      exemptAmount,
      vatAmount: totalVatAmount,
      specialTaxesAmount: 0
    };
  }

  private static round2(val: number): number {
    return Math.round((val + Number.EPSILON) * 100) / 100;
  }
}
