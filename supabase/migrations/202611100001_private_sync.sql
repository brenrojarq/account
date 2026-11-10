-- KONTEN private synchronization, schema version 1.
-- Run once in the SQL editor of your own Supabase project (as its administrator).
-- The browser uses only a publishable key plus the signed-in user's JWT.
begin;

create table if not exists public.konten_records (
  user_id uuid not null references auth.users (id) on delete cascade,
  entity_type text not null check (entity_type in ('income', 'expense', 'goal', 'budget', 'preferences')),
  entity_id text not null check (length(btrim(entity_id)) between 1 and 200),
  payload jsonb,
  revision integer not null check (revision > 0),
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (user_id, entity_type, entity_id),
  constraint konten_records_payload_check check (
    (deleted and payload is null)
    or (not deleted and payload is not null and jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536)
  )
);

-- A receipt resolves an uncertain network response without applying a batch twice.
-- Receipts have no browser-readable policy and are never included in client exports.
create table if not exists public.konten_sync_receipts (
  user_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  request_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, operation_id)
);

alter table public.konten_records enable row level security;
alter table public.konten_sync_receipts enable row level security;

revoke all on table public.konten_records from public, anon, authenticated;
revoke all on table public.konten_sync_receipts from public, anon, authenticated;
grant select on table public.konten_records to authenticated;

drop policy if exists konten_records_owner_select on public.konten_records;
create policy konten_records_owner_select on public.konten_records
  for select to authenticated using ((select auth.uid()) = user_id);

create or replace function public.konten_apply_changes(p_operation_id uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_change jsonb;
  v_type text;
  v_id text;
  v_deleted boolean;
  v_expected integer;
  v_payload jsonb;
  v_field text;
  v_date date;
  v_request_hash text;
  v_receipt public.konten_sync_receipts%rowtype;
  v_current public.konten_records%rowtype;
  v_written public.konten_records%rowtype;
  v_conflicts jsonb := '[]'::jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_response jsonb;
begin
  if v_user_id is null then
    raise exception using errcode = '42501', message = 'Iniciá sesión para sincronizar tus registros.';
  end if;
  if p_operation_id is null then
    raise exception using errcode = '22023', message = 'Falta el identificador de la operación.';
  end if;
  if pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'El lote de cambios debe ser una lista.';
  end if;
  if pg_catalog.jsonb_array_length(p_changes) not between 1 and 500
     or pg_catalog.octet_length(p_changes::text) > 2097152 then
    raise exception using errcode = '22023', message = 'El lote de sincronización supera los límites permitidos.';
  end if;

  -- Validate the entire request before taking locks or changing any record.
  for v_change in select value from pg_catalog.jsonb_array_elements(p_changes) loop
    if pg_catalog.jsonb_typeof(v_change) is distinct from 'object'
       or not (v_change ?& array['entity_type', 'entity_id', 'payload', 'deleted', 'expected_revision']) then
      raise exception using errcode = '22023', message = 'Hay un cambio incompleto en el lote.';
    end if;
    if exists (
      select 1 from pg_catalog.jsonb_object_keys(v_change) as fields(key)
      where key not in ('entity_type', 'entity_id', 'payload', 'deleted', 'expected_revision')
    ) then
      raise exception using errcode = '22023', message = 'Hay campos no permitidos en el lote.';
    end if;
    if pg_catalog.jsonb_typeof(v_change -> 'entity_type') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_change -> 'entity_id') is distinct from 'string'
       or pg_catalog.jsonb_typeof(v_change -> 'deleted') is distinct from 'boolean'
       or pg_catalog.jsonb_typeof(v_change -> 'expected_revision') is distinct from 'number' then
      raise exception using errcode = '22023', message = 'Hay un cambio con tipos de datos inválidos.';
    end if;
    v_type := v_change ->> 'entity_type';
    v_id := v_change ->> 'entity_id';
    if v_type not in ('income', 'expense', 'goal', 'budget', 'preferences')
       or pg_catalog.length(pg_catalog.btrim(v_id)) not between 1 and 200
       or (v_type in ('budget', 'preferences') and v_id <> 'main')
       or (v_change ->> 'expected_revision') !~ '^(0|[1-9][0-9]{0,9})$' then
      raise exception using errcode = '22023', message = 'El tipo, identificador o revisión del cambio no es válido.';
    end if;
    if (v_change ->> 'expected_revision')::numeric > 2147483646 then
      raise exception using errcode = '22023', message = 'La revisión del cambio supera el límite permitido.';
    end if;
    v_deleted := (v_change ->> 'deleted')::boolean;
    v_payload := v_change -> 'payload';
    if v_deleted then
      if v_payload is distinct from 'null'::jsonb then
        raise exception using errcode = '22023', message = 'Un registro eliminado no debe incluir un importe o contenido.';
      end if;
    else
      if pg_catalog.jsonb_typeof(v_payload) is distinct from 'object'
         or pg_catalog.octet_length(v_payload::text) > 65536 then
        raise exception using errcode = '22023', message = 'El contenido del registro no es válido o supera 64 KiB.';
      end if;
      if v_type in ('income', 'expense', 'goal') then
        if pg_catalog.jsonb_typeof(v_payload -> 'id') is distinct from 'string'
           or v_payload ->> 'id' <> v_id
           or pg_catalog.jsonb_typeof(v_payload -> 'name') is distinct from 'string'
           or pg_catalog.length(pg_catalog.btrim(v_payload ->> 'name')) not between 1 and 2000 then
          raise exception using errcode = '22023', message = 'El identificador o nombre del registro no es válido.';
        end if;
      end if;
      if v_type in ('income', 'expense') then
        if pg_catalog.jsonb_typeof(v_payload -> 'category') is distinct from 'string'
           or pg_catalog.length(pg_catalog.btrim(v_payload ->> 'category')) not between 1 and 200
           or pg_catalog.jsonb_typeof(v_payload -> 'date') is distinct from 'string'
           or (v_payload ->> 'date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
          raise exception using errcode = '22023', message = 'La categoría o fecha del registro no es válida.';
        end if;
        v_date := (v_payload ->> 'date')::date;
        if pg_catalog.to_char(v_date, 'YYYY-MM-DD') <> v_payload ->> 'date' then
          raise exception using errcode = '22023', message = 'La fecha del registro no es válida.';
        end if;
      end if;
      if v_type = 'income' and (
        pg_catalog.jsonb_typeof(v_payload -> 'frequency') is distinct from 'string'
        or v_payload ->> 'frequency' not in ('monthly', 'biweekly', 'once')
      ) then
        raise exception using errcode = '22023', message = 'La periodicidad del ingreso no es válida.';
      end if;
      if v_type = 'expense' then
        if pg_catalog.jsonb_typeof(v_payload -> 'kind') is distinct from 'string'
           or v_payload ->> 'kind' not in ('fixed', 'variable')
           or (v_payload ? 'frequency' and (
             pg_catalog.jsonb_typeof(v_payload -> 'frequency') is distinct from 'string'
             or v_payload ->> 'frequency' not in ('monthly', 'biweekly', 'once')
           )) then
          raise exception using errcode = '22023', message = 'El tipo o periodicidad del egreso no es válido.';
        end if;
      end if;
      foreach v_field in array case v_type
        when 'income' then array['amount']
        when 'expense' then array['amount']
        when 'goal' then array['target', 'saved', 'monthly']
        when 'budget' then array['savingsAmount']
        else array[]::text[] end loop
        if pg_catalog.jsonb_typeof(v_payload -> v_field) is distinct from 'number' then
          raise exception using errcode = '22023', message = 'Hay un importe que no es un número válido.';
        end if;
        if (v_payload ->> v_field)::numeric < 0 or (v_payload ->> v_field)::numeric > 1000000000000000 then
          raise exception using errcode = '22023', message = 'Hay un importe negativo o que supera el límite permitido.';
        end if;
      end loop;
      foreach v_field in array array['currency', 'savingsCurrency', 'legacyCurrency'] loop
        if v_payload ? v_field and (
          pg_catalog.jsonb_typeof(v_payload -> v_field) is distinct from 'string'
          or v_payload ->> v_field not in ('USD', 'NIO', 'EUR')
        ) then
          raise exception using errcode = '22023', message = 'La moneda del registro no es válida.';
        end if;
      end loop;
      foreach v_field in array array['exchangeRate', 'savingsExchangeRate'] loop
        if v_payload ? v_field and pg_catalog.jsonb_typeof(v_payload -> v_field) is distinct from 'object' then
          raise exception using errcode = '22023', message = 'La referencia de cambio del registro no es válida.';
        end if;
      end loop;
    end if;
  end loop;
  if exists (
    select 1 from pg_catalog.jsonb_array_elements(p_changes) as changes(value)
    group by value ->> 'entity_type', value ->> 'entity_id' having pg_catalog.count(*) > 1
  ) then
    raise exception using errcode = '22023', message = 'Un registro aparece más de una vez en el mismo lote.';
  end if;

  -- All writes for one owner serialize, including creation of a previously missing ID.
  -- Never accept a caller-supplied owner or select another owner's records.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('konten:' || v_user_id::text, 0));
  v_request_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_changes::text, 'UTF8')), 'hex');
  select * into v_receipt from public.konten_sync_receipts
    where user_id = v_user_id and operation_id = p_operation_id;
  if found then
    if v_receipt.request_hash <> v_request_hash then
      raise exception using errcode = '22023', message = 'El identificador de operación ya se usó con otro contenido.';
    end if;
    return v_receipt.response;
  end if;

  for v_change in select value from pg_catalog.jsonb_array_elements(p_changes) loop
    v_type := v_change ->> 'entity_type';
    v_id := v_change ->> 'entity_id';
    v_expected := (v_change ->> 'expected_revision')::integer;
    select * into v_current from public.konten_records
      where user_id = v_user_id and entity_type = v_type and entity_id = v_id;
    if not found then
      if v_expected <> 0 then
        v_conflicts := v_conflicts || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
          'user_id', v_user_id, 'entity_type', v_type, 'entity_id', v_id,
          'payload', null, 'revision', 0, 'deleted', true, 'updated_at', null
        ));
      end if;
    elsif v_current.revision <> v_expected then
      v_conflicts := v_conflicts || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_current));
    end if;
  end loop;
  if pg_catalog.jsonb_array_length(v_conflicts) > 0 then
    -- Conflict responses are not receipted: a correctly rebased retry is a new operation.
    return pg_catalog.jsonb_build_object('applied', false, 'rows', '[]'::jsonb, 'conflicts', v_conflicts);
  end if;

  for v_change in select value from pg_catalog.jsonb_array_elements(p_changes) loop
    v_type := v_change ->> 'entity_type';
    v_id := v_change ->> 'entity_id';
    v_deleted := (v_change ->> 'deleted')::boolean;
    v_payload := case when v_deleted then null else v_change -> 'payload' end;
    insert into public.konten_records (user_id, entity_type, entity_id, payload, revision, deleted, updated_at)
      values (v_user_id, v_type, v_id, v_payload, 1, v_deleted, pg_catalog.clock_timestamp())
    on conflict (user_id, entity_type, entity_id) do update
      set payload = excluded.payload, revision = public.konten_records.revision + 1,
          deleted = excluded.deleted, updated_at = pg_catalog.clock_timestamp()
    returning * into v_written;
    v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_written));
  end loop;
  v_response := pg_catalog.jsonb_build_object('applied', true, 'rows', v_rows, 'conflicts', '[]'::jsonb);
  insert into public.konten_sync_receipts (user_id, operation_id, request_hash, response)
    values (v_user_id, p_operation_id, v_request_hash, v_response);
  return v_response;
end;
$$;

revoke all on function public.konten_apply_changes(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.konten_apply_changes(uuid, jsonb) to authenticated;

comment on table public.konten_records is 'Private per-owner finance records; deleted rows are retained as tombstones.';
comment on table public.konten_sync_receipts is 'Private idempotency receipts; do not truncate while devices may have pending operations.';
comment on function public.konten_apply_changes(uuid, jsonb) is 'Authenticated owner-only optimistic batch update; no records written if any expected revision conflicts.';

commit;
