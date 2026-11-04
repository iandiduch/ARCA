-- Custom SQL migration file, put your code below! --
-- Elimina el Token y Sign de WSAA que quedaron guardados dentro del XML de FECAESolicitar
-- (y de las respuestas cacheadas por idempotencia, que incluyen la factura completa).
UPDATE "invoices"
SET "afip_xml_request" = regexp_replace(
  regexp_replace("afip_xml_request", '<fev:Token>[^<]*</fev:Token>', '<fev:Token>[REDACTED]</fev:Token>', 'g'),
  '<fev:Sign>[^<]*</fev:Sign>', '<fev:Sign>[REDACTED]</fev:Sign>', 'g'
)
WHERE "afip_xml_request" LIKE '%<fev:Token>%';
--> statement-breakpoint
UPDATE "idempotency_keys"
SET "response_body" = regexp_replace(
  regexp_replace("response_body"::text, '<fev:Token>[^<]*</fev:Token>', '<fev:Token>[REDACTED]</fev:Token>', 'g'),
  '<fev:Sign>[^<]*</fev:Sign>', '<fev:Sign>[REDACTED]</fev:Sign>', 'g'
)::jsonb
WHERE "response_body"::text LIKE '%<fev:Token>%';
