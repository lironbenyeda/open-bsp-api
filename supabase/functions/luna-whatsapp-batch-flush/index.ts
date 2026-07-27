import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import * as log from "../_shared/logger.ts";
import {
  authorizeLunaWhatsAppBatchFlushRequest,
  flushDueLunaWhatsAppBatches,
} from "../_shared/luna-whatsapp-batch.ts";
import { createUnsecureClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  if (!authorizeLunaWhatsAppBatchFlushRequest(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const client = createUnsecureClient();
  const flushed = await flushDueLunaWhatsAppBatches(client);

  log.info("Luna WhatsApp batch flush sweep completed", { flushed });

  return Response.json({ ok: true, flushed });
});
