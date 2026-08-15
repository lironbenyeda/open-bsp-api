import { HTTPException } from "jsr:@hono/hono/http-exception";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../_shared/supabase.ts";
import type { WhatsAppOrganizationAddressExtra } from "../_shared/supabase.ts";
import {
  generateFlowKeyPair,
  publicKeyPemFromPrivate,
} from "../_shared/whatsapp-flows.ts";
import { functionsBaseUrl } from "../_shared/urls.ts";
import * as log from "../_shared/logger.ts";

const API_VERSION = "v24.0";
const DEFAULT_ACCESS_TOKEN = Deno.env.get("META_SYSTEM_USER_ACCESS_TOKEN") ||
  "";

export function flowDataEndpointUri(phoneNumberId: string): string {
  return `${functionsBaseUrl()}/whatsapp-flow-endpoint/${phoneNumberId}`;
}

export async function provisionFlowEncryption(
  client: SupabaseClient<Database>,
  organizationId: string,
  organizationAddress: string,
): Promise<{
  endpoint_uri: string;
  public_key: string;
  uploaded: boolean;
}> {
  const { data: row } = await client
    .from("organizations_addresses")
    .select("extra")
    .eq("organization_id", organizationId)
    .eq("address", organizationAddress)
    .eq("service", "whatsapp")
    .single()
    .throwOnError();

  const extra = (row.extra ?? {}) as WhatsAppOrganizationAddressExtra;
  const accessToken = extra.access_token || DEFAULT_ACCESS_TOKEN;
  if (!accessToken) {
    throw new HTTPException(400, {
      message: "No WhatsApp access token for this address",
    });
  }

  if (extra.flow_private_key) {
    return {
      endpoint_uri: flowDataEndpointUri(organizationAddress),
      public_key: publicKeyPemFromPrivate(extra.flow_private_key),
      uploaded: true,
    };
  }

  const { publicKeyPem, privateKeyPem } = await generateFlowKeyPair();

  const response = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${organizationAddress}/whatsapp_business_encryption`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ business_public_key: publicKeyPem }),
    },
  );

  if (!response.ok) {
    const cause = await response.json().catch(() => ({}));
    log.error("Failed to upload Flow public key", cause);
    throw new HTTPException(502, {
      message: "Could not upload Flow public key to Meta",
      cause,
    });
  }

  await client
    .from("organizations_addresses")
    .update({
      extra: {
        flow_private_key: privateKeyPem,
        flow_public_key_uploaded_at: new Date().toISOString(),
      },
    })
    .eq("organization_id", organizationId)
    .eq("address", organizationAddress)
    .throwOnError();

  return {
    endpoint_uri: flowDataEndpointUri(organizationAddress),
    public_key: publicKeyPem,
    uploaded: true,
  };
}
