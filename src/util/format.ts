export const DISCLAIMER = "Source: official RBI/SEBI publications. This is primary-source retrieval, not legal advice. Verify against the linked official document.";

export function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function err(m: string) {
  return { content: [{ type: "text" as const, text: `Error: ${m}` }] };
}

export function emptyDbMsg() {
  return ok({ message: "The regulatory index is empty. Run 'npm run sync' first, or call the sync_latest tool to populate it.", disclaimer: DISCLAIMER });
}
