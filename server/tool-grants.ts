/** A provider snapshot as far as tool grants go; `supportsToolPolicy` is missing on hosts before it. */
export interface ProviderGrantSnapshot {
  entries: Array<{ provider: string; supportsToolPolicy?: boolean }>;
}

/**
 * COMPAT(pluginToolGrants): hosts before fullstackhouse/paseo#288 don't report `supportsToolPolicy`
 * and reject `toolPolicy` on every provider but these. Remove after 2027-05-31.
 */
const EXACT_GRANT_PROVIDERS = new Set(["claude", "codex", "opencode"]);

/**
 * Whether agents on a provider can hold exact MCP tool grants, as the host reports it. The snapshot is
 * read at most once a minute; a failed read or an older host falls back to the providers above.
 */
export function toolGrantSupport(
  readSnapshot: () => Promise<ProviderGrantSnapshot>,
  now: () => number = Date.now,
  ttlMs = 60_000,
): (provider: string) => Promise<boolean> {
  let cached: { at: number; support: Map<string, boolean> } | null = null;
  return async (provider) => {
    const id = provider.split("/")[0] ?? provider;
    if (!cached || now() - cached.at >= ttlMs) {
      const support = new Map<string, boolean>();
      try {
        for (const entry of (await readSnapshot()).entries) {
          if (typeof entry.supportsToolPolicy === "boolean") support.set(entry.provider, entry.supportsToolPolicy);
        }
      } catch {
        // Keep the fallback below; the next create after the TTL tries again.
      }
      cached = { at: now(), support };
    }
    return cached.support.get(id) ?? EXACT_GRANT_PROVIDERS.has(id);
  };
}
