-- Atomically append an incoming WhatsApp message to the open debounce batch.
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
