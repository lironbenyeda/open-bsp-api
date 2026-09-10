import { assertEquals } from "jsr:@std/assert@1";
import {
  FORWARDED_DEBOUNCE_SECONDS,
  lunaWhatsAppBatchDebounceSecondsForMessage,
  planSiblingOpenBatchUpdates,
  resolveAbsorbMessageIds,
  SIBLING_CREATED_WITHIN_MS,
  SIBLING_TIMESTAMP_WINDOW_MS,
} from "./luna-whatsapp-batch.ts";
import type { MessageRow } from "./supabase.ts";

function incomingText(opts: {
  id?: string;
  forwarded?: boolean;
  text?: string;
}): MessageRow {
  return {
    id: opts.id ?? crypto.randomUUID(),
    organization_id: "org",
    organization_address: "addr",
    contact_address: "972546646282",
    conversation_id: "conv",
    group_address: null,
    thread_id: null,
    service: "whatsapp",
    direction: "incoming",
    external_id: "wamid.test",
    timestamp: "2026-09-09T16:20:37Z",
    created_at: "2026-09-09T16:20:37Z",
    updated_at: "2026-09-09T16:20:37Z",
    agent_id: null,
    status: {},
    content: {
      version: "1",
      type: "text",
      kind: "text",
      text: opts.text ?? "hello",
      ...(opts.forwarded ? { forwarded: true } : {}),
    },
  } as unknown as MessageRow;
}

function incomingButton(): MessageRow {
  return {
    ...incomingText({}),
    content: {
      version: "1",
      type: "data",
      kind: "button",
      data: { payload: "yes", text: "Yes" },
    },
  } as unknown as MessageRow;
}

Deno.test("debounce: normal text flushes immediately", () => {
  assertEquals(lunaWhatsAppBatchDebounceSecondsForMessage(incomingText({})), 0);
});

Deno.test("debounce: forwarded text waits 2s", () => {
  assertEquals(
    lunaWhatsAppBatchDebounceSecondsForMessage(
      incomingText({ forwarded: true }),
    ),
    FORWARDED_DEBOUNCE_SECONDS,
  );
  assertEquals(FORWARDED_DEBOUNCE_SECONDS, 2);
});

Deno.test("debounce: button tap flushes immediately", () => {
  assertEquals(lunaWhatsAppBatchDebounceSecondsForMessage(incomingButton()), 0);
});

Deno.test(
  "absorb: two regular same-Meta-second texts merge (e.g. copy-paste burst)",
  () => {
    const now = Date.parse("2026-09-09T16:20:41Z");
    const ts = "2026-09-09T16:20:37Z";
    const created = "2026-09-09T16:20:37.050Z";
    // Debounce is 0 for both (not forwarded); merge happens at flush via absorb.
    assertEquals(
      lunaWhatsAppBatchDebounceSecondsForMessage(
        incomingText({ text: "line one" }),
      ),
      0,
    );
    assertEquals(
      lunaWhatsAppBatchDebounceSecondsForMessage(
        incomingText({ text: "line two" }),
      ),
      0,
    );
    const result = resolveAbsorbMessageIds({
      claimedMessageIds: ["msg-1"],
      batchTimestampsById: new Map([
        ["msg-1", ts],
        ["msg-2", ts],
      ]),
      candidates: [
        { id: "msg-1", created_at: created },
        { id: "msg-2", created_at: created },
      ],
      alreadySentIds: new Set(),
      busyIds: new Set(),
      openBatchMessageIds: new Set(),
      nowMs: now,
    });
    assertEquals(result, ["msg-1", "msg-2"]);
  },
);

Deno.test("absorb: merges same-second fresh sibling (Sep 9 forward+follow-up)", () => {
  const now = Date.parse("2026-09-09T16:20:41Z");
  const ts = "2026-09-09T16:20:37Z";
  const created = "2026-09-09T16:20:37.100Z";
  const result = resolveAbsorbMessageIds({
    claimedMessageIds: ["msg-forward"],
    batchTimestampsById: new Map([
      ["msg-forward", ts],
      ["msg-followup", ts],
    ]),
    candidates: [
      { id: "msg-forward", created_at: created },
      { id: "msg-followup", created_at: created },
    ],
    alreadySentIds: new Set(),
    busyIds: new Set(),
    openBatchMessageIds: new Set(),
    nowMs: now,
  });
  assertEquals(result, ["msg-forward", "msg-followup"]);
});

Deno.test("absorb: merges sibling still sitting in another open batch", () => {
  const now = Date.parse("2026-09-09T16:20:41Z");
  const ts = "2026-09-09T16:20:37Z";
  const result = resolveAbsorbMessageIds({
    claimedMessageIds: ["msg-forward"],
    batchTimestampsById: new Map([
      ["msg-forward", ts],
      ["msg-followup", ts],
    ]),
    candidates: [
      { id: "msg-followup", created_at: "2026-09-09T16:10:00Z" }, // old created_at
    ],
    alreadySentIds: new Set(),
    busyIds: new Set(),
    openBatchMessageIds: new Set(["msg-followup"]),
    nowMs: now,
  });
  assertEquals(result, ["msg-forward", "msg-followup"]);
});

Deno.test("absorb: does not resurrect old already-sent history", () => {
  const now = Date.parse("2026-09-09T16:20:41Z");
  const ts = "2026-09-09T16:20:37Z";
  const result = resolveAbsorbMessageIds({
    claimedMessageIds: ["msg-new"],
    batchTimestampsById: new Map([
      ["msg-new", ts],
      ["msg-old", ts],
    ]),
    candidates: [
      {
        id: "msg-old",
        // Outside freshness window and not in an open batch.
        created_at: new Date(now - SIBLING_CREATED_WITHIN_MS - 1_000)
          .toISOString(),
      },
    ],
    alreadySentIds: new Set(),
    busyIds: new Set(),
    openBatchMessageIds: new Set(),
    nowMs: now,
  });
  assertEquals(result, ["msg-new"]);
});

Deno.test("absorb: skips ids already in a recent sent batch", () => {
  const now = Date.parse("2026-09-09T16:20:41Z");
  const ts = "2026-09-09T16:20:37Z";
  const result = resolveAbsorbMessageIds({
    claimedMessageIds: ["msg-a"],
    batchTimestampsById: new Map([
      ["msg-a", ts],
      ["msg-b", ts],
    ]),
    candidates: [
      { id: "msg-b", created_at: "2026-09-09T16:20:37Z" },
    ],
    alreadySentIds: new Set(["msg-b"]),
    busyIds: new Set(["msg-b"]),
    openBatchMessageIds: new Set(),
    nowMs: now,
  });
  assertEquals(result, ["msg-a"]);
});

Deno.test("absorb: empty when claimed ids were already sent", () => {
  const result = resolveAbsorbMessageIds({
    claimedMessageIds: ["msg-a"],
    batchTimestampsById: new Map([["msg-a", "2026-09-09T16:20:37Z"]]),
    candidates: [],
    alreadySentIds: new Set(["msg-a"]),
    busyIds: new Set(["msg-a"]),
    openBatchMessageIds: new Set(),
  });
  assertEquals(result, "empty");
});

Deno.test("absorb: ignores candidate outside ±1s Meta window", () => {
  const now = Date.parse("2026-09-09T16:20:41Z");
  const ts = "2026-09-09T16:20:37Z";
  const far = new Date(Date.parse(ts) + SIBLING_TIMESTAMP_WINDOW_MS + 500)
    .toISOString();
  const result = resolveAbsorbMessageIds({
    claimedMessageIds: ["msg-a"],
    batchTimestampsById: new Map([
      ["msg-a", ts],
      ["msg-far", far],
    ]),
    candidates: [
      { id: "msg-far", created_at: "2026-09-09T16:20:40Z" },
    ],
    alreadySentIds: new Set(),
    busyIds: new Set(),
    openBatchMessageIds: new Set(),
    nowMs: now,
  });
  assertEquals(result, ["msg-a"]);
});

Deno.test("open-batch plan: cancels fully absorbed sibling batch", () => {
  assertEquals(
    planSiblingOpenBatchUpdates(
      [{ id: "batch-b", message_ids: ["msg-followup"] }],
      new Set(["msg-forward", "msg-followup"]),
    ),
    [{ type: "cancel", id: "batch-b" }],
  );
});

Deno.test("open-batch plan: trims partial overlap", () => {
  assertEquals(
    planSiblingOpenBatchUpdates(
      [{ id: "batch-b", message_ids: ["msg-followup", "msg-other"] }],
      new Set(["msg-forward", "msg-followup"]),
    ),
    [{
      type: "trim",
      id: "batch-b",
      message_ids: ["msg-other"],
    }],
  );
});

Deno.test("open-batch plan: no-op when no overlap", () => {
  assertEquals(
    planSiblingOpenBatchUpdates(
      [{ id: "batch-b", message_ids: ["msg-other"] }],
      new Set(["msg-forward"]),
    ),
    [],
  );
});
