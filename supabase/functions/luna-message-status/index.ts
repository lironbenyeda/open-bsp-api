import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as log from "../_shared/logger.ts";
import {
  createApiClientFromKey,
  createUnsecureClient,
  type IncomingStatus,
  type MessageRow,
} from "../_shared/supabase.ts";

type LunaMessageStatusRequest = {
  /** WhatsApp message id (wamid) — `batchParts[].id` / `messages.external_id`. */
  external_id: string;
  /** Optional; defaults to the org resolved from the API key. */
  organization_id?: string;
  /** Mark the message as read (blue ticks). */
  read?: boolean;
  /** Show a typing indicator (auto-clears ~25s or on reply). */
  typing?: boolean;
};

/** Same as mcp: `api-key` header, or non-JWT Authorization bearer. */
function extractApiKey(req: Request): string | null {
  const headerKey = req.headers.get("api-key")?.trim();
  if (headerKey) return headerKey;

  const bearer = (req.headers.get("Authorization") ?? "").replace(
    /^Bearer\s+/i,
    "",
  ).trim();
  if (!bearer) return null;

  // JWTs have 3 dot-separated segments; org API keys do not.
  const looksLikeJwt = bearer.split(".").length === 3;
  if (looksLikeJwt) return null;
  return bearer;
}

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

  const apiKey = extractApiKey(req);
  if (!apiKey) {
    return Response.json({ error: "Missing API key" }, { status: 401 });
  }

  const apiClient = createApiClientFromKey(apiKey);
  const { data: key, error: apiKeyError } = await apiClient
    .from("api_keys")
    .select("organization_id")
    .eq("key", apiKey)
    .maybeSingle();

  if (apiKeyError || !key) {
    log.error("API key not authorized", apiKeyError);
    return Response.json({ error: "API key not authorized" }, { status: 401 });
  }

  const orgId = key.organization_id;

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

  if (body.organization_id && body.organization_id !== orgId) {
    return Response.json(
      { error: "organization_id does not match API key org" },
      { status: 403 },
    );
  }

  // Members cannot UPDATE messages (RLS); auth is org API key, write is
  // service-role scoped to that org — same pattern as agent-client.
  const client = createUnsecureClient();
  const now = new Date().toISOString();

  const { data: message, error: lookupError } = await client
    .from("messages")
    .select("id, organization_id, direction, service, external_id, status")
    .eq("external_id", body.external_id)
    .eq("direction", "incoming")
    .eq("organization_id", orgId)
    .maybeSingle();

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
    .eq("id", row.id)
    .eq("organization_id", orgId);

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
