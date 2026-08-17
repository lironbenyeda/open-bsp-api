import { encodeBase64 } from "jsr:@std/encoding/base64";
import type { SupabaseClient } from "@supabase/supabase-js";
import ky from "ky";
import * as log from "./logger.ts";
import { downloadFromStorage } from "./media.ts";
import type {
  ButtonsMessageData,
  Database,
  IncomingMessage,
  MessageRow,
  OrganizationRow,
  OutgoingMessage,
} from "./supabase.ts";
import { type MessageRowV0, toV1 } from "./messages-v0.ts";

export type LunaRecentMessagesPolicy = {
  hours: number;
  includeMedia: "batch_only" | "all_in_window";
};

export type LunaRecentMessage = {
  id?: string;
  direction: "incoming" | "outgoing";
  timestamp: string;
  kind: "text" | "image" | "audio" | "document" | "video" | "button" | "other";
  text?: string;
  /** Reply-button / list / template-button id when `kind` is `button`. */
  buttonId?: string;
  mimeType?: string;
  base64Data?: string | null;
  fileName?: string;
  /** WhatsApp message id (WAMID) this message replies to, when present. */
  replyToId?: string;
  /** True when the WhatsApp message was forwarded. */
  forwarded?: boolean;
};

export type LunaBatchPart = {
  id: string;
  kind: "text" | "image" | "audio" | "button";
  text?: string;
  /** Reply-button / list / template-button id when `kind` is `button`. */
  buttonId?: string;
  mimeType?: string;
  base64Data?: string;
  fileName?: string;
  /** WhatsApp message id (WAMID) this part replies to, when present. */
  replyToId?: string;
  /** True when the WhatsApp message was forwarded. */
  forwarded?: boolean;
};

export type LunaWhatsAppBatchPayload = {
  idempotencyKey: string;
  senderPhone: string;
  receivedAt: string;
  contextHours: number;
  recentMessagesPolicy: LunaRecentMessagesPolicy;
  recentMessages: LunaRecentMessage[];
  batchParts: LunaBatchPart[];
};

export type LunaWhatsAppBatchRow =
  Database["public"]["Tables"]["luna_whatsapp_batches"]["Row"];

const DEFAULT_CONTEXT_HOURS = 3;
const DEFAULT_DEBOUNCE_SECONDS = 7;
const MAX_FLUSH_ATTEMPTS = 5;
const SUPPORTED_FILE_KINDS = new Set(["audio", "image", "document", "video"]);

export function lunaWhatsAppBatchDebounceSeconds(): number {
  const raw = Deno.env.get("LUNA_WHATSAPP_BATCH_DEBOUNCE_SECONDS");
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_DEBOUNCE_SECONDS;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_DEBOUNCE_SECONDS;
}

/** Reply-button / list taps are complete intents — flush without the text debounce. */
export function lunaWhatsAppBatchDebounceSecondsForMessage(
  message: MessageRow,
): number {
  const content = normalizeMessageRow(message).content as IncomingMessage;
  if (lunaButtonTapFromContent(content)) return 0;
  return lunaWhatsAppBatchDebounceSeconds();
}

export function lunaWhatsAppBatchContextHours(
  org?: OrganizationRow | null,
): number {
  const orgHours =
    (org?.extra as { luna_whatsapp_batch_context_hours?: number } | null)
      ?.luna_whatsapp_batch_context_hours;
  if (typeof orgHours === "number" && orgHours > 0) return orgHours;

  const raw = Deno.env.get("LUNA_WHATSAPP_BATCH_CONTEXT_HOURS");
  const parsed = raw ? Number.parseInt(raw, 10) : DEFAULT_CONTEXT_HOURS;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CONTEXT_HOURS;
}

export function normalizeSenderPhone(contactAddress: string): string {
  return contactAddress.replace(/\D/g, "");
}

function normalizeMessageRow(row: MessageRow): MessageRow {
  const content = row.content as { version?: string };
  if (content.version === "1") return row;
  const converted = toV1(row as unknown as MessageRowV0);
  if (!converted) return row;
  return converted;
}

function lunaKindFromFileMime(
  mimeType: string,
): "image" | "audio" | "document" | "video" | "other" {
  const mime = mimeType.toLowerCase().split(";")[0]?.trim() ?? "";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf" || mime.startsWith("application/")) {
    return "document";
  }
  if (mime.startsWith("video/")) return "video";
  return "other";
}

function batchPartKindFromMime(mimeType: string): "image" | "audio" | null {
  const kind = lunaKindFromFileMime(mimeType);
  if (kind === "audio") return "audio";
  if (kind === "image" || kind === "document") return "image";
  return null;
}

async function fileToBase64(
  client: SupabaseClient<Database>,
  uri: string,
): Promise<string | null> {
  if (!uri.startsWith("internal://media/")) return null;
  try {
    const blob = await downloadFromStorage(client, uri);
    const buffer = await blob.arrayBuffer();
    return encodeBase64(new Uint8Array(buffer));
  } catch (error) {
    log.warn("Failed to read media for Luna WhatsApp batch", {
      uri,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

function replyToIdFromContent(
  content: IncomingMessage | OutgoingMessage,
): string | undefined {
  return content.re_message_id || undefined;
}

function lunaButtonTapFromContent(
  content: IncomingMessage,
): { buttonId: string; text: string } | null {
  if (content.type !== "data") return null;

  if (content.kind === "button") {
    const payload = content.data.payload?.trim() ?? "";
    const text = content.data.text?.trim() ?? "";
    if (!payload && !text) return null;
    return { buttonId: payload || text, text: text || payload };
  }

  if (content.kind === "interactive") {
    const data = content.data;
    if (data.type === "button_reply") {
      const buttonId = data.button_reply.id?.trim() ?? "";
      const text = data.button_reply.title?.trim() ?? "";
      if (!buttonId && !text) return null;
      return { buttonId: buttonId || text, text: text || buttonId };
    }
    if (data.type === "list_reply") {
      const buttonId = data.list_reply.id?.trim() ?? "";
      const text = data.list_reply.title?.trim() ?? "";
      if (!buttonId && !text) return null;
      return { buttonId: buttonId || text, text: text || buttonId };
    }
  }

  return null;
}

function lunaOutgoingButtonsText(data: ButtonsMessageData): string {
  const body = data.body?.trim() ?? "";
  const titles = (data.buttons ?? [])
    .map((button) => button.title?.trim())
    .filter((title): title is string => Boolean(title));
  if (titles.length === 0) return body;
  const labels = `[${titles.join(" / ")}]`;
  return body ? `${body}\n${labels}` : labels;
}

function lunaContextFields(content: IncomingMessage | OutgoingMessage): {
  replyToId?: string;
  forwarded?: boolean;
} {
  const replyToId = replyToIdFromContent(content);
  return {
    ...(replyToId && { replyToId }),
    ...(content.forwarded && { forwarded: true as const }),
  };
}

function collectReplyToIds(rows: MessageRow[]): Set<string> {
  const ids = new Set<string>();
  for (const message of rows) {
    const content = normalizeMessageRow(message).content as IncomingMessage;
    const replyToId = replyToIdFromContent(content);
    if (replyToId) ids.add(replyToId);
  }
  return ids;
}

async function messageToLunaRecent(
  client: SupabaseClient<Database>,
  message: MessageRow,
  opts: { includeMedia: boolean },
): Promise<LunaRecentMessage | null> {
  const row = normalizeMessageRow(message);
  const content = row.content as IncomingMessage | OutgoingMessage;
  const base = {
    ...(row.external_id ? { id: row.external_id } : {}),
    direction: row.direction === "outgoing"
      ? "outgoing" as const
      : "incoming" as const,
    timestamp: row.timestamp,
    ...lunaContextFields(content),
  };

  if (content.type === "data" && content.kind === "flow-reply") {
    return null;
  }

  const tap = content.type === "data" && content.kind !== "buttons"
    ? lunaButtonTapFromContent(content as IncomingMessage)
    : null;
  if (tap) {
    return {
      ...base,
      kind: "button",
      text: tap.text,
      buttonId: tap.buttonId,
    };
  }

  if (content.type === "data" && content.kind === "buttons") {
    return {
      ...base,
      kind: "text",
      text: lunaOutgoingButtonsText(content.data),
    };
  }

  if (content.type === "text") {
    return {
      ...base,
      kind: "text",
      text: content.text,
    };
  }

  if (content.type === "file" && SUPPORTED_FILE_KINDS.has(content.kind)) {
    const mimeType = content.file.mime_type;
    const kind = lunaKindFromFileMime(mimeType);
    let base64Data: string | null = null;
    if (opts.includeMedia) {
      base64Data = await fileToBase64(client, content.file.uri);
    }
    return {
      ...base,
      kind,
      text: content.text,
      mimeType,
      base64Data,
      fileName: content.file.name,
    };
  }

  return {
    ...base,
    kind: "other",
    text: content.type === "data" ? JSON.stringify(content.data) : undefined,
  };
}

async function messageToBatchPart(
  client: SupabaseClient<Database>,
  message: MessageRow,
): Promise<LunaBatchPart | LunaBatchPart[] | null> {
  const row = normalizeMessageRow(message);
  const content = row.content as IncomingMessage;
  // Luna requires batchParts[].id; skip rather than 422 when WhatsApp id is missing.
  if (!row.external_id) {
    log.warn("Skipping Luna batch part without external_id", {
      messageId: row.id,
    });
    return null;
  }
  const id = row.external_id;
  const contextFields = lunaContextFields(content);

  if (content.type === "text" && content.text?.trim()) {
    return { id, kind: "text", text: content.text.trim(), ...contextFields };
  }

  const tap = lunaButtonTapFromContent(content);
  if (tap) {
    return {
      id,
      kind: "button",
      text: tap.text,
      buttonId: tap.buttonId,
      ...contextFields,
    };
  }

  if (content.type !== "file" || !SUPPORTED_FILE_KINDS.has(content.kind)) {
    return null;
  }

  const partKind = batchPartKindFromMime(content.file.mime_type);
  if (!partKind) return null;

  const base64Data = await fileToBase64(client, content.file.uri);
  if (!base64Data) return null;

  return {
    id,
    kind: partKind,
    mimeType: content.file.mime_type,
    base64Data,
    fileName: content.file.name,
    text: content.text?.trim() || undefined,
    ...contextFields,
  };
}

export async function buildLunaWhatsAppBatchPayload(
  client: SupabaseClient<Database>,
  input: {
    batch: LunaWhatsAppBatchRow;
    organization: OrganizationRow;
  },
): Promise<LunaWhatsAppBatchPayload> {
  const contextHours = lunaWhatsAppBatchContextHours(input.organization);
  const policy: LunaRecentMessagesPolicy = {
    hours: contextHours,
    includeMedia: "batch_only",
  };

  const batchMessageIds = input.batch.message_ids;
  const since = new Date(Date.now() - contextHours * 60 * 60 * 1000)
    .toISOString();

  const [{ data: batchMessages }, { data: recentMessages }] = await Promise.all(
    [
      client
        .from("messages")
        .select()
        .in("id", batchMessageIds)
        .order("timestamp", { ascending: true })
        .throwOnError(),
      client
        .from("messages")
        .select()
        .eq("organization_id", input.batch.organization_id)
        .eq("contact_address", input.batch.contact_address)
        .eq("service", input.batch.service)
        .gt("timestamp", since)
        .order("timestamp", { ascending: true })
        .throwOnError(),
    ],
  );

  // Any message we send Luna (batch or recent history) that has replyToId
  // should also include that quoted message in recentMessages. Prefer rows
  // already in the time window; fetch only missing ids (batched).
  const recentRows = [...(recentMessages ?? [])];
  const recentExternalIds = new Set(
    recentRows.map((m) => m.external_id).filter((id): id is string =>
      Boolean(id)
    ),
  );
  const repliedToIds = collectReplyToIds([
    ...(batchMessages ?? []),
    ...recentRows,
  ]);
  const lookupAttempted = new Set<string>();

  for (let pass = 0; pass < 3; pass++) {
    const missingReplyToIds = [...repliedToIds].filter((id) =>
      !recentExternalIds.has(id) && !lookupAttempted.has(id)
    );
    if (missingReplyToIds.length === 0) break;
    for (const id of missingReplyToIds) lookupAttempted.add(id);

    const { data: replyTargets } = await client
      .from("messages")
      .select()
      .eq("organization_id", input.batch.organization_id)
      .eq("contact_address", input.batch.contact_address)
      .eq("service", input.batch.service)
      .in("external_id", missingReplyToIds)
      .throwOnError();

    const fetched = replyTargets ?? [];
    if (fetched.length === 0) break;

    for (const row of fetched) {
      recentRows.push(row);
      if (row.external_id) recentExternalIds.add(row.external_id);
    }
    for (const id of collectReplyToIds(fetched)) repliedToIds.add(id);
  }

  recentRows.sort((a, b) =>
    a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0
  );

  // Include media bytes for quoted messages (in-window or fetched), so Luna can
  // resolve image/audio/doc quotes even when policy is batch_only.
  const includeMediaInRecent = policy.includeMedia === "all_in_window";
  const recent = (await Promise.all(
    recentRows.map((message) =>
      messageToLunaRecent(client, message, {
        includeMedia: includeMediaInRecent ||
          Boolean(message.external_id && repliedToIds.has(message.external_id)),
      })
    ),
  )).filter((row): row is LunaRecentMessage => row !== null);

  const batchParts: LunaBatchPart[] = [];
  for (const message of batchMessages ?? []) {
    const part = await messageToBatchPart(client, message);
    if (!part) continue;
    if (Array.isArray(part)) batchParts.push(...part);
    else batchParts.push(part);
  }

  const sortedIds = [...batchMessageIds].sort();
  const idempotencyKey = `${input.batch.organization_id}:${
    normalizeSenderPhone(input.batch.contact_address)
  }:${sortedIds.join(",")}`;

  return {
    idempotencyKey,
    senderPhone: normalizeSenderPhone(input.batch.contact_address),
    receivedAt: new Date().toISOString(),
    contextHours,
    recentMessagesPolicy: policy,
    recentMessages: recent,
    batchParts,
  };
}

export async function sendLunaWhatsAppBatch(
  payload: LunaWhatsAppBatchPayload,
): Promise<{ status: number; body: unknown }> {
  const url = Deno.env.get("LUNA_WHATSAPP_BATCH_URL");
  const secret = Deno.env.get("LUNA_WEBHOOK_SECRET");
  if (!url || !secret) {
    throw new Error(
      "LUNA_WHATSAPP_BATCH_URL and LUNA_WEBHOOK_SECRET must be set",
    );
  }

  const response = await ky.post(url, {
    json: payload,
    headers: { Authorization: `Bearer ${secret}` },
    timeout: 120_000,
    throwHttpErrors: false,
  });

  const text = await response.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // keep raw text
  }

  return { status: response.status, body };
}

export async function claimBatchForFlush(
  client: SupabaseClient<Database>,
  batchId: string,
): Promise<LunaWhatsAppBatchRow | null> {
  const { data } = await client
    .from("luna_whatsapp_batches")
    .update({ status: "flushing" })
    .eq("id", batchId)
    .eq("status", "open")
    .lte("flush_at", new Date().toISOString())
    .select()
    .maybeSingle();

  return data;
}

export async function flushLunaWhatsAppBatch(
  client: SupabaseClient<Database>,
  batchId: string,
): Promise<"flushed" | "not_ready" | "skipped"> {
  const claimed = await claimBatchForFlush(client, batchId);
  if (!claimed) return "not_ready";

  if (claimed.attempt_count >= MAX_FLUSH_ATTEMPTS) {
    await client
      .from("luna_whatsapp_batches")
      .update({
        status: "failed",
        error_message: "Max flush attempts exceeded",
      })
      .eq("id", batchId)
      .throwOnError();
    return "skipped";
  }

  const { data: organization } = await client
    .from("organizations")
    .select()
    .eq("id", claimed.organization_id)
    .single()
    .throwOnError();

  try {
    const payload = await buildLunaWhatsAppBatchPayload(client, {
      batch: claimed,
      organization,
    });

    if (
      !payload.batchParts.length && !payload.recentMessages.some((m) => m.text)
    ) {
      await client
        .from("luna_whatsapp_batches")
        .update({
          status: "sent",
          idempotency_key: payload.idempotencyKey,
          luna_response: { skipped: true, reason: "empty_batch" },
          error_message: null,
        })
        .eq("id", batchId)
        .throwOnError();
      return "flushed";
    }

    const result = await sendLunaWhatsAppBatch(payload);

    if (result.status >= 200 && result.status < 300) {
      await client
        .from("luna_whatsapp_batches")
        .update({
          status: "sent",
          idempotency_key: payload.idempotencyKey,
          luna_response: result
            .body as Database["public"]["Tables"]["luna_whatsapp_batches"][
              "Row"
            ]["luna_response"],
          error_message: null,
        })
        .eq("id", batchId)
        .throwOnError();
      log.info("Luna WhatsApp batch flush succeeded", {
        batchId,
        idempotencyKey: payload.idempotencyKey,
        status: result.status,
      });
      return "flushed";
    }

    const errorMessage = typeof result.body === "object" && result.body &&
        "error" in result.body
      ? String((result.body as { error: unknown }).error)
      : `Luna returned HTTP ${result.status}`;

    await client
      .from("luna_whatsapp_batches")
      .update({
        status: result.status === 404 ? "failed" : "open",
        attempt_count: claimed.attempt_count + 1,
        idempotency_key: payload.idempotencyKey,
        luna_response: result
          .body as Database["public"]["Tables"]["luna_whatsapp_batches"]["Row"][
            "luna_response"
          ],
        error_message: errorMessage,
        flush_at: new Date(Date.now() + 30_000).toISOString(),
      })
      .eq("id", batchId)
      .throwOnError();

    log.warn("Luna WhatsApp batch flush failed", {
      batchId,
      status: result.status,
      error: errorMessage,
    });
    return "skipped";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await client
      .from("luna_whatsapp_batches")
      .update({
        status: "open",
        attempt_count: claimed.attempt_count + 1,
        error_message: message,
        flush_at: new Date(Date.now() + 30_000).toISOString(),
      })
      .eq("id", batchId)
      .throwOnError();
    log.error("Luna WhatsApp batch flush error", { batchId, error: message });
    return "skipped";
  }
}

export async function flushLunaWhatsAppBatchWhenReady(
  client: SupabaseClient<Database>,
  batchId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const { data: batch } = await client
      .from("luna_whatsapp_batches")
      .select("id, status, flush_at")
      .eq("id", batchId)
      .maybeSingle();

    if (!batch || batch.status !== "open") return;

    const waitMs = new Date(batch.flush_at).getTime() - Date.now();
    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      continue;
    }

    const result = await flushLunaWhatsAppBatch(client, batchId);
    if (result === "flushed" || result === "skipped") return;

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  log.warn("Luna WhatsApp batch debounce watcher gave up", { batchId });
}

export async function flushDueLunaWhatsAppBatches(
  client: SupabaseClient<Database>,
  limit = 20,
): Promise<number> {
  await client
    .from("luna_whatsapp_batches")
    .update({ status: "open" })
    .eq("status", "flushing")
    .lt("updated_at", new Date(Date.now() - 5 * 60 * 1000).toISOString())
    .throwOnError();

  const { data: due } = await client
    .from("luna_whatsapp_batches")
    .select("id")
    .eq("status", "open")
    .lte("flush_at", new Date().toISOString())
    .order("flush_at", { ascending: true })
    .limit(limit);

  let flushed = 0;
  for (const row of due ?? []) {
    const result = await flushLunaWhatsAppBatch(client, row.id);
    if (result === "flushed") flushed += 1;
  }
  return flushed;
}

export type OpenBspOutboundWebhookPayload<T> = {
  data: T;
  entity: string;
  action: string;
};

export function isLunaWhatsAppBatchWebhookPayload(
  body: unknown,
): body is OpenBspOutboundWebhookPayload<MessageRow> {
  if (!body || typeof body !== "object") return false;
  const payload = body as OpenBspOutboundWebhookPayload<MessageRow>;
  return payload.entity === "messages" &&
    payload.action === "insert" &&
    Boolean(payload.data);
}

export function runAfterResponse(promise: Promise<unknown>): void {
  const runtime = globalThis as {
    EdgeRuntime?: { waitUntil(p: Promise<unknown>): void };
  };
  if (runtime.EdgeRuntime) {
    runtime.EdgeRuntime.waitUntil(promise);
    return;
  }
  promise.catch((error) => {
    log.error("Luna WhatsApp batch background task failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

export function shouldEnqueueLunaWhatsAppBatch(message: MessageRow): boolean {
  if (message.direction !== "incoming") return false;
  if (message.service !== "whatsapp") return false;
  if (!message.contact_address) return false;
  const content = message.content as IncomingMessage;
  if (content.type === "data" && content.kind === "flow-reply") return false;
  return true;
}

export function authorizeLunaWhatsAppBatchWebhookRequest(
  req: Request,
): boolean {
  const expected = Deno.env.get("LUNA_WEBHOOK_TOKEN");
  if (!expected) {
    log.warn("LUNA_WEBHOOK_TOKEN is not set");
    return false;
  }
  const auth = req.headers.get("Authorization");
  const token = auth?.replace(/^Bearer\s+/i, "");
  return token === expected;
}

export function authorizeLunaWhatsAppBatchFlushRequest(req: Request): boolean {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const webhookToken = Deno.env.get("LUNA_WEBHOOK_TOKEN");
  const auth = req.headers.get("Authorization");
  const token = auth?.replace(/^Bearer\s+/i, "");
  return Boolean(
    (serviceKey && token === serviceKey) ||
      (webhookToken && token === webhookToken),
  );
}
