-- Debounced batches of inbound WhatsApp messages forwarded to Luna.
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
