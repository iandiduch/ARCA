ALTER TABLE "points_of_sale" ADD COLUMN "fantasy_name" text;--> statement-breakpoint
ALTER TABLE "points_of_sale" ADD COLUMN "commercial_address" text;--> statement-breakpoint
-- Condición IVA del emisor al vocabulario canónico (el POS guardaba 'monotributo' / 'responsable_inscripto')
UPDATE "fiscal_identities" SET "tax_condition" = 'RESPONSABLE_MONOTRIBUTO'
  WHERE lower(trim("tax_condition")) IN ('monotributo', 'responsable_monotributo') AND "tax_condition" <> 'RESPONSABLE_MONOTRIBUTO';--> statement-breakpoint
UPDATE "fiscal_identities" SET "tax_condition" = 'IVA_RESPONSABLE_INSCRIPTO'
  WHERE lower(trim("tax_condition")) IN ('responsable_inscripto', 'iva_responsable_inscripto') AND "tax_condition" <> 'IVA_RESPONSABLE_INSCRIPTO';--> statement-breakpoint
UPDATE "fiscal_identities" SET "tax_condition" = 'IVA_EXENTO'
  WHERE lower(trim("tax_condition")) IN ('exento', 'iva_exento') AND "tax_condition" <> 'IVA_EXENTO';
