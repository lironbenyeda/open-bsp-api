import * as log from "../_shared/logger.ts";
import ky from "ky";
import {
  createUnsecureClient,
  type WhatsAppOrganizationAddressExtra,
} from "../_shared/supabase.ts";
import {
  decryptFlowRequest,
  encryptFlowResponse,
  type FlowDataExchangeRequest,
  type FlowDataExchangeResponse,
  type FlowEncryptedRequest,
  flowErrorScreen,
  validateMetaSignature,
} from "../_shared/whatsapp-flows.ts";

const APP_SECRET = Deno.env.get("META_APP_SECRET") ?? "";
const LUNA_CALLBACK_TIMEOUT_MS = 8_000;

function phoneNumberIdFromUrl(url: URL): string | null {
  const parts = url.pathname.split("/").filter(Boolean);
  const idx = parts.lastIndexOf("whatsapp-flow-endpoint");
  if (idx === -1 || !parts[idx + 1]) return null;
  return parts[idx + 1];
}

function flowCallbackUrl(
  extra: WhatsAppOrganizationAddressExtra,
): string | undefined {
  return extra.flow_data_callback_url ||
    Deno.env.get("LUNA_FLOW_DATA_URL") ||
    undefined;
}

function flowCallbackSecret(): string | undefined {
  return Deno.env.get("LUNA_WEBHOOK_SECRET") || undefined;
}

async function encryptedOk(
  response: FlowDataExchangeResponse,
  aesKey: Uint8Array,
  iv: Uint8Array,
): Promise<Response> {
  const encryptedBody = encryptFlowResponse(response, aesKey, iv);
  return new Response(encryptedBody, {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

async function proxyToLuna(input: {
  callbackUrl: string;
  secret: string;
  phoneNumberId: string;
  organizationId: string;
  payload: FlowDataExchangeRequest;
}): Promise<FlowDataExchangeResponse> {
  const response = await ky.post(input.callbackUrl, {
    json: {
      version: input.payload.version,
      action: input.payload.action,
      screen: input.payload.screen,
      data: input.payload.data ?? {},
      flow_token: input.payload.flow_token,
      phone_number_id: input.phoneNumberId,
      organization_id: input.organizationId,
    },
    headers: { Authorization: `Bearer ${input.secret}` },
    timeout: LUNA_CALLBACK_TIMEOUT_MS,
    throwHttpErrors: false,
  });

  if (response.status === 401) {
    return flowErrorScreen(
      "Session expired. Open the list again.",
      input.payload.screen,
    );
  }
  if (response.status === 404) {
    return flowErrorScreen(
      "Could not find this chat. Open the list again.",
      input.payload.screen,
    );
  }
  if (!response.ok) {
    log.warn("Flow data callback HTTP error", {
      status: response.status,
      phoneNumberId: input.phoneNumberId,
    });
    return flowErrorScreen(
      "Something went wrong. Try again.",
      input.payload.screen,
    );
  }

  const body = await response.json<FlowDataExchangeResponse>();
  if (
    !body?.data ||
    typeof body.data !== "object" ||
    Array.isArray(body.data)
  ) {
    return flowErrorScreen(
      "Something went wrong. Try again.",
      input.payload.screen,
    );
  }
  return body;
}

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const phoneNumberId = phoneNumberIdFromUrl(new URL(request.url));
  if (!phoneNumberId) {
    return new Response("Missing phone_number_id in path", { status: 400 });
  }

  const rawBody = await request.text();
  const secrets = APP_SECRET.split("|").filter(Boolean);
  if (secrets.length) {
    const valid = await validateMetaSignature(
      request.headers.get("X-Hub-Signature-256"),
      rawBody,
      secrets,
    );
    if (!valid) {
      log.warn("Invalid Flow endpoint signature", { phoneNumberId });
      return new Response("Invalid signature", { status: 401 });
    }
  }

  let encrypted: FlowEncryptedRequest;
  try {
    encrypted = JSON.parse(rawBody) as FlowEncryptedRequest;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (
    !encrypted.encrypted_flow_data ||
    !encrypted.encrypted_aes_key ||
    !encrypted.initial_vector
  ) {
    return new Response("Missing encrypted fields", { status: 400 });
  }

  const client = createUnsecureClient();
  const { data: row } = await client
    .from("organizations_addresses")
    .select("organization_id, extra")
    .eq("address", phoneNumberId)
    .eq("service", "whatsapp")
    .eq("status", "connected")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
    .throwOnError();

  if (!row) {
    log.warn("No connected WhatsApp address for Flow endpoint", {
      phoneNumberId,
    });
    return new Response("Unknown phone number", { status: 404 });
  }

  const extra = (row.extra ?? {}) as WhatsAppOrganizationAddressExtra;
  if (!extra.flow_private_key) {
    log.warn("Flow private key not provisioned", { phoneNumberId });
    return new Response("Flow encryption key not provisioned", { status: 421 });
  }

  let decrypted;
  try {
    decrypted = await decryptFlowRequest(encrypted, extra.flow_private_key);
  } catch (error) {
    log.error("Flow request decrypt failed", error);
    return new Response("Decryption failed", { status: 421 });
  }

  const { payload, aesKey, iv } = decrypted;

  try {
    if (payload.action === "ping") {
      return await encryptedOk(
        { version: "3.0", data: { status: "active" } },
        aesKey,
        iv,
      );
    }

    const callbackUrl = flowCallbackUrl(extra);
    const secret = flowCallbackSecret();
    if (!callbackUrl || !secret) {
      log.error("Flow data callback URL or LUNA_WEBHOOK_SECRET missing", {
        phoneNumberId,
      });
      return await encryptedOk(
        flowErrorScreen(
          "Something went wrong. Try again.",
          payload.screen,
        ),
        aesKey,
        iv,
      );
    }

    const clearResponse = await proxyToLuna({
      callbackUrl,
      secret,
      phoneNumberId,
      organizationId: row.organization_id,
      payload,
    });
    return await encryptedOk(clearResponse, aesKey, iv);
  } catch (error) {
    log.error("Flow data callback failed", error);
    try {
      return await encryptedOk(
        flowErrorScreen(
          "Something went wrong. Try again.",
          payload.screen,
        ),
        aesKey,
        iv,
      );
    } catch (encryptError) {
      log.error("Flow response encrypt failed", encryptError);
      return new Response("Encryption failed", { status: 500 });
    }
  }
});
