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

// Pages 1+: AJAX POST to getnewslistinfo.jsp (page 0 handled in syncSebi)
async function getSebiPage(ssid: number, pageIndex: number, jsessionid: string): Promise<SebiListItem[]> {
  // Pages 1+: AJAX POST to getnewslistinfo.jsp
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

const SSID_DOC_TYPE: Record<number, string> = { 6: "master_circular", 3: "regulation" };
const SSID_DEPARTMENT: Record<number, string> = { 6: "Master Circulars", 3: "Regulations", 7: "Circulars" };

export async function syncSebi(ssid: number, maxPages: number, onProgress?: (m: string) => void): Promise<number> {
  // Page 0: single GET that both establishes the session and returns first page listings
  const url = `${SEBI_LIST_BASE}${ssid}&smid=0&nextValue=0`;
  const page0Res = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "text/html,*/*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!page0Res.ok) throw new Error(`SEBI GET failed: HTTP ${page0Res.status}`);
  const cookie = page0Res.headers.get("set-cookie") || "";
  const jsessionid = cookie.match(/JSESSIONID=([^;]+)/)?.[1] ?? "";
  if (!jsessionid) throw new Error("SEBI: failed to obtain JSESSIONID — session cookie absent from page-0 response");

  const doc_type = SSID_DOC_TYPE[ssid] ?? "circular";
  const department = SSID_DEPARTMENT[ssid] ?? "Circulars";
  let total = 0;

  const processPage = async (items: SebiListItem[]) => {
    if (!items.length) return false;
    const newItems = items.filter((it) => !docExists(it.id));
    const rows: DocRow[] = await Promise.all(
      newItems.map((it) => limit(async () => {
        const { body, pdfUrl } = await fetchSebiBody(it);
        await sleep(300);
        return {
          id: it.id, regulator: "SEBI",
          doc_type, title: it.title, date: it.date, department,
          source_url: it.url, pdf_url: pdfUrl, body,
          indexed_at: new Date().toISOString(),
        } as DocRow;
      }))
    );
    if (rows.length) upsertMany(rows);
    total += rows.length;
    await sleep(500);
    return true;
  };

  const page0Items = parseListItems(cheerio.load(await page0Res.text()));
  onProgress?.(`SEBI ssid=${ssid} page 0: ${page0Items.length} docs`);
  await processPage(page0Items);

  for (let page = 1; page < maxPages; page++) {
    const items = await getSebiPage(ssid, page, jsessionid);
    if (!items.length) break;
    onProgress?.(`SEBI ssid=${ssid} page ${page}: ${items.length} docs`);
    await processPage(items);
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
