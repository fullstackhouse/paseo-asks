import { openExternalUrl } from "@getpaseo/plugin/client";

export function openLink(url: string): void {
  void openExternalUrl(url).catch((error) => console.error("[asks] could not open", url, error));
}
