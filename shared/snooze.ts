/** A workspace as the daemon sends it. Hosts without workspace snooze omit `snoozedAt`. */
export interface SnoozableWorkspace {
  readonly id: string;
  readonly snoozedAt?: string | null;
}

/** One change from the workspace subscription. */
export type WorkspaceChange =
  | { readonly kind: "upsert"; readonly workspace: SnoozableWorkspace }
  | { readonly kind: "remove"; readonly id: string };

/** The daemon clears `snoozedAt` when a snooze ends, so a set `snoozedAt` means snoozed now. */
export function isSnoozed(workspace: SnoozableWorkspace): boolean {
  return workspace.snoozedAt != null;
}

export function snoozedIds(workspaces: readonly SnoozableWorkspace[]): ReadonlySet<string> {
  return new Set(workspaces.filter(isSnoozed).map((workspace) => workspace.id));
}

/** Returns `ids` itself when the change leaves the snoozed set as it was. */
export function applyWorkspaceChange(ids: ReadonlySet<string>, change: WorkspaceChange): ReadonlySet<string> {
  const id = change.kind === "upsert" ? change.workspace.id : change.id;
  const snoozed = change.kind === "upsert" && isSnoozed(change.workspace);
  if (snoozed === ids.has(id)) return ids;
  const next = new Set(ids);
  if (snoozed) next.add(id);
  else next.delete(id);
  return next;
}
