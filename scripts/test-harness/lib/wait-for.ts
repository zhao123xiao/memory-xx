export async function waitFor(
  condition: () => Promise<boolean>,
  options?: { intervalMs?: number; timeoutMs?: number; label?: string },
): Promise<boolean> {
  const intervalMs = options?.intervalMs ?? 2000;
  const timeoutMs = options?.timeoutMs ?? 30000;
  const label = options?.label ?? "condition";
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      if (await condition()) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
