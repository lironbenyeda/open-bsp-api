-- PostgREST access for luna-whatsapp-batch-flush (service_role).
-- The table was created without role grants; enqueue still worked via
-- security definer RPC, but direct select/update from the edge function failed.
-- service_role only: internal batch table, no client/anon access.
grant select, insert, update, delete, references, trigger, truncate
on table public.luna_whatsapp_batches
to service_role;
