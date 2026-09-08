import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as log from "../_shared/logger.ts";
import { authorizeLunaWhatsAppBatchWebhookRequest } from "../_shared/luna-whatsapp-batch.ts";
import {
  createUnsecureClient,
  type IncomingStatus,
  type MessageRow,
} from "../_shared/supabase.ts";

type LunaMessageStatusRequest = {
  /** WhatsApp message id (wamid) — `batchParts[].id` / `messages.external_id`. */
  external_id: string;
  /** Optional tenant scope (recommended in multi-tenant setups). */
  organization_id?: string;
  /** Mark the message as read (blue ticks). */
  read?: boolean;
  /** Show a typing indicator (auto-clears ~25s or on reply). */
  typing?: boolean;
};

function parseBody(body: unknown): LunaMessageStatusRequest | null {
  if (!body || typeof body !== "object") return null;
  const o = body as Record<string, unknown>;
  if (typeof o.external_id !== "string" || !o.external_id.trim()) return null;
  if (
    o.organization_id !== undefined &&
    (typeof o.organization_id !== "string" || !o.organization_id.trim())
  ) {
    return null;
  }
  if (o.read !== undefined && typeof o.read !== "boolean") return null;
  if (o.typing !== undefined && typeof o.typing !== "boolean") return null;
  if (!o.read && !o.typing) return null;

  return {
    external_id: o.external_id.trim(),
    ...(typeof o.organization_id === "string" && {
      organization_id: o.organization_id.trim(),
    }),
    ...(typeof o.read === "boolean" && { read: o.read }),
    ...(typeof o.typing === "boolean" && { typing: o.typing }),
  };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!authorizeLunaWhatsAppBatchWebhookRequest(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const body = parseBody(raw);
  if (!body) {
    return Response.json(
      {
        error:
          "Body must include external_id and at least one of read/typing (boolean)",
      },
      { status: 400 },
    );
  }

  const client = createUnsecureClient();
  const now = new Date().toISOString();

  let query = client
    .from("messages")
    .select("id, organization_id, direction, service, external_id, status")
    .eq("external_id", body.external_id)
    .eq("direction", "incoming");

  if (body.organization_id) {
    query = query.eq("organization_id", body.organization_id);
  }

  const { data: message, error: lookupError } = await query.maybeSingle();

  if (lookupError) {
    log.error("Failed to look up message for Luna status update", lookupError);
    return new Response("Lookup failed", { status: 500 });
  }

  if (!message) {
    return new Response("Message not found", { status: 404 });
  }

  const row = message as Pick<
    MessageRow,
    | "id"
    | "organization_id"
    | "direction"
    | "service"
    | "external_id"
    | "status"
  >;

  if (row.service === "local") {
    return Response.json(
      { error: "Cannot mark local messages as read/typing" },
      { status: 400 },
    );
  }

  const status = row.status as IncomingStatus;
  if (!status?.pending) {
    return Response.json(
      {
        error:
          "Message has no pending status; mark-read/typing will not dispatch",
      },
      { status: 409 },
    );
  }

  const statusUpdate: IncomingStatus = {
    ...(body.read && { read: now }),
    ...(body.typing && { typing: now }),
  };

  const { error: updateError } = await client
    .from("messages")
    .update({ status: statusUpdate })
    .eq("id", row.id);

  if (updateError) {
    log.error("Failed to update message status for Luna", updateError);
    return new Response("Update failed", { status: 500 });
  }

  log.info("Luna message status updated", {
    messageId: row.id,
    externalId: row.external_id,
    organizationId: row.organization_id,
    read: !!body.read,
    typing: !!body.typing,
  });

  return Response.json({
    ok: true,
    message_id: row.id,
    external_id: row.external_id,
    read: body.read ? now : undefined,
    typing: body.typing ? now : undefined,
  });
});
