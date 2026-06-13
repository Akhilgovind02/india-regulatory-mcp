import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initSchema } from "./db/schema.js";
import * as q from "./db/queries.js";
import { syncRbi } from "./scrapers/rbi.js";
import { syncSebi } from "./scrapers/sebi.js";
import { DISCLAIMER, ok, err, emptyDbMsg } from "./util/format.js";

initSchema();

const server = new McpServer({ name: "india-reg-mcp", version: "1.0.0" });

server.tool(
  "search_regulations",
  "Full-text search across indexed RBI and SEBI regulatory documents (circulars, master directions, notifications, regulations). " +
  "Returns matching documents with title, date, regulator, a highlighted snippet, and the official source link. " +
  "Use this to answer 'what are the rules on X' style questions with cited primary sources.",
  {
    query: z.string().describe("Search terms e.g. 'digital lending', 'KYC periodic updation', 'FPI registration', 'mutual fund nomination'"),
    regulator: z.enum(["RBI", "SEBI"]).optional().describe("Optionally limit to one regulator"),
    doc_type: z.enum(["circular", "master_direction", "master_circular", "notification", "regulation"]).optional()
              .describe("Optionally limit to one document type. master_direction/master_circular are consolidated current rules."),
    limit: z.number().default(10).describe("Max results (1-25)"),
  },
  async ({ query, regulator, doc_type, limit }) => {
    try {
      if (!q.docCount().length) return emptyDbMsg();
      const results = q.searchDocs({ query, regulator, docType: doc_type, limit: Math.min(limit, 25) });
      return ok({
        query,
        resultCount: results.length,
        results: results.map((r) => ({
          id: r.id, regulator: r.regulator, type: r.doc_type,
          title: r.title, date: r.date, snippet: r.snippet,
          source: r.source_url, pdf: r.pdf_url,
        })),
        note: "Use get_document with an id to retrieve the full text.",
        disclaimer: DISCLAIMER,
      });
    } catch (e: unknown) { return err(e instanceof Error ? e.message : String(e)); }
  }
);

server.tool(
  "get_document",
  "Retrieve the full text of a specific regulatory document by its id (from search results). Returns the complete body plus metadata and official link.",
  { id: z.string().describe("Document id from search results e.g. 'rbi:13344' or 'sebi:101703'") },
  async ({ id }) => {
    try {
      const doc = q.getDoc(id);
      if (!doc) return err(`No document found with id ${id}. Use search_regulations to find valid ids.`);
      const body = doc.body && doc.body.length > 12000
        ? doc.body.slice(0, 12000) + "\n\n[... truncated. See full document at source link ...]"
        : doc.body;
      return ok({
        id: doc.id, regulator: doc.regulator, type: doc.doc_type,
        title: doc.title, date: doc.date, department: doc.department,
        source: doc.source_url, pdf: doc.pdf_url, body,
        disclaimer: DISCLAIMER,
      });
    } catch (e: unknown) { return err(e instanceof Error ? e.message : String(e)); }
  }
);

server.tool(
  "get_recent",
  "Get the most recent regulatory documents, optionally filtered by regulator or type. Useful for 'what changed recently' questions.",
  {
    regulator: z.enum(["RBI", "SEBI"]).optional(),
    doc_type: z.enum(["circular", "master_direction", "master_circular", "notification", "regulation"]).optional(),
    limit: z.number().default(15).describe("Max results (1-30)"),
  },
  async ({ regulator, doc_type, limit }) => {
    try {
      if (!q.docCount().length) return emptyDbMsg();
      const docs = q.recentDocs({ regulator, docType: doc_type, limit: Math.min(limit, 30) });
      return ok({
        results: docs.map((d) => ({ id: d.id, regulator: d.regulator, type: d.doc_type, title: d.title, date: d.date, source: d.source_url })),
        disclaimer: DISCLAIMER,
      });
    } catch (e: unknown) { return err(e instanceof Error ? e.message : String(e)); }
  }
);

server.tool(
  "list_master_directions",
  "List RBI Master Directions and SEBI Master Circulars — the consolidated, currently-in-force rules on each subject. " +
  "Best starting point for understanding the current state of regulation on a topic.",
  { regulator: z.enum(["RBI", "SEBI"]).optional() },
  async ({ regulator }) => {
    try {
      if (!q.docCount().length) return emptyDbMsg();
      const md = q.recentDocs({ regulator, docType: "master_direction", limit: 50 });
      const mc = q.recentDocs({ regulator, docType: "master_circular", limit: 50 });
      const all = [...md, ...mc].sort((a, b) => b.date.localeCompare(a.date));
      return ok({
        count: all.length,
        documents: all.map((d) => ({ id: d.id, regulator: d.regulator, type: d.doc_type, title: d.title, date: d.date, source: d.source_url })),
        disclaimer: DISCLAIMER,
      });
    } catch (e: unknown) { return err(e instanceof Error ? e.message : String(e)); }
  }
);

server.tool(
  "list_by_department",
  "List SEBI documents from a specific department e.g. 'Investment Management', 'Market Regulation', 'Corporation Finance'.",
  { department: z.string().describe("Department name or partial e.g. 'Investment Management', 'Foreign Portfolio'") },
  async ({ department }) => {
    try {
      if (!q.docCount().length) return emptyDbMsg();
      const docs = q.listByDepartment(department, 25);
      return ok({
        department, count: docs.length,
        documents: docs.map((d) => ({ id: d.id, title: d.title, date: d.date, source: d.source_url })),
        disclaimer: DISCLAIMER,
      });
    } catch (e: unknown) { return err(e instanceof Error ? e.message : String(e)); }
  }
);

server.tool(
  "sync_latest",
  "Refresh the regulatory index by scraping the latest documents from RBI and SEBI. " +
  "Run this to pull in newly published circulars, master circulars, and regulations. Incremental — only fetches documents not already indexed. " +
  "Note: takes 2-5 minutes as it politely scrapes the regulators' sites.",
  {
    months_back: z.number().default(2).describe("How many months of RBI history to check (default 2 for incremental refresh)"),
    sebi_pages: z.number().default(3).describe("How many SEBI listing pages to check per section (default 3 = ~75 recent docs per section)"),
  },
  async ({ months_back, sebi_pages }) => {
    try {
      const log: string[] = [];
      const rbiCount = await syncRbi(months_back, (m) => log.push(m));
      const sebiCirc   = await syncSebi(7, sebi_pages, (m) => log.push(m));
      const sebiMaster = await syncSebi(6, sebi_pages, (m) => log.push(m));
      const sebiReg    = await syncSebi(3, sebi_pages, (m) => log.push(m));
      const sebiCount  = sebiCirc + sebiMaster + sebiReg;
      q.setSyncMeta("last_sync", new Date().toISOString());
      return ok({
        message: "Sync complete.",
        newRbiDocs: rbiCount, newSebiDocs: sebiCount,
        log,
        disclaimer: DISCLAIMER,
      });
    } catch (e: unknown) { return err(e instanceof Error ? e.message : String(e)); }
  }
);

server.tool(
  "sync_status",
  "Show how many documents are indexed, broken down by regulator and type, and when the index was last synced.",
  {},
  async () => {
    try {
      const counts = q.docCount();
      const lastSync = q.getSyncMeta("last_sync");
      const total = counts.reduce((s, c) => s + c.n, 0);
      return ok({ totalDocuments: total, breakdown: counts, lastSync: lastSync || "never" });
    } catch (e: unknown) { return err(e instanceof Error ? e.message : String(e)); }
  }
);

server.tool(
  "search_by_topic",
  "Topic-focused search that returns BOTH the consolidated master rules AND recent circulars on a subject, " +
  "so you get the current baseline plus any recent changes. Best tool for 'give me everything on X' questions.",
  { topic: z.string().describe("Regulatory topic e.g. 'digital lending', 'NBFC capital adequacy', 'FPI', 'algo trading', 'KYC'") },
  async ({ topic }) => {
    try {
      if (!q.docCount().length) return emptyDbMsg();
      const masters = q.searchDocs({ query: topic, docType: "master_direction", limit: 3 })
        .concat(q.searchDocs({ query: topic, docType: "master_circular", limit: 3 }));
      const recent = q.searchDocs({ query: topic, limit: 10 });
      return ok({
        topic,
        consolidatedRules: masters.map((r) => ({ id: r.id, regulator: r.regulator, title: r.title, date: r.date, source: r.source_url })),
        relatedDocuments: recent.map((r) => ({ id: r.id, regulator: r.regulator, type: r.doc_type, title: r.title, date: r.date, snippet: r.snippet, source: r.source_url })),
        guidance: "Start with consolidatedRules for the current baseline, then check relatedDocuments for recent amendments. Use get_document for full text.",
        disclaimer: DISCLAIMER,
      });
    } catch (e: unknown) { return err(e instanceof Error ? e.message : String(e)); }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("india-reg-mcp running on stdio");
