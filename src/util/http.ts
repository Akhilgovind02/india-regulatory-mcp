const UA = "india-reg-mcp/1.0 (open-source regulatory indexer; +https://github.com/yourusername/india-reg-mcp)";

export async function politeFetch(url: string, retries = 2): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept": "text/html,application/pdf,*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return res;
      if (res.status === 429 || res.status >= 500) {
        await sleep(1000 * (attempt + 1)); continue;
      }
      throw new Error(`HTTP ${res.status} for ${url}`);
    } catch (e) {
      if (attempt === retries) throw e;
      await sleep(1000 * (attempt + 1));
    }
  }
  throw new Error(`Failed after ${retries} retries: ${url}`);
}

export function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
