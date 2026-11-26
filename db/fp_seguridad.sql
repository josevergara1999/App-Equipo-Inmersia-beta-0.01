-- Fidelización v2: consentimiento y borrado de datos. Idempotente y solo agrega.
-- Correr después de db/fp_loyalty.sql.

-- Fecha en que el socio aceptó la política de privacidad (null = socio anterior a este cambio).
alter table loyalty_members add column if not exists consent_at   timestamptz;
-- Fecha de borrado de datos personales (el socio queda anonimizado, no se elimina la fila:
-- los sorteos y el libro de sellos la referencian).
alter table loyalty_members add column if not exists eliminado_at timestamptz;

-- El sorteo es opt-in: nadie participa sin haberlo pedido. Los socios existentes conservan su valor.
alter table loyalty_members alter column sorteo_ok set default false;
