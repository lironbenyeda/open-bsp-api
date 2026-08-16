import { decodeBase64, encodeBase64 } from "jsr:@std/encoding/base64";
import { createCipheriv, createDecipheriv, createPublicKey } from "node:crypto";

export type FlowEncryptedRequest = {
  encrypted_flow_data: string;
  encrypted_aes_key: string;
  initial_vector: string;
};

export type FlowDataExchangeRequest = {
  version: string;
  action: "ping" | "INIT" | "BACK" | "data_exchange";
  screen?: string;
  data?: Record<string, unknown>;
  flow_token?: string;
};

export type FlowDataExchangeResponse = {
  version?: string;
  screen?: string;
  data: Record<string, unknown>;
};

/** Client-visible Flow error. HTTP to Meta should still be 200 + encrypted. */
export function flowErrorScreen(
  message: string,
  screen?: string,
): FlowDataExchangeResponse {
  return {
    screen: screen || Deno.env.get("WHATSAPP_FLOW_ERROR_SCREEN") || "ERROR",
    data: { error_message: message },
  };
}

export function pemToDer(pem: string): Uint8Array {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s/g, "");
  return decodeBase64(b64);
}

export function derToPem(der: ArrayBuffer, label: string): string {
  const b64 = encodeBase64(new Uint8Array(der));
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----`;
}

export function publicKeyPemFromPrivate(privateKeyPem: string): string {
  return createPublicKey(privateKeyPem).export({
    type: "spki",
    format: "pem",
  }).toString();
}

export async function generateFlowKeyPair(): Promise<{
  publicKeyPem: string;
  privateKeyPem: string;
}> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["encrypt", "decrypt"],
  );

  const publicDer = await crypto.subtle.exportKey("spki", pair.publicKey);
  const privateDer = await crypto.subtle.exportKey("pkcs8", pair.privateKey);

  return {
    publicKeyPem: derToPem(publicDer, "PUBLIC KEY"),
    privateKeyPem: derToPem(privateDer, "PRIVATE KEY"),
  };
}

function flipIv(iv: Uint8Array): Uint8Array {
  const flipped = new Uint8Array(iv.length);
  for (let i = 0; i < iv.length; i++) {
    flipped[i] = iv[i] ^ 0xFF;
  }
  return flipped;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** RSA-OAEP SHA-256. Deno 2.1 node:crypto ignores oaepHash and uses SHA-1. */
async function decryptAesKey(
  encryptedAesKeyB64: string,
  privateKeyPem: string,
): Promise<Uint8Array> {
  const pem = privateKeyPem.replaceAll("\\n", "\n").trim();
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToDer(pem) as BufferSource,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["decrypt"],
  );
  const decrypted = await crypto.subtle.decrypt(
    { name: "RSA-OAEP" },
    key,
    decodeBase64(encryptedAesKeyB64) as BufferSource,
  );
  return new Uint8Array(decrypted);
}

/**
 * Meta Flow data API 3.0: RSA-OAEP SHA-256 + AES-128-GCM with a 128-bit IV.
 * AES-GCM stays on node:crypto because Web Crypto rejects Meta's 16-byte IVs.
 */
export async function decryptFlowRequest(
  body: FlowEncryptedRequest,
  privateKeyPem: string,
): Promise<{
  payload: FlowDataExchangeRequest;
  aesKey: Uint8Array;
  iv: Uint8Array;
}> {
  const aesKey = await decryptAesKey(
    body.encrypted_aes_key,
    privateKeyPem,
  );

  const iv = decodeBase64(body.initial_vector);
  const flowData = decodeBase64(body.encrypted_flow_data);
  const encryptedBody = flowData.subarray(0, flowData.length - 16);
  const authTag = flowData.subarray(flowData.length - 16);

  const decipher = createDecipheriv("aes-128-gcm", aesKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = concatBytes(
    new Uint8Array(decipher.update(encryptedBody)),
    new Uint8Array(decipher.final()),
  );

  const payload = JSON.parse(
    new TextDecoder().decode(decrypted),
  ) as FlowDataExchangeRequest;
  return { payload, aesKey, iv };
}

export function encryptFlowResponse(
  response: FlowDataExchangeResponse,
  aesKey: Uint8Array,
  iv: Uint8Array,
): string {
  const cipher = createCipheriv("aes-128-gcm", aesKey, flipIv(iv));
  const encrypted = concatBytes(
    new Uint8Array(cipher.update(new TextEncoder().encode(
      JSON.stringify(response),
    ))),
    new Uint8Array(cipher.final()),
    new Uint8Array(cipher.getAuthTag()),
  );
  return encodeBase64(encrypted);
}

export async function hmacSha256Hex(
  secret: string,
  body: string,
): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(body),
  );
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateMetaSignature(
  header: string | null,
  body: string,
  appSecrets: string[],
): Promise<boolean> {
  if (!header) return false;
  const received = header.replace("sha256=", "").toLowerCase();

  for (const secret of appSecrets) {
    if (!secret) continue;
    const expected = await hmacSha256Hex(secret, body);
    if (expected === received) return true;
  }

  return false;
}
