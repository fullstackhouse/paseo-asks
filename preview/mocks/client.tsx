import { asks, workspaces } from "../fixtures";

type Contract = { name: string };

export function useRpc(contract: Contract) {
  return async (input: any): Promise<any> => {
    if (contract.name === "asks.list") {
      return { asks: asks.filter((ask) => !input.workspaceId || ask.workspaceId === input.workspaceId) };
    }
    if (contract.name === "asks.discuss") return { agentId: "side-chat", created: true };
    const ask = asks.find((candidate) => candidate.workspaceId === input.workspaceId && candidate.id === input.id)!;
    return { ask, notified: true };
  };
}

export function useWorkspace<T>(id: string, select: (workspace: { name: string; title: string | null }) => T): T {
  return select({ name: workspaces[id] ?? id, title: workspaces[id] ?? null });
}

export async function openExternalUrl(url: string) {
  console.log("openExternalUrl", url);
}
