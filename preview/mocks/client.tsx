import { asks, workspaces } from "../fixtures";

type Contract = { name: string };

export function useRpc(contract: Contract) {
  return async (input: any): Promise<any> => {
    if (contract.name === "asks.list") {
      if (input.workspaceId) return { asks: asks.filter((ask) => ask.workspaceId === input.workspaceId) };
      return { asks, workspaceNames: workspaces };
    }
    if (contract.name === "asks.discuss") return { agentId: "side-chat", created: true };
    const ask = asks.find((candidate) => candidate.workspaceId === input.workspaceId && candidate.id === input.id)!;
    return { ask, notified: true };
  };
}

export async function openExternalUrl(url: string) {
  console.log("openExternalUrl", url);
}
