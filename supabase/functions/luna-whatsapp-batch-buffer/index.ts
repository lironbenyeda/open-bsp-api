import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as log from "../_shared/logger.ts";
import {
  authorizeLunaWhatsAppBatchWebhookRequest,
  flushLunaWhatsAppBatchWhenReady,
  isLunaWhatsAppBatchWebhookPayload,
  lunaWhatsAppBatchDebounceSecondsForMessage,
  runAfterResponse,
  shouldEnqueueLunaWhatsAppBatch,
} from "../_shared/luna-whatsapp-batch.ts";
import { createUnsecureClient, type MessageRow } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!authorizeLunaWhatsAppBatchWebhookRequest(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (!isLunaWhatsAppBatchWebhookPayload(body)) {
    return new Response("Ignored", { status: 200 });
  }

  const message = body.data as MessageRow;
  if (!shouldEnqueueLunaWhatsAppBatch(message)) {
    return new Response("Ignored", { status: 200 });
  }

  const client = createUnsecureClient();
  // Button/list taps: debounce 0 so Luna is called immediately.
  const debounceSeconds = lunaWhatsAppBatchDebounceSecondsForMessage(message);

  const { data: batchId, error } = await client.rpc(
    "luna_whatsapp_batch_enqueue_message",
    {
      p_organization_id: message.organization_id,
      p_contact_address: message.contact_address!,
      p_message_id: message.id,
      p_service: message.service,
      p_debounce_seconds: debounceSeconds,
    },
  );

  if (error) {
    log.error("Failed to enqueue Luna WhatsApp batch", error);
    return new Response("Enqueue failed", { status: 500 });
  }

  log.info("Enqueued message for Luna WhatsApp batch", {
    batchId,
    messageId: message.id,
    contactAddress: message.contact_address,
    debounceSeconds,
  });

  runAfterResponse(
    flushLunaWhatsAppBatchWhenReady(client, batchId as string),
  );

  return new Response("OK", { status: 200 });
});
