alter table public.luna_whatsapp_batches enable row level security;

-- Edge functions use the service role; no member-facing policies.
-- Table privileges still required for PostgREST (service_role bypasses RLS).
grant select, insert, update, delete, references, trigger, truncate
on table public.luna_whatsapp_batches
to service_role;
