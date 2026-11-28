-- Qué celular escaneó y un detalle de la compra, por movimiento. Solo agrega columnas (no toca datos).
alter table loyalty_cashiers add column if not exists ultimo_dispositivo text;
alter table loyalty_events   add column if not exists dispositivo text;
alter table loyalty_events   add column if not exists nota text;
