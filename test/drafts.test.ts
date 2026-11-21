import { describe, expect, it } from "vitest";
import { readDraft, writeDraft } from "../client/drafts";

describe("reply drafts", () => {
  it("keeps a half-written reply after its box is gone", () => {
    writeDraft("w1", "A1", "half a thought");
    expect(readDraft("w1", "A1")).toBe("half a thought");
  });

  it("keeps drafts apart per workspace, since ask ids repeat across workspaces", () => {
    writeDraft("w1", "A2", "for one");
    writeDraft("w2", "A2", "for two");
    expect(readDraft("w1", "A2")).toBe("for one");
    expect(readDraft("w2", "A2")).toBe("for two");
  });

  it("forgets a draft once it is cleared (sent)", () => {
    writeDraft("w1", "A3", "sending this");
    writeDraft("w1", "A3", "");
    expect(readDraft("w1", "A3")).toBe("");
  });
});
