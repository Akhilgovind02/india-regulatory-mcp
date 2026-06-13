import * as cheerio from "cheerio";
import TurndownService from "turndown";
import pLimit from "p-limit";
import { politeFetch, sleep } from "../util/http.js";
import { upsertMany, docExists } from "../db/queries.js";
import type { DocRow } from "../db/queries.js";

const td = new TurndownService();
const limit = pLimit(2);

const UA = "india-reg-mcp/1.0 (open-source regulatory indexer)";
// ssid: 7=circulars, 6=master circulars, 3=regulations
const SEBI_LIST_BASE = "https://www.sebi.gov.in/sebiweb/home/HomeAction.do?doListing=yes&sid=1&ssid=";
const SEBI_AJAX = "https://www.sebi.gov.in/sebiweb/ajax/home/getnewslistinfo.jsp";

interface SebiListItem { id: string; title: string; date: string; url: string; }

function parseListItems($: ReturnType<typeof cheerio.load>): SebiListItem[] {
  const items: SebiListItem[] = [];
  $("table tr").each((_, tr) => {
    const $tr = $(tr);
    const link = $tr.find('a[href*="/legal/"]').first();
    if (!link.length) return;
    const href = link.attr("href") || "";
    const idMatch = href.match(/_(\d+)\.html/);
    if (!idMatch) return;
    const dateCell = $tr.find("td").first().text().trim();
    items.push({
      id: `sebi:${idMatch[1]}`,
      title: link.text().trim(),
      date: toISO(dateCell),
      url: absolute(href, "https://www.sebi.gov.in/"),
    });
  });
  return items;
}

async function getSebiPage(ssid: number, pageIndex: number, jsessionid: string): Promise<SebiListItem[]> {
  if (pageIndex === 0) {
    // First page: GET request (also establishes session)
    const url = `${SEBI_LIST_BASE}${ssid}&smid=0&nextValue=0`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html,*/*" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`SEBI GET failed: HTTP ${res.status}`);
    return parseListItems(cheerio.load(await res.text()));
  }

  // Pages 2+: AJAX POST to getnewslistinfo.jsp
  const body = new URLSearchParams({
    nextValue: "1",
    next: "n",
    search: "", fromDate: "", toDate: "", fromYear: "", toYear: "",
    deptId: "",
    sid: "1", ssid: String(ssid), smid: "0", ssidhidden: String(ssid),
    intmid: "-1",
    sText: "Legal", ssText: ssid === 7 ? "Circulars" : ssid === 6 ? "Master Circulars" : "Regulations",
    smText: "",
    doDirect: String(pageIndex),
  });

  const res = await fetch(SEBI_AJAX, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Content-Type": "application/x-www-form-urlencoded",
      "Cookie": `JSESSIONID=${jsessionid}`,
      "Referer": `${SEBI_LIST_BASE}${ssid}&smid=0&nextValue=0`,
      "Accept": "*/*",
      "X-Requested-With": "XMLHttpRequest",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`SEBI AJAX failed: HTTP ${res.status}`);
  return parseListItems(cheerio.load(await res.text()));
}

async function getSebiSession(ssid: number): Promise<string> {
  const url = `${SEBI_LIST_BASE}${ssid}&smid=0&nextValue=0`;
  const res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,*/*" },
    signal: AbortSignal.timeout(30_000),
  });
  const cookie = res.headers.get("set-cookie") || "";
  return cookie.match(/JSESSIONID=([^;]+)/)?.[1] ?? "";
}

async function fetchSebiBody(item: SebiListItem): Promise<{ body: string; pdfUrl: string | null }> {
  try {
    const res = await politeFetch(item.url);
    const $ = cheerio.load(await res.text());

    // SEBI pages embed content as PDF in an iframe — src may have absolute or relative PDF path
    // e.g. ?file=https://www.sebi.gov.in/sebi_data/... or ?file=/sebi_data/...
    const iframeSrc = $("iframe[src*='sebi_data'], iframe[src*='?file=']").first().attr("src") || "";
    const pdfUrlMatch = iframeSrc.match(/[?&]file=((?:https?:\/\/|\/)[^'"&\s]+\.pdf)/i);
    const rawPdfPath = pdfUrlMatch ? pdfUrlMatch[1] : null;
    const pdfUrl = rawPdfPath
      ? rawPdfPath.startsWith("/") ? `https://www.sebi.gov.in${rawPdfPath}` : rawPdfPath
      : null;

    if (pdfUrl) {
      const { extractPdfText } = await import("./pdf.js");
      const body = await extractPdfText(pdfUrl);
      return { body, pdfUrl };
    }

    // Fallback: extract any visible text from the page
    const main = $(".main_section, .news-detail-slider, #member-wrapper").first();
    const bodyHtml = main.length ? main.html() : $("body").html();
    return { body: bodyHtml ? td.turndown(bodyHtml) : "", pdfUrl: null };
  } catch {
    return { body: "", pdfUrl: null };
  }
}

export async function syncSebi(ssid: number, maxPages: number, onProgress?: (m: string) => void): Promise<number> {
  const jsessionid = await getSebiSession(ssid);
  let total = 0;

  for (let page = 0; page < maxPages; page++) {
    const items = await getSebiPage(ssid, page, jsessionid);
    if (!items.length) break;
    onProgress?.(`SEBI ssid=${ssid} page ${page}: ${items.length} docs`);

    const newItems = items.filter((it) => !docExists(it.id));

    const rows: DocRow[] = await Promise.all(
      newItems.map((it) => limit(async () => {
        const { body, pdfUrl } = await fetchSebiBody(it);
        await sleep(300);
        return {
          id: it.id, regulator: "SEBI",
          doc_type: ssid === 6 ? "master_circular" : ssid === 3 ? "regulation" : "circular",
          title: it.title, date: it.date, department: null,
          source_url: it.url, pdf_url: pdfUrl, body,
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

function toISO(s: string): string {
  const d = new Date(s.replace(/(\w{3})\s+(\d{1,2}),\s+(\d{4})/, "$1 $2 $3"));
  return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
}

function absolute(href: string, base: string): string {
  return href.startsWith("http") ? href : new URL(href, base).toString();
}
