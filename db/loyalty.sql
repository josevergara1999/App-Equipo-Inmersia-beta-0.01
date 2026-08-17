-- ============================================================================
-- FIDELIZACIÓN — tablas reales (no `app_data`)
-- ============================================================================
-- Ejecutar en Supabase → SQL Editor. Es idempotente: se puede correr de nuevo.
--
-- POR QUÉ NO VA EN `app_data`
-- La app guarda todo en `app_data` (clave-valor, una fila por clave) y el frontend hace
-- `DB.loadAll()` trayendo TODO a memoria en cada carga. Un programa de fidelización tiene un
-- registro por cliente final del cliente —miles por empresa— y crece para siempre. Meterlo ahí
-- haría que cada persona que abre la app se descargue la base de socios completa de todas las
-- empresas. Es la misma trampa ya documentada en CLAUDE.md con los videos en base64.
--
-- SEGURIDAD
-- RLS activo y SIN policies para el rol anónimo, igual que `app_data` desde el 10-ago-2026.
-- El navegador nunca habla con estas tablas: todo pasa por el servidor con la service_role.
-- ============================================================================


-- ── Programas ───────────────────────────────────────────────────────────────
-- Un programa por empresa (o varios, si la empresa quiere más de una tarjeta).
create table if not exists loyalty_programs (
  id               uuid primary key default gen_random_uuid(),

  -- Id de la empresa en `companies` (que vive en app_data, por eso es texto y no FK).
  -- Es el puente entre el mundo clave-valor y estas tablas.
  company_id       text        not null,

  nombre           text        not null,
  tipo             text        not null default 'sellos',   -- sellos | puntos | niveles
  meta             int         not null default 10,         -- cuántos sellos para el premio
  premio           text        not null,
  activo           boolean     not null default true,

  -- Diseño de la tarjeta (se usa igual en el pase de Wallet y en la versión web).
  -- Los nombres siguen a los de Apple —backgroundColor / foregroundColor / labelColor /
  -- logoText / strip— para que firmar el .pkpass sea un mapeo directo y no una traducción.
  color_fondo      text        not null default '#05060B',
  color_texto      text        not null default '#FFFFFF',
  color_etiqueta   text        not null default '#8E93A6',
  logo_url         text,
  logo_text        text,

  -- La banda ancha del pase (strip.png, 320×123 pt). En un storeCard es la única imagen grande
  -- que Apple admite, así que es el único lugar donde se puede diseñar de verdad. `strip_url`
  -- es la imagen subida o generada; `strip_estilo` es el dibujo por colores que la reemplaza
  -- cuando no hay archivo ({preset, c1, c2}), y que el navegador pinta en un canvas.
  strip_url        text,
  strip_estilo     jsonb,

  sello_icono      text        not null default 'circulo',
  vigencia_dias    int,

  -- Wallet. Se llenan cuando exista la cuenta de Apple / el emisor de Google.
  -- Nulos hasta entonces: el sistema funciona completo sin ellos.
  apple_pass_type  text,
  google_class_id  text,

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  constraint loyalty_programs_tipo_ok check (tipo in ('sellos','puntos','niveles')),
  constraint loyalty_programs_meta_ok check (meta > 0)
);

create index if not exists loyalty_programs_company_idx
  on loyalty_programs (company_id) where activo;

-- `create table if not exists` no toca una tabla que ya existe: en una base creada antes de que
-- existiera el diseñador, el bloque de arriba se salta entero y las columnas de diseño nunca
-- aparecen. Esto las agrega sin romper nada y deja el archivo re-ejecutable, que es el punto.
alter table loyalty_programs add column if not exists color_etiqueta text not null default '#8E93A6';
alter table loyalty_programs add column if not exists logo_text      text;
alter table loyalty_programs add column if not exists strip_url      text;
alter table loyalty_programs add column if not exists strip_estilo   jsonb;
alter table loyalty_programs add column if not exists sello_icono    text not null default 'circulo';
alter table loyalty_programs add column if not exists vigencia_dias  int;


-- ── Socios ──────────────────────────────────────────────────────────────────
-- El cliente final del cliente. Uno por persona y por programa.
create table if not exists loyalty_members (
  id               uuid primary key default gen_random_uuid(),
  program_id       uuid        not null references loyalty_programs(id) on delete cascade,

  -- Lo que viaja en el QR de la tarjeta. Debe ser CORTO (para que el QR sea legible en
  -- pantalla y en papel) y NO ADIVINABLE: si fuera correlativo, cualquiera se regala sellos
  -- probando códigos. Lo genera el servidor con bytes aleatorios, no con un contador.
  codigo           text        not null unique,

  nombre           text,
  email            text,
  telefono         text,

  -- Estado actual. Es un CACHÉ de loyalty_events: la verdad está en el ledger.
  saldo            int         not null default 0,
  canjes           int         not null default 0,

  -- Wallet (nulos hasta que se emita el pase)
  apple_serial     text unique,
  apple_auth_token text,        -- lo exige Apple para autenticar las llamadas del dispositivo
  google_object_id text unique,

  created_at       timestamptz not null default now(),
  ultima_visita    timestamptz,

  constraint loyalty_members_saldo_ok check (saldo >= 0)
);

create index if not exists loyalty_members_program_idx on loyalty_members (program_id);
create index if not exists loyalty_members_visita_idx  on loyalty_members (program_id, ultima_visita desc);


-- ── Eventos ─────────────────────────────────────────────────────────────────
-- El libro mayor. Cada sello, canje y ajuste queda escrito acá.
--
-- POR QUÉ UN LEDGER Y NO SOLO EL CONTADOR EN `loyalty_members`:
--   1. Disputas. "Me faltó un sello" se responde mirando, no discutiendo.
--   2. Fraude. Un local que se auto-regala sellos se ve en el patrón horario.
--   3. Es el producto. Toda la analítica que se le vende a la agencia —quién vuelve, cada
--      cuánto, quién dejó de venir— sale de acá. Un contador tira esa información a la basura.
create table if not exists loyalty_events (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid        not null references loyalty_members(id) on delete cascade,

  tipo         text        not null,          -- alta | sello | canje | ajuste
  cantidad     int         not null default 1,
  saldo_despues int        not null,          -- foto del saldo tras aplicar el evento

  local_id     text,                          -- qué sucursal
  operador     text,                          -- quién escaneó (email o id del usuario)

  -- Anti doble-sello. El escáner manda una clave única por lectura; si el dedo tocó dos veces
  -- o la red reintentó, el segundo insert choca contra el índice y no suma nada.
  -- En un mesón con cola esto pasa, no es hipotético.
  idem_key     text,

  created_at   timestamptz not null default now(),

  constraint loyalty_events_tipo_ok check (tipo in ('alta','sello','canje','ajuste'))
);

create unique index if not exists loyalty_events_idem_idx
  on loyalty_events (idem_key) where idem_key is not null;
create index if not exists loyalty_events_member_idx on loyalty_events (member_id, created_at desc);
create index if not exists loyalty_events_fecha_idx  on loyalty_events (created_at desc);


-- ── Dispositivos Apple ──────────────────────────────────────────────────────
-- Sin uso hasta que exista la cuenta de Apple Developer. Se define ahora para no tener que
-- migrar después: cuando un iPhone guarda un pase, Apple registra el dispositivo acá y a ese
-- push_token se le manda el aviso silencioso que dispara la actualización de la tarjeta.
create table if not exists loyalty_apple_devices (
  id             uuid primary key default gen_random_uuid(),
  member_id      uuid        not null references loyalty_members(id) on delete cascade,
  device_lib_id  text        not null,
  push_token     text        not null,
  pass_type_id   text        not null,
  serial         text        not null,
  created_at     timestamptz not null default now(),
  unique (device_lib_id, serial)
);

create index if not exists loyalty_apple_devices_member_idx on loyalty_apple_devices (member_id);


-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Sin policies a propósito: con RLS activo y sin policies, el rol anónimo no lee ni escribe
-- nada. La service_role (solo en el servidor) se salta RLS. Si alguna vez se crea una policy
-- para `anon`, se reabre exactamente el agujero que se cerró en agosto de 2026.
alter table loyalty_programs      enable row level security;
alter table loyalty_members       enable row level security;
alter table loyalty_events        enable row level security;
alter table loyalty_apple_devices enable row level security;
