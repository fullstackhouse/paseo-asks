import { describe, expect, it } from "vitest";
import { instructions } from "../shared/instructions";
import { agentSettings } from "../shared/settings";

describe("agent instructions", () => {
  it("keeps the follow-up rule on Default and adds a rule on More", () => {
    const base = instructions();
    expect(instructions({ frequency: "default" })).toBe(base);
    expect(base).toContain("Follow-ups count even when nothing blocks you");
    expect(instructions({ frequency: "more" })).toContain("Follow-ups count even when nothing blocks you");
    expect(instructions({ frequency: "more" })).toContain("When unsure, ask, even about small choices.");
  });

  it("swaps the follow-up rule for an ask-less rule on Fewer", () => {
    const fewer = instructions({ frequency: "fewer" });
    expect(fewer).not.toContain("Follow-ups count");
    expect(fewer).toContain("Make reversible choices with a clear default yourself");
    // Only that line changes.
    const others = (text: string) => text.split("\n").filter((line) => !line.startsWith("- Follow-ups") && !line.startsWith("- Ask less"));
    expect(others(fewer)).toEqual(others(instructions()));
  });

  it("defaults a missing settings document to Default", () => {
    expect(agentSettings.schema.parse({})).toEqual({ frequency: "default" });
  });
});

describe("nudge classifier prompts", async () => {
  const { CLASSIFIER_PROMPT, CLASSIFIER_PROMPTS, FEWER_CLASSIFIER_PROMPT } = await import("../server/nudge");

  it("counts mentioned further work as a miss only outside Fewer", () => {
    expect(CLASSIFIER_PROMPT).toContain("that is a follow-up for the human to approve");
    expect(FEWER_CLASSIFIER_PROMPT).not.toContain("follow-up for the human to approve");
    expect(FEWER_CLASSIFIER_PROMPT).toContain("doesn't count");
    expect(CLASSIFIER_PROMPTS.has(CLASSIFIER_PROMPT) && CLASSIFIER_PROMPTS.has(FEWER_CLASSIFIER_PROMPT)).toBe(true);
  });
});
