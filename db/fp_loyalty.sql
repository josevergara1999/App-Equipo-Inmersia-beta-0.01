-- ============================================================================
-- FIDELIZACIÓN v2 (Family Pet's y cualquier empresa que contrate el servicio)
-- ============================================================================
-- Ejecutar en Supabase → SQL Editor DESPUÉS de loyalty.sql. Es idempotente y SOLO AGREGA:
-- no borra ni cambia tipos de nada que ya exista.
--
-- MULTIEMPRESA: todo cuelga de loyalty_programs (un programa por empresa). Las reglas
-- (meta, horas entre sellos, cupón de bienvenida, duración del QR, diseños de tarjeta) son
-- columnas del programa, no constantes del código. Sumar una empresa = una fila nueva.
--
-- SEGURIDAD: RLS activo y sin policies, igual que el resto. Todo pasa por el servidor con la
-- service_role. Las funciones fp_* son SECURITY INVOKER y solo se llaman desde el servidor;
-- se les quita el permiso de ejecución a anon y authenticated.
-- ============================================================================

-- ── Programa: reglas configurables ──────────────────────────────────────────
alter table loyalty_programs add column if not exists slug               text;
alter table loyalty_programs add column if not exists min_horas          int  not null default 12;
alter table loyalty_programs add column if not exists qr_segundos        int  not null default 120;
alter table loyalty_programs add column if not exists bienvenida_activa  boolean not null default true;
alter table loyalty_programs add column if not exists bienvenida_texto   text;
alter table loyalty_programs add column if not exists sorteo_activo      boolean not null default false;
alter table loyalty_programs add column if not exists sorteo_texto       text;
-- Diseños de tarjeta que puede elegir el cliente: [{id, nombre, img, claro}]
alter table loyalty_programs add column if not exists tarjetas           jsonb not null default '[]'::jsonb;

create unique index if not exists loyalty_programs_slug_idx on loyalty_programs (slug) where slug is not null;

-- ── Socio ───────────────────────────────────────────────────────────────────
alter table loyalty_members add column if not exists codigo6       text;         -- lo que teclea el cajero
alter table loyalty_members add column if not exists qr_clave      text;         -- clave del QR rotativo (la guarda el cel del cliente)
alter table loyalty_members add column if not exists tarjeta       text;         -- diseño elegido
alter table loyalty_members add column if not exists ultimo_sello  timestamptz;  -- para la regla de las 12 h
alter table loyalty_members add column if not exists sorteo_ok     boolean not null default true;

create unique index if not exists loyalty_members_codigo6_idx
  on loyalty_members (program_id, codigo6) where codigo6 is not null;

-- ── Cajeros ─────────────────────────────────────────────────────────────────
create table if not exists loyalty_cashiers (
  id          uuid primary key default gen_random_uuid(),
  program_id  uuid not null references loyalty_programs(id) on delete cascade,
  nombre      text not null,
  pin_salt    text not null,
  pin_hash    text not null,
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  ultimo_login timestamptz
);
create index if not exists loyalty_cashiers_program_idx on loyalty_cashiers (program_id) where activo;

-- ── Cupones (bienvenida, y los que se quieran sumar) ────────────────────────
create table if not exists loyalty_coupons (
  id          uuid primary key default gen_random_uuid(),
  member_id   uuid not null references loyalty_members(id) on delete cascade,
  tipo        text not null default 'bienvenida',
  descripcion text,
  estado      text not null default 'activo',          -- activo | usado | anulado
  created_at  timestamptz not null default now(),
  usado_at    timestamptz,
  usado_por   uuid references loyalty_cashiers(id) on delete set null,
  constraint loyalty_coupons_estado_ok check (estado in ('activo','usado','anulado'))
);
-- Un solo cupón de bienvenida por socio: es lo que impide inscribirse otra vez para repetirlo.
create unique index if not exists loyalty_coupons_bienvenida_idx
  on loyalty_coupons (member_id) where tipo = 'bienvenida';
create index if not exists loyalty_coupons_member_idx on loyalty_coupons (member_id);

-- ── Sorteo mensual ──────────────────────────────────────────────────────────
create table if not exists loyalty_draws (
  id          uuid primary key default gen_random_uuid(),
  program_id  uuid not null references loyalty_programs(id) on delete cascade,
  mes         text not null,                            -- 'YYYY-MM'
  member_id   uuid not null references loyalty_members(id) on delete restrict,
  premio      text,
  participantes int,
  entregado   boolean not null default false,
  created_at  timestamptz not null default now(),
  unique (program_id, mes)
);

-- ── Eventos: quién (cajero) hizo cada cosa ──────────────────────────────────
alter table loyalty_events add column if not exists cashier_id uuid references loyalty_cashiers(id) on delete set null;
-- 'cupon' se suma a los tipos permitidos (el check original solo conocía 4).
alter table loyalty_events drop constraint if exists loyalty_events_tipo_ok;
alter table loyalty_events add constraint loyalty_events_tipo_ok
  check (tipo in ('alta','sello','canje','ajuste','cupon'));

-- ── RLS ─────────────────────────────────────────────────────────────────────
alter table loyalty_cashiers enable row level security;
alter table loyalty_coupons  enable row level security;
alter table loyalty_draws    enable row level security;

-- ============================================================================
-- FUNCIONES ATÓMICAS
-- Sumar un sello y canjear leen y escriben el saldo: sin bloqueo, dos cajeros a la vez (o un
-- doble toque) podrían pasarse la regla de las 12 h. `for update` serializa por socio.
-- ============================================================================

-- Suma UN sello. Devuelve json: {ok, motivo?, saldo, meta, listo, faltan_horas?}
create or replace function fp_sellar(p_member uuid, p_cashier uuid, p_idem text)
returns jsonb language plpgsql as $$
declare
  m loyalty_members%rowtype;
  p loyalty_programs%rowtype;
  nuevo int;
  espera interval;
begin
  select * into m from loyalty_members where id = p_member for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'no_existe'); end if;
  select * into p from loyalty_programs where id = m.program_id;
  if not p.activo then return jsonb_build_object('ok', false, 'motivo', 'pausado'); end if;

  -- Reintento del mismo toque: devuelve lo que ya pasó, no suma otra vez.
  if p_idem is not null and exists (select 1 from loyalty_events where idem_key = p_idem) then
    return jsonb_build_object('ok', true, 'repetido', true, 'saldo', m.saldo, 'meta', p.meta, 'listo', m.saldo >= p.meta);
  end if;

  if m.ultimo_sello is not null then
    espera := (m.ultimo_sello + make_interval(hours => p.min_horas)) - now();
    if espera > interval '0' then
      return jsonb_build_object('ok', false, 'motivo', 'muy_pronto',
        'faltan_min', ceil(extract(epoch from espera) / 60)::int, 'saldo', m.saldo, 'meta', p.meta);
    end if;
  end if;

  nuevo := m.saldo + 1;
  insert into loyalty_events (member_id, tipo, cantidad, saldo_despues, operador, cashier_id, idem_key)
    values (m.id, 'sello', 1, nuevo, 'caja', p_cashier, p_idem);
  update loyalty_members
     set saldo = nuevo, ultimo_sello = now(), ultima_visita = now()
   where id = m.id;
  return jsonb_build_object('ok', true, 'repetido', false, 'saldo', nuevo, 'meta', p.meta,
                            'listo', nuevo >= p.meta, 'socio', m.nombre);
end $$;

-- Canjea el premio de sellos (descuenta `meta`).
create or replace function fp_canjear_premio(p_member uuid, p_cashier uuid, p_idem text)
returns jsonb language plpgsql as $$
declare
  m loyalty_members%rowtype;
  p loyalty_programs%rowtype;
  nuevo int;
begin
  select * into m from loyalty_members where id = p_member for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'no_existe'); end if;
  select * into p from loyalty_programs where id = m.program_id;

  if p_idem is not null and exists (select 1 from loyalty_events where idem_key = p_idem) then
    return jsonb_build_object('ok', true, 'repetido', true, 'saldo', m.saldo);
  end if;
  if m.saldo < p.meta then
    return jsonb_build_object('ok', false, 'motivo', 'faltan', 'faltan', p.meta - m.saldo, 'saldo', m.saldo);
  end if;

  nuevo := m.saldo - p.meta;
  insert into loyalty_events (member_id, tipo, cantidad, saldo_despues, operador, cashier_id, idem_key)
    values (m.id, 'canje', -p.meta, nuevo, 'caja', p_cashier, p_idem);
  update loyalty_members set saldo = nuevo, canjes = canjes + 1, ultima_visita = now() where id = m.id;
  return jsonb_build_object('ok', true, 'repetido', false, 'saldo', nuevo, 'premio', p.premio, 'socio', m.nombre);
end $$;

-- Usa el cupón de bienvenida (una sola vez por socio).
create or replace function fp_usar_cupon(p_cupon uuid, p_cashier uuid)
returns jsonb language plpgsql as $$
declare c loyalty_coupons%rowtype;
begin
  select * into c from loyalty_coupons where id = p_cupon for update;
  if not found then return jsonb_build_object('ok', false, 'motivo', 'no_existe'); end if;
  if c.estado <> 'activo' then return jsonb_build_object('ok', false, 'motivo', 'ya_' || c.estado); end if;
  update loyalty_coupons set estado = 'usado', usado_at = now(), usado_por = p_cashier where id = c.id;
  insert into loyalty_events (member_id, tipo, cantidad, saldo_despues, operador, cashier_id)
    values (c.member_id, 'cupon', 0, (select saldo from loyalty_members where id = c.member_id), 'caja', p_cashier);
  return jsonb_build_object('ok', true, 'descripcion', c.descripcion);
end $$;

-- Solo el servidor (service_role) puede llamarlas.
revoke execute on function fp_sellar(uuid, uuid, text)          from public, anon, authenticated;
revoke execute on function fp_canjear_premio(uuid, uuid, text)  from public, anon, authenticated;
revoke execute on function fp_usar_cupon(uuid, uuid)            from public, anon, authenticated;
grant  execute on function fp_sellar(uuid, uuid, text)          to service_role;
grant  execute on function fp_canjear_premio(uuid, uuid, text)  to service_role;
grant  execute on function fp_usar_cupon(uuid, uuid)            to service_role;
