import { describe, expect, it } from "vitest";
import { findAskCall } from "../server/locate";

type Refetch = Parameters<typeof findAskCall>[0]["refetch"];

const create = (askId: string, seqStart: number) => ({
  seqStart,
  item: {
    type: "tool_call",
    name: "mcp__asks__ask_create",
    status: "completed",
    detail: { type: "unknown", input: { kind: "decision", title: "T" }, output: `${askId} [open] decision: T` },
  },
});
const update = (askId: string, seqStart: number) => ({
  seqStart,
  item: {
    type: "tool_call",
    name: "mcp__asks__ask_update",
    status: "completed",
    detail: { type: "unknown", input: { id: askId, title: "T2" }, output: `${askId} [open] decision: T2` },
  },
});
const text = (seqStart: number) => ({ seqStart, item: { type: "assistant_message", text: "hi" } });

/** Pages newest first; each refetch returns the next older page. */
function source(pages: object[][]) {
  const requests: unknown[] = [];
  const refetch = (async (options) => {
    requests.push(options);
    const index = requests.length - 1;
    return {
      epoch: "e1",
      entries: pages[index] ?? [],
      hasOlder: index < pages.length - 1,
      startCursor: index < pages.length - 1 ? { epoch: "e1", seq: 1000 - index } : null,
    };
  }) as Refetch;
  return { refetch, requests };
}

describe("findAskCall", () => {
  it("finds the latest update, not the create of the same ask", async () => {
    const timeline = source([[text(1), create("A3", 2), update("A3", 5), update("A4", 6), text(7)]]);
    expect(await findAskCall(timeline, "A3")).toEqual({ epoch: "e1", seq: 5 });
  });

  it("skips a later resolve", async () => {
    const resolve = {
      seqStart: 8,
      item: {
        type: "tool_call",
        name: "mcp__asks__ask_resolve",
        status: "completed",
        detail: { type: "unknown", input: { id: "A3" }, output: "A3 [done] decision: T" },
      },
    };
    const timeline = source([[create("A3", 2), resolve]]);
    expect(await findAskCall(timeline, "A3")).toEqual({ epoch: "e1", seq: 2 });
  });

  it("pages back through older history", async () => {
    const timeline = source([[text(50)], [create("A7", 10), create("A8", 20)]]);
    expect(await findAskCall(timeline, "A7")).toEqual({ epoch: "e1", seq: 10 });
    expect(timeline.requests[1]).toMatchObject({ direction: "before", projection: "projected" });
  });

  it("returns null when the timeline never raised it", async () => {
    expect(await findAskCall(source([[create("A1", 1)]]), "A2")).toBeNull();
  });
});
