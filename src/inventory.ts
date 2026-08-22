/**
 * Private host-to-service notes supplied as HOST_SERVICES at runtime.
 *
 * Shape: {"<host>":["<service>"]}. The value is a Worker secret rather than
 * a wrangler var so its contents never need to be committed.
 */
export function hostServices(raw: string | undefined): Record<string, string[]> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const clean: Record<string, string[]> = {};
    for (const [host, value] of Object.entries(parsed)) {
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(host) || !Array.isArray(value)) continue;
      const services = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
        .slice(0, 50);
      clean[host] = [...new Set(services)];
    }
    return clean;
  } catch {
    return {};
  }
}
