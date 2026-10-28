import { describe, expect, it } from "vitest";
import { activeWorkspaces } from "../server/workspaces";

type Api = Parameters<typeof activeWorkspaces>[0];

describe("activeWorkspaces", () => {
  it("follows every page and asks for background workspaces too", async () => {
    const pages: Record<string, { ids: string[]; next: string | null }> = {
      "": { ids: ["wks_1", "wks_2"], next: "c1" },
      c1: { ids: ["wks_3"], next: null },
    };
    const requests: unknown[] = [];
    const api = {
      workspaces: {
        list: async (options: { page: { cursor?: string } }) => {
          requests.push(options);
          const page = pages[options.page.cursor ?? ""];
          return {
            entries: page.ids.map((id) => ({ id, name: `name of ${id}` })),
            pageInfo: { hasMore: page.next !== null, nextCursor: page.next },
          };
        },
      },
    } as unknown as Api;

    const live = await activeWorkspaces(api);

    expect([...live]).toEqual([
      ["wks_1", "name of wks_1"],
      ["wks_2", "name of wks_2"],
      ["wks_3", "name of wks_3"],
    ]);
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({ includeBackground: true, filter: { includeBackground: true } });
  });
});
