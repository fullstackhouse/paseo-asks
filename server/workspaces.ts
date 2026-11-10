import type { PaseoApi } from "@getpaseo/client";

const PAGE = 200;

/** Workspace id → name for visible workspaces; background and archived ones are absent. */
export async function activeWorkspaces(
  api: Pick<PaseoApi, "workspaces">,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await api.workspaces.list({
      page: { limit: PAGE, cursor },
    });
    for (const workspace of entries) names.set(workspace.id, workspace.name);
    cursor = pageInfo.hasMore ? (pageInfo.nextCursor ?? undefined) : undefined;
  } while (cursor);
  return names;
}
