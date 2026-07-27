create table public.luna_whatsapp_batches (
  id uuid default gen_random_uuid() not null,
  organization_id uuid not null,
  contact_address text not null,
  service public.service default 'whatsapp'::public.service not null,
  status text default 'open'::text not null,
  message_ids uuid[] default '{}'::uuid[] not null,
  flush_at timestamp with time zone not null,
  idempotency_key text,
  luna_response jsonb,
  error_message text,
  attempt_count integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  constraint luna_whatsapp_batches_pkey primary key (id),
  constraint luna_whatsapp_batches_organization_id_fkey
    foreign key (organization_id) references public.organizations (id) on delete cascade,
  constraint luna_whatsapp_batches_status_check check (
    status = any (array['open'::text, 'flushing'::text, 'sent'::text, 'failed'::text])
  )
);

create unique index luna_whatsapp_batches_open_contact_idx
on public.luna_whatsapp_batches
using btree (organization_id, contact_address, service)
where (status = 'open'::text);

create index luna_whatsapp_batches_flush_at_idx
on public.luna_whatsapp_batches
using btree (flush_at)
where (status = 'open'::text);

create index luna_whatsapp_batches_organization_id_idx
on public.luna_whatsapp_batches
using btree (organization_id);

create trigger set_updated_at
before update on public.luna_whatsapp_batches
for each row
execute function public.moddatetime('updated_at');

alter table public.luna_whatsapp_batches enable row level security;

create or replace function public.luna_whatsapp_batch_enqueue_message(
  p_organization_id uuid,
  p_contact_address text,
  p_message_id uuid,
  p_service public.service default 'whatsapp'::public.service,
  p_debounce_seconds integer default 7
) returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch_id uuid;
  v_flush_at timestamptz := now() + make_interval(secs => p_debounce_seconds);
begin
  insert into public.luna_whatsapp_batches (
    organization_id,
    contact_address,
    service,
    message_ids,
    flush_at
  ) values (
    p_organization_id,
    p_contact_address,
    p_service,
    array[p_message_id],
    v_flush_at
  )
  on conflict (organization_id, contact_address, service)
  where (status = 'open'::text)
  do update set
    message_ids = public.luna_whatsapp_batches.message_ids || excluded.message_ids,
    flush_at = excluded.flush_at,
    updated_at = now()
  returning id into v_batch_id;

  return v_batch_id;
end;
$$;

-- Backup flush for batches whose debounce timer expired without another webhook.
select cron.schedule(
  'luna-whatsapp-batch-flush-minute',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_url') || '/luna-whatsapp-batch-flush',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'edge_functions_token')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  ) as request_id
  $$
);
