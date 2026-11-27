-- ============================================================================
-- FIDELIZACIÓN v2 en Supabase (Edge Function `fp`): tablas que antes vivían en Render.
-- Idempotente y SOLO AGREGA. Correr DESPUÉS de fp_loyalty.sql y fp_seguridad.sql.
--
--  · fp_admins : administradores del programa (login propio, ya no la sesión de Inmersia).
--  · fp_rl     : intentos recientes, para los límites por IP y el tope de PIN por programa.
--                Antes el contador vivía en memoria y se perdía al reiniciar Render.
-- RLS activo y sin policies; las funciones solo las ejecuta service_role.
-- ============================================================================

create table if not exists fp_admins (
  id          uuid primary key default gen_random_uuid(),
  program_id  uuid not null references loyalty_programs(id) on delete cascade,
  email       text not null,
  nombre      text,
  pass_salt   text not null,
  pass_hash   text not null,
  activo      boolean not null default true,
  created_at  timestamptz not null default now(),
  ultimo_login timestamptz
);
create unique index if not exists fp_admins_email_idx on fp_admins (lower(email));
alter table fp_admins enable row level security;

create table if not exists fp_rl (
  clave text        not null,
  t     timestamptz not null default now()
);
create index if not exists fp_rl_clave_t_idx on fp_rl (clave, t);
alter table fp_rl enable row level security;

-- Anota un intento y dice si SIGUE dentro del tope. Atómico por clave (advisory lock):
-- 40 intentos en paralelo no pueden colarse todos entre el "contar" y el "anotar".
create or replace function fp_rl_hit(p_clave text, p_max int, p_ventana_seg int)
returns boolean language plpgsql as $$
declare n int;
begin
  perform pg_advisory_xact_lock(hashtext('fp_rl:' || p_clave));
  delete from fp_rl where clave = p_clave and t < now() - make_interval(secs => p_ventana_seg);
  select count(*) into n from fp_rl where clave = p_clave;
  if n >= p_max then return false; end if;
  insert into fp_rl (clave) values (p_clave);
  return true;
end $$;

create or replace function fp_rl_clear(p_clave text)
returns void language sql as $$ delete from fp_rl where clave = p_clave $$;

-- Limpieza de lo viejo (se llama de vez en cuando desde la función).
create or replace function fp_rl_limpiar()
returns void language sql as $$ delete from fp_rl where t < now() - interval '1 day' $$;

revoke execute on function fp_rl_hit(text, int, int) from public, anon, authenticated;
revoke execute on function fp_rl_clear(text)         from public, anon, authenticated;
revoke execute on function fp_rl_limpiar()           from public, anon, authenticated;
grant  execute on function fp_rl_hit(text, int, int) to service_role;
grant  execute on function fp_rl_clear(text)         to service_role;
grant  execute on function fp_rl_limpiar()           to service_role;
