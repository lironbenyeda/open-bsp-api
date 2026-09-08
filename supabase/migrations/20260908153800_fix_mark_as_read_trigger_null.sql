-- Fix mark-as-read/typing dispatcher trigger: `<>` does not fire when the
-- previous JSON value is missing (NULL <> 'ts' is unknown, not true). First
-- read/typing update on an incoming message therefore never dispatched to
-- WhatsApp; a second update did. Use IS DISTINCT FROM so NULL -> value fires.
drop trigger if exists "handle_mark_as_read_to_dispatcher" on "public"."messages";

create trigger handle_mark_as_read_to_dispatcher
after update
on public.messages
for each row
when (
  new.direction = 'incoming'::public.direction
  and new.service <> 'local'::public.service
  and (
    (old.status ->> 'read') is distinct from (new.status ->> 'read')
    or (old.status ->> 'typing') is distinct from (new.status ->> 'typing')
  )
  and (new.status ->> 'pending') is not null
)
execute function public.dispatcher_edge_function();
