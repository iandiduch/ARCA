import { ProductRepository, type ListProductsOptions } from '../infrastructure/product-repository.js';
import { resolveIvaCode, UNIT_MEASURES } from '../../../core/fiscal/tax-catalogs.js';
import { ValidationError, ConflictError, NotFoundError } from '../../../core/errors/app-error.js';
import { AuditService } from '../../audit/application/audit-service.js';
import type { Product } from '../../../infrastructure/database/schema/products.js';

export interface CreateProductInput {
  name: string;
  internalCode?: string | undefined;
  barcode?: string | undefined;
  description?: string | undefined;
  conceptType?: number | undefined;
  unitMeasure?: string | undefined;
  costPrice?: number | undefined;
  salePrice: number;
  ivaRate?: number | undefined;
  metadata?: unknown | undefined;
}

export interface UpdateProductInput {
  name?: string | undefined;
  internalCode?: string | undefined;
  barcode?: string | undefined;
  description?: string | undefined;
  conceptType?: number | undefined;
  unitMeasure?: string | undefined;
  costPrice?: number | undefined;
  salePrice?: number | undefined;
  ivaRate?: number | undefined;
  active?: boolean | undefined;
  metadata?: unknown | undefined;
}

export interface ImportCsvResult {
  totalProcessed: number;
  created: number;
  updated: number;
  errors: Array<{ line: number; error: string }>;
}

export class ProductService {
  constructor(private readonly productRepo = new ProductRepository()) {}

  public async createProduct(tenantId: string, input: CreateProductInput, creatorId?: string): Promise<Product> {
    if (input.salePrice < 0) {
      throw new ValidationError('El precio de venta no puede ser negativo');
    }
    if (input.costPrice !== undefined && input.costPrice < 0) {
      throw new ValidationError('El precio de costo no puede ser negativo');
    }

    const cleanInternal = input.internalCode?.trim() || null;
    const cleanBarcode = input.barcode?.trim() || null;

    // Control de duplicados en el mismo comercio
    if (cleanInternal) {
      const existing = await this.productRepo.findByInternalCode(tenantId, cleanInternal);
      if (existing && existing.active) {
        throw new ConflictError(`Ya existe un producto activo con el código interno "${cleanInternal}"`);
      }
    }

    const ivaDefinition = resolveIvaCode(input.ivaRate ?? 21.0);
    const unitMeasureKey = (input.unitMeasure ?? 'UNIDAD').toUpperCase();
    const unitMeasureMapping = UNIT_MEASURES[unitMeasureKey] ?? UNIT_MEASURES.UNIDAD!;

    const product = await this.productRepo.create({
      tenantId,
      internalCode: cleanInternal,
      barcode: cleanBarcode,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      conceptType: input.conceptType ?? 1,
      unitMeasure: unitMeasureKey,
      unitMeasureCode: unitMeasureMapping.code,
      costPrice: (input.costPrice ?? 0).toFixed(2),
      salePrice: input.salePrice.toFixed(2),
      ivaRate: ivaDefinition.rate.toFixed(2),
      ivaCode: ivaDefinition.afipCode,
      active: true,
      metadata: input.metadata ?? null
    });

    await AuditService.record({
      tenantId,
      userId: creatorId,
      action: 'PRODUCT_CREATED',
      entityType: 'product',
      entityId: product.id,
      payload: { name: product.name, internalCode: product.internalCode, salePrice: product.salePrice }
    });

    return product;
  }

  public async getProductById(tenantId: string, id: string): Promise<Product> {
    const product = await this.productRepo.findById(tenantId, id);
    if (!product) {
      throw new NotFoundError(`Producto con ID "${id}" no encontrado`);
    }
    return product;
  }

  public async listProducts(tenantId: string, options?: ListProductsOptions): Promise<Product[]> {
    return this.productRepo.list(tenantId, options);
  }

  public async updateProduct(
    tenantId: string,
    id: string,
    input: UpdateProductInput,
    updaterId?: string
  ): Promise<Product> {
    await this.getProductById(tenantId, id);

    const updateData: Parameters<ProductRepository['update']>[2] = {};

    if (input.name !== undefined) updateData.name = input.name.trim();
    if (input.description !== undefined) updateData.description = input.description ? input.description.trim() : null;
    if (input.barcode !== undefined) updateData.barcode = input.barcode ? input.barcode.trim() : null;
    if (input.conceptType !== undefined) updateData.conceptType = input.conceptType;
    if (input.active !== undefined) updateData.active = input.active;
    if (input.metadata !== undefined) updateData.metadata = input.metadata;

    if (input.costPrice !== undefined) {
      if (input.costPrice < 0) throw new ValidationError('El precio de costo no puede ser negativo');
      updateData.costPrice = input.costPrice.toFixed(2);
    }

    if (input.salePrice !== undefined) {
      if (input.salePrice < 0) throw new ValidationError('El precio de venta no puede ser negativo');
      updateData.salePrice = input.salePrice.toFixed(2);
    }

    if (input.internalCode !== undefined) {
      const cleanInternal = input.internalCode ? input.internalCode.trim() : null;
      if (cleanInternal) {
        const existing = await this.productRepo.findByInternalCode(tenantId, cleanInternal);
        if (existing && existing.id !== id && existing.active) {
          throw new ConflictError(`El código interno "${cleanInternal}" ya está en uso por otro producto`);
        }
      }
      updateData.internalCode = cleanInternal;
    }

    if (input.ivaRate !== undefined) {
      const iva = resolveIvaCode(input.ivaRate);
      updateData.ivaRate = iva.rate.toFixed(2);
      updateData.ivaCode = iva.afipCode;
    }

    if (input.unitMeasure !== undefined) {
      const unitKey = input.unitMeasure.toUpperCase();
      const unitMapping = UNIT_MEASURES[unitKey] ?? UNIT_MEASURES.UNIDAD!;
      updateData.unitMeasure = unitKey;
      updateData.unitMeasureCode = unitMapping.code;
    }

    const updated = await this.productRepo.update(tenantId, id, updateData);
    if (!updated) {
      throw new NotFoundError('Fallo al actualizar el producto');
    }

    await AuditService.record({
      tenantId,
      userId: updaterId,
      action: 'PRODUCT_UPDATED',
      entityType: 'product',
      entityId: id,
      payload: updateData
    });

    return updated;
  }

  public async archiveProduct(tenantId: string, id: string, archiverId?: string): Promise<void> {
    await this.getProductById(tenantId, id);
    await this.productRepo.archive(tenantId, id);

    await AuditService.record({
      tenantId,
      userId: archiverId,
      action: 'PRODUCT_ARCHIVED',
      entityType: 'product',
      entityId: id
    });
  }

  public async exportToCsv(tenantId: string): Promise<string> {
    const list = await this.productRepo.list(tenantId, { limit: 10000 });
    const headers = [
      'codigo_interno',
      'codigo_barras',
      'nombre',
      'descripcion',
      'precio_costo',
      'precio_venta',
      'alicuota_iva',
      'unidad_medida',
      'activo'
    ];

    const lines = [headers.join(',')];

    for (const p of list) {
      const row = [
        `"${p.internalCode || ''}"`,
        `"${p.barcode || ''}"`,
        `"${p.name.replace(/"/g, '""')}"`,
        `"${(p.description || '').replace(/"/g, '""')}"`,
        p.costPrice,
        p.salePrice,
        p.ivaRate,
        p.unitMeasure,
        p.active ? '1' : '0'
      ];
      lines.push(row.join(','));
    }

    return lines.join('\n');
  }

  public async importFromCsv(tenantId: string, csvContent: string, importerId?: string): Promise<ImportCsvResult> {
    const lines = csvContent
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    if (lines.length < 2) {
      throw new ValidationError('El archivo CSV debe contener encabezados y al menos una fila de datos');
    }

    const result: ImportCsvResult = {
      totalProcessed: 0,
      created: 0,
      updated: 0,
      errors: []
    };

    // Omitir cabecera
    for (let i = 1; i < lines.length; i++) {
      result.totalProcessed++;
      const line = lines[i]!;

      // Parseador simple de CSV respetando comillas
      const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map((c) => c.replace(/^"|"$/g, '').trim());

      if (cols.length < 3) {
        result.errors.push({ line: i + 1, error: 'Faltan columnas requeridas (mínimo: codigo_interno, nombre, precio_venta)' });
        continue;
      }

      const internalCode = cols[0] || undefined;
      const barcode = cols[1] || undefined;
      const name = cols[2] || '';
      const description = cols[3] || undefined;
      const costPrice = cols[4] ? Number(cols[4]) : 0;
      const salePrice = cols[5] ? Number(cols[5]) : (cols[3] ? Number(cols[3]) : 0);
      const ivaRate = cols[6] ? Number(cols[6]) : 21.0;
      const unitMeasure = cols[7] || 'UNIDAD';

      if (!name || isNaN(salePrice) || salePrice < 0) {
        result.errors.push({ line: i + 1, error: 'Nombre inválido o precio de venta no numérico' });
        continue;
      }

      try {
        if (internalCode) {
          const existing = await this.productRepo.findByInternalCode(tenantId, internalCode);
          if (existing) {
            await this.updateProduct(tenantId, existing.id, {
              name,
              barcode,
              description,
              costPrice,
              salePrice,
              ivaRate,
              unitMeasure
            });
            result.updated++;
            continue;
          }
        }

        await this.createProduct(tenantId, {
          internalCode,
          barcode,
          name,
          description,
          costPrice,
          salePrice,
          ivaRate,
          unitMeasure
        });
        result.created++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error desconocido';
        result.errors.push({ line: i + 1, error: msg });
      }
    }

    await AuditService.record({
      tenantId,
      userId: importerId,
      action: 'PRODUCTS_IMPORTED',
      entityType: 'product',
      payload: { created: result.created, updated: result.updated, errorCount: result.errors.length }
    });

    return result;
  }
}
