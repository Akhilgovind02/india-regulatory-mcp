/**
 * Backfill body text for docs that were indexed without body content.
 * Run with: npx tsx src/scrapers/repair-bodies.ts
 */
import { initSchema } from "../db/schema.js";
import { db } from "../db/schema.js";
import { sleep } from "../util/http.js";
import pLimit from "p-limit";

// Import body fetchers directly
import * as cheerio from "cheerio";
import TurndownService from "turndown";
import { politeFetch } from "../util/http.js";
import { PDFParse } from "pdf-parse";

initSchema();
const td = new TurndownService();
const limit = pLimit(2);
const log = (m: string) => console.error(`[repair] ${m}`);

async function fetchRbiBody(sourceUrl: string): Promise<string> {
  try {
    const res = await politeFetch(sourceUrl);
    const $ = cheerio.load(await res.text());
    const main = $("#pnlDetails, #example-min, table.tablebg").first();
    const bodyHtml = main.length ? main.html() : $("body").html();
    return bodyHtml ? td.turndown(bodyHtml) : "";
  } catch {
    return "";
  }
}

async function fetchSebiBody(sourceUrl: string): Promise<{ body: string; pdfUrl: string | null }> {
  try {
    const res = await politeFetch(sourceUrl);
    const $ = cheerio.load(await res.text());
    const iframeSrc = $("iframe[src*='sebi_data'], iframe[src*='?file=']").first().attr("src") || "";
    const pdfUrlMatch = iframeSrc.match(/[?&]file=((?:https?:\/\/|\/)[^'"&\s]+\.pdf)/i);
    const rawPdfPath = pdfUrlMatch ? pdfUrlMatch[1] : null;
    const pdfUrl = rawPdfPath
      ? rawPdfPath.startsWith("/") ? `https://www.sebi.gov.in${rawPdfPath}` : rawPdfPath
      : null;
    if (pdfUrl) {
      const buf = Buffer.from(await (await politeFetch(pdfUrl)).arrayBuffer());
      const parser = new PDFParse({ data: buf });
      const result = await parser.getText();
      const text = result.text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
      return { body: text, pdfUrl };
    }
    return { body: "", pdfUrl: null };
  } catch {
    return { body: "", pdfUrl: null };
  }
}

const updateStmt = db.prepare("UPDATE documents SET body=@body, pdf_url=@pdf_url, indexed_at=@indexed_at WHERE id=@id");

// Get all docs with empty body
interface DocRecord { id: string; regulator: string; source_url: string; }
const docs = db.prepare(
  "SELECT id, regulator, source_url FROM documents WHERE body IS NULL OR body = '' OR (regulator='SEBI' AND LENGTH(body) < 2000) ORDER BY date DESC"
).all() as DocRecord[];

log(`Found ${docs.length} docs needing body repair`);

let done = 0;
let failed = 0;

await Promise.all(
  docs.map((doc) => limit(async () => {
    try {
      let body = "";
      let pdfUrl: string | null = null;

      if (doc.regulator === "RBI") {
        body = await fetchRbiBody(doc.source_url);
      } else {
        const result = await fetchSebiBody(doc.source_url);
        body = result.body;
        pdfUrl = result.pdfUrl;
      }

      updateStmt.run({ id: doc.id, body, pdf_url: pdfUrl, indexed_at: new Date().toISOString() });
      done++;
      if (done % 20 === 0) log(`Progress: ${done}/${docs.length} done`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Failed ${doc.id}: ${msg}`);
      failed++;
    }
    await sleep(300);
  }))
);

log(`Done. ${done} updated, ${failed} failed.`);

// Show updated stats
const stats = db.prepare(
  "SELECT regulator, SUM(CASE WHEN body IS NULL OR body='' THEN 1 ELSE 0 END) as no_body, COUNT(*) as total FROM documents GROUP BY regulator"
).all() as { regulator: string; no_body: number; total: number }[];
stats.forEach(s => log(`${s.regulator}: ${s.total - s.no_body}/${s.total} have body`));

process.exit(0);
