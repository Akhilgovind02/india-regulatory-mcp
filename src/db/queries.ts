import { db } from "./schema.js";
import type { Statement } from "better-sqlite3";

export interface DocRow {
  id: string; regulator: string; doc_type: string; title: string;
  date: string; department: string | null; source_url: string;
  pdf_url: string | null; body: string | null; indexed_at: string;
}

// Lazy statement cache — prepared after initSchema() has created the tables
const stmts: Record<string, Statement> = {};
function stmt(key: string, sql: string): Statement {
  if (!stmts[key]) stmts[key] = db.prepare(sql);
  return stmts[key];
}

export function upsertDoc(doc: DocRow) {
  stmt("upsert", `
    INSERT INTO documents (id, regulator, doc_type, title, date, department, source_url, pdf_url, body, indexed_at)
    VALUES (@id, @regulator, @doc_type, @title, @date, @department, @source_url, @pdf_url, @body, @indexed_at)
    ON CONFLICT(id) DO UPDATE SET
      title=@title, body=@body, department=@department, pdf_url=@pdf_url, indexed_at=@indexed_at
  `).run(doc);
}

export function upsertMany(docs: DocRow[]) {
  const s = stmt("upsert", `
    INSERT INTO documents (id, regulator, doc_type, title, date, department, source_url, pdf_url, body, indexed_at)
    VALUES (@id, @regulator, @doc_type, @title, @date, @department, @source_url, @pdf_url, @body, @indexed_at)
    ON CONFLICT(id) DO UPDATE SET
      title=@title, body=@body, department=@department, pdf_url=@pdf_url, indexed_at=@indexed_at
  `);
  const tx = db.transaction((rows: DocRow[]) => rows.forEach((r) => s.run(r)));
  tx(docs);
}

export function docExists(id: string): boolean {
  return !!stmt("exists", "SELECT 1 FROM documents WHERE id = ?").get(id);
}

export function getDoc(id: string): DocRow | undefined {
  return stmt("getDoc", "SELECT * FROM documents WHERE id = ?").get(id) as DocRow | undefined;
}

export function searchDocs(opts: {
  query: string;
  regulator?: "RBI" | "SEBI";
  docType?: string;
  limit?: number;
}): (DocRow & { snippet: string })[] {
  if (!opts.query.trim()) return [];
  const limit = opts.limit ?? 10;
  let sql = `
    SELECT d.*, snippet(documents_fts, 1, '<<', '>>', ' … ', 16) AS snippet
    FROM documents_fts f
    JOIN documents d ON d.rowid = f.rowid
    WHERE documents_fts MATCH @q
  `;
  const params: Record<string, unknown> = { q: escapeFts(opts.query) };
  if (opts.regulator) { sql += " AND d.regulator = @regulator"; params.regulator = opts.regulator; }
  if (opts.docType)   { sql += " AND d.doc_type = @docType";    params.docType = opts.docType; }
  sql += " ORDER BY rank, d.date DESC LIMIT @limit";
  params.limit = limit;
  return db.prepare(sql).all(params) as (DocRow & { snippet: string })[];
}

export function recentDocs(opts: {
  regulator?: "RBI" | "SEBI"; docType?: string; limit?: number;
}): DocRow[] {
  const limit = opts.limit ?? 15;
  let sql = "SELECT * FROM documents WHERE 1=1";
  const params: Record<string, unknown> = {};
  if (opts.regulator) { sql += " AND regulator = @regulator"; params.regulator = opts.regulator; }
  if (opts.docType)   { sql += " AND doc_type = @docType";    params.docType = opts.docType; }
  sql += " ORDER BY date DESC LIMIT @limit"; params.limit = limit;
  return db.prepare(sql).all(params) as DocRow[];
}

export function listByDepartment(dept: string, limit = 20): DocRow[] {
  return db.prepare(
    "SELECT * FROM documents WHERE department LIKE ? ORDER BY date DESC LIMIT ?"
  ).all(`%${dept}%`, limit) as DocRow[];
}

export function docCount(): { regulator: string; doc_type: string; n: number }[] {
  return db.prepare(
    "SELECT regulator, doc_type, COUNT(*) as n FROM documents GROUP BY regulator, doc_type"
  ).all() as { regulator: string; doc_type: string; n: number }[];
}

export function getSyncMeta(key: string): string | undefined {
  const row = stmt("getMeta", "SELECT value FROM sync_meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSyncMeta(key: string, value: string) {
  stmt("setMeta", "INSERT INTO sync_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=?")
    .run(key, value, value);
}

function escapeFts(q: string): string {
  const trimmed = q.trim();
  if (!trimmed) return "";
  return trimmed.split(/\s+/).map((w) => `"${w.replace(/"/g, '')}"`).join(" ");
}
