-- Notificaciones push de Family Pets. Solo crea tablas y columnas nuevas; no toca datos.
create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists fp_push_subs (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references loyalty_programs(id) on delete cascade,
  member_id uuid not null references loyalty_members(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  ua text,
  created_at timestamptz not null default now()
);
create index if not exists fp_push_subs_prog on fp_push_subs(program_id);
create index if not exists fp_push_subs_mem on fp_push_subs(member_id);

create table if not exists fp_avisos (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references loyalty_programs(id) on delete cascade,
  titulo text not null,
  cuerpo text not null,
  tipo text not null default 'unico' check (tipo in ('unico','repetido')),
  hora text not null default '18:30',
  dias int[] not null default '{}',
  fecha date,
  activo boolean not null default true,
  ultimo_envio date,
  created_at timestamptz not null default now()
);

create table if not exists fp_envios (
  id uuid primary key default gen_random_uuid(),
  program_id uuid not null references loyalty_programs(id) on delete cascade,
  origen text not null,
  titulo text not null,
  cuerpo text not null,
  enviados int not null default 0,
  fallidos int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists fp_aviso_log (
  id bigserial primary key,
  member_id uuid not null references loyalty_members(id) on delete cascade,
  clave text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists fp_aviso_log_u on fp_aviso_log(member_id, clave);
create index if not exists fp_aviso_log_f on fp_aviso_log(member_id, created_at);

alter table loyalty_programs add column if not exists avisos_auto jsonb not null default '{}'::jsonb;
alter table loyalty_programs add column if not exists aviso_tope_sem int not null default 3;

alter table fp_push_subs enable row level security;
alter table fp_avisos enable row level security;
alter table fp_envios enable row level security;
alter table fp_aviso_log enable row level security;
