import { CustomerRepository, type ListCustomersOptions } from '../infrastructure/customer-repository.js';
import {
  cleanDocumentNumber,
  isValidCuit,
  isValidDni,
  DOCUMENT_TYPES,
  FISCAL_CONDITIONS
} from '../../../core/fiscal/cuit-validator.js';
import { ValidationError, ConflictError, NotFoundError } from '../../../core/errors/app-error.js';
import { AuditService } from '../../audit/application/audit-service.js';
import type { Customer } from '../../../infrastructure/database/schema/customers.js';

export interface CreateCustomerInput {
  name: string;
  documentType?: string | undefined;
  documentNumber: string;
  fiscalCondition?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  address?: string | undefined;
}

export interface UpdateCustomerInput {
  name?: string | undefined;
  documentType?: string | undefined;
  documentNumber?: string | undefined;
  fiscalCondition?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  address?: string | undefined;
  active?: boolean | undefined;
}

export class CustomerService {
  constructor(private readonly customerRepo = new CustomerRepository()) {}

  public async createCustomer(tenantId: string, input: CreateCustomerInput, creatorId?: string): Promise<Customer> {
    const docType = input.documentType?.toUpperCase() ?? 'DNI';
    const docTypeMapping = DOCUMENT_TYPES[docType] ?? DOCUMENT_TYPES.OTRO!;
    const cleanDoc = cleanDocumentNumber(input.documentNumber);

    // Validación según tipo de documento
    if (docType === 'CUIT' || docType === 'CUIL') {
      if (!isValidCuit(cleanDoc)) {
        throw new ValidationError(`El ${docType} "${input.documentNumber}" no es válido según algoritmo Módulo 11 de ARCA`);
      }
    } else if (docType === 'DNI') {
      if (!isValidDni(cleanDoc)) {
        throw new ValidationError(`El DNI "${input.documentNumber}" debe tener entre 6 y 8 dígitos numéricos`);
      }
    }

    const fiscalCondition = input.fiscalCondition?.toUpperCase() ?? 'CONSUMIDOR_FINAL';
    const fiscalMapping = FISCAL_CONDITIONS[fiscalCondition] ?? FISCAL_CONDITIONS.CONSUMIDOR_FINAL!;

    // Control de duplicados activos en el mismo comercio
    const existing = await this.customerRepo.findByDocument(tenantId, docType, cleanDoc);
    if (existing && existing.active) {
      throw new ConflictError(
        `Ya existe un cliente activo registrado con ${docType} ${cleanDoc} ("${existing.name}")`
      );
    }

    const customer = await this.customerRepo.create({
      tenantId,
      name: input.name.trim(),
      documentType: docType,
      documentTypeCode: docTypeMapping.afipCode,
      documentNumber: cleanDoc,
      fiscalCondition,
      fiscalConditionCode: fiscalMapping.afipCode,
      email: input.email?.trim() || null,
      phone: input.phone?.trim() || null,
      address: input.address?.trim() || null,
      active: true
    });

    await AuditService.record({
      tenantId,
      userId: creatorId,
      action: 'CUSTOMER_CREATED',
      entityType: 'customer',
      entityId: customer.id,
      payload: { name: customer.name, documentType: customer.documentType, documentNumber: customer.documentNumber }
    });

    return customer;
  }

  public async getCustomerById(tenantId: string, id: string): Promise<Customer> {
    const customer = await this.customerRepo.findById(tenantId, id);
    if (!customer) {
      throw new NotFoundError(`Cliente con ID "${id}" no encontrado`);
    }
    return customer;
  }

  public async listCustomers(tenantId: string, options?: ListCustomersOptions): Promise<Customer[]> {
    return this.customerRepo.list(tenantId, options);
  }

  public async updateCustomer(
    tenantId: string,
    id: string,
    input: UpdateCustomerInput,
    updaterId?: string
  ): Promise<Customer> {
    await this.getCustomerById(tenantId, id);

    const updateData: Parameters<CustomerRepository['update']>[2] = {};

    if (input.name !== undefined) updateData.name = input.name.trim();
    if (input.email !== undefined) updateData.email = input.email ? input.email.trim() : null;
    if (input.phone !== undefined) updateData.phone = input.phone ? input.phone.trim() : null;
    if (input.address !== undefined) updateData.address = input.address ? input.address.trim() : null;
    if (input.active !== undefined) updateData.active = input.active;

    if (input.documentType || input.documentNumber) {
      const docType = (input.documentType ?? 'DNI').toUpperCase();
      const docTypeMapping = DOCUMENT_TYPES[docType] ?? DOCUMENT_TYPES.OTRO!;
      const cleanDoc = input.documentNumber ? cleanDocumentNumber(input.documentNumber) : undefined;

      if (cleanDoc) {
        if (docType === 'CUIT' || docType === 'CUIL') {
          if (!isValidCuit(cleanDoc)) {
            throw new ValidationError(`${docType} inválido según algoritmo Módulo 11`);
          }
        } else if (docType === 'DNI') {
          if (!isValidDni(cleanDoc)) {
            throw new ValidationError('El DNI debe tener entre 6 y 8 dígitos');
          }
        }
        updateData.documentNumber = cleanDoc;
      }

      updateData.documentType = docType;
      updateData.documentTypeCode = docTypeMapping.afipCode;
    }

    if (input.fiscalCondition !== undefined) {
      const cond = input.fiscalCondition.toUpperCase();
      const mapping = FISCAL_CONDITIONS[cond] ?? FISCAL_CONDITIONS.CONSUMIDOR_FINAL!;
      updateData.fiscalCondition = cond;
      updateData.fiscalConditionCode = mapping.afipCode;
    }

    const updated = await this.customerRepo.update(tenantId, id, updateData);
    if (!updated) {
      throw new NotFoundError('Fallo al actualizar el cliente');
    }

    await AuditService.record({
      tenantId,
      userId: updaterId,
      action: 'CUSTOMER_UPDATED',
      entityType: 'customer',
      entityId: id,
      payload: updateData
    });

    return updated;
  }

  public async archiveCustomer(tenantId: string, id: string, archiverId?: string): Promise<void> {
    await this.getCustomerById(tenantId, id);
    await this.customerRepo.archive(tenantId, id);

    await AuditService.record({
      tenantId,
      userId: archiverId,
      action: 'CUSTOMER_ARCHIVED',
      entityType: 'customer',
      entityId: id
    });
  }
}
