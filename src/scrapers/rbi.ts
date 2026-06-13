import * as cheerio from "cheerio";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { politeFetch, sleep } from "../util/http.js";
import { extractPdfText } from "./pdf.js";
import { upsertMany, docExists } from "../db/queries.js";
import type { DocRow } from "../db/queries.js";

const td = new TurndownService();
const limit = pLimit(2);

const RBI_BASE = "https://rbi.org.in/Scripts/NotificationUser.aspx";

interface RbiListItem { id: string; title: string; date: string; htmlUrl: string; pdfUrl: string | null; }
interface ViewstateTokens { vs: string; vsg: string; ev: string; }

async function fetchViewstateTokens(): Promise<ViewstateTokens> {
  const res = await politeFetch(RBI_BASE);
  const html = await res.text();
  return {
    vs:  html.match(/id="__VIEWSTATE"\s+value="([^"]+)"/)?.[1] ?? "",
    vsg: html.match(/id="__VIEWSTATEGENERATOR"\s+value="([^"]+)"/)?.[1] ?? "",
    ev:  html.match(/id="__EVENTVALIDATION"\s+value="([^"]+)"/)?.[1] ?? "",
  };
}

// Scrape one month via POST (month: 1-12, or 0 = all)
export async function scrapeRbiMonth(year: number, month: number, tokens?: ViewstateTokens): Promise<RbiListItem[]> {
  const t = tokens ?? await fetchViewstateTokens();

  const body = new URLSearchParams({
    __VIEWSTATE: t.vs,
    __VIEWSTATEGENERATOR: t.vsg,
    __EVENTVALIDATION: t.ev,
    hdnYear: String(year),
    hdnMonth: String(month),
    "UsrFontCntr$btn": "",
  });

  let res: Response | undefined;
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      res = await fetch(RBI_BASE, {
        method: "POST",
        headers: {
          "User-Agent": "india-reg-mcp/1.0 (open-source regulatory indexer)",
          "Content-Type": "application/x-www-form-urlencoded",
          "Referer": RBI_BASE,
          "Accept": "text/html,*/*",
        },
        body: body.toString(),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) break;
      if (res.status === 429 || res.status >= 500) {
        await sleep(2000 * (attempt + 1));
        continue;
      }
      throw new Error(`RBI POST failed: HTTP ${res.status}`);
    } catch (e) {
      if (attempt === 2) throw e;
      await sleep(2000 * (attempt + 1));
    }
  }
  if (!res?.ok) throw new Error(`RBI POST failed after retries`);

  const html = await res.text();
  if (html.includes("No Notification Found")) return [];

  const $ = cheerio.load(html);
  const items: RbiListItem[] = [];
  let currentDate = "";

  $("table tr").each((_, tr) => {
    const $tr = $(tr);
    const text = $tr.text().trim();
    const dateMatch = text.match(/^([A-Z][a-z]{2}\s+\d{1,2},\s+\d{4})$/);
    if (dateMatch) { currentDate = toISO(dateMatch[1]); return; }

    const titleLink = $tr.find('a[href*="NotificationUser.aspx?Id="]').first();
    if (titleLink.length) {
      const href = titleLink.attr("href") || "";
      const idMatch = href.match(/Id=(\d+)/);
      if (!idMatch) return;
      const pdfLink = $tr.find('a[href*=".PDF"], a[href*=".pdf"]').first();
      items.push({
        id: `rbi:${idMatch[1]}`,
        title: titleLink.text().trim(),
        date: currentDate,
        htmlUrl: absolute(href, "https://rbi.org.in/Scripts/"),
        pdfUrl: pdfLink.length ? (pdfLink.attr("href") || null) : null,
      });
    }
  });
  return items;
}

async function fetchRbiBody(item: RbiListItem): Promise<string> {
  try {
    const res = await politeFetch(item.htmlUrl);
    const $ = cheerio.load(await res.text());
    // #pnlDetails is the main content container on RBI ASP.NET doc pages
    const main = $("#pnlDetails, #example-min, table.tablebg").first();
    const bodyHtml = main.length ? main.html() : $("body").html();
    let markdown = bodyHtml ? td.turndown(bodyHtml) : "";
    if (markdown.length < 200 && item.pdfUrl) markdown = await extractPdfText(item.pdfUrl);
    return markdown;
  } catch {
    return item.pdfUrl ? await extractPdfText(item.pdfUrl) : "";
  }
}

export async function syncRbi(monthsBack: number, onProgress?: (msg: string) => void): Promise<number> {
  const tokens = await fetchViewstateTokens();
  const now = new Date();
  let total = 0;

  for (let i = 0; i < monthsBack; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = d.getFullYear();
    const month = d.getMonth() + 1; // 1-indexed to match GetYearMonth JS

    let items: RbiListItem[];
    try {
      items = await scrapeRbiMonth(year, month, tokens);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      onProgress?.(`RBI ${year}-${month}: fetch failed (${msg}), skipping`);
      await sleep(3000);
      continue;
    }
    onProgress?.(`RBI ${year}-${month}: ${items.length} docs found`);

    const newItems = items.filter((it) => !docExists(it.id));

    const rows: DocRow[] = await Promise.all(
      newItems.map((it) => limit(async () => {
        const body = await fetchRbiBody(it);
        await sleep(300);
        return {
          id: it.id, regulator: "RBI",
          doc_type: classifyRbi(it.title),
          title: it.title, date: it.date, department: null,
          source_url: it.htmlUrl, pdf_url: it.pdfUrl, body,
          indexed_at: new Date().toISOString(),
        } as DocRow;
      }))
    );
    if (rows.length) upsertMany(rows);
    total += rows.length;
    await sleep(500);
  }
  return total;
}

function classifyRbi(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("master direction")) return "master_direction";
  if (t.includes("master circular")) return "master_circular";
  if (t.includes("regulations")) return "regulation";
  return "notification";
}

function toISO(s: string): string {
  const d = new Date(s);
  return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
}

function absolute(href: string, base: string): string {
  if (href.startsWith("http")) return href;
  return new URL(href, base).toString();
}
