-- Cumpleaños: fecha de nacimiento del socio y beneficio configurable por programa. Solo agrega columnas.
alter table loyalty_members  add column if not exists nacimiento    date;
alter table loyalty_programs add column if not exists cumple_activo  boolean not null default true;
alter table loyalty_programs add column if not exists cumple_texto   text;
