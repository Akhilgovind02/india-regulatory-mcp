import Database from "better-sqlite3";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, existsSync } from "node:fs";

const DB_DIR = join(homedir(), ".india-reg-mcp");
if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true });
const DB_PATH = join(DB_DIR, "regdata.db");

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id           TEXT PRIMARY KEY,
      regulator    TEXT NOT NULL,
      doc_type     TEXT NOT NULL,
      title        TEXT NOT NULL,
      date         TEXT NOT NULL,
      department   TEXT,
      source_url   TEXT NOT NULL,
      pdf_url      TEXT,
      body         TEXT,
      indexed_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_regulator ON documents(regulator);
    CREATE INDEX IF NOT EXISTS idx_doctype   ON documents(doc_type);
    CREATE INDEX IF NOT EXISTS idx_date      ON documents(date);

    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
      title, body,
      content='documents',
      content_rowid='rowid',
      tokenize='porter unicode61'
    );

    DROP TRIGGER IF EXISTS documents_ai;

    CREATE TRIGGER documents_ai AFTER INSERT ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, body) VALUES ('delete', new.rowid, new.title, new.body);
      INSERT INTO documents_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;
    CREATE TRIGGER IF NOT EXISTS documents_ad AFTER DELETE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    END;
    CREATE TRIGGER IF NOT EXISTS documents_au AFTER UPDATE ON documents BEGIN
      INSERT INTO documents_fts(documents_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
      INSERT INTO documents_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
    END;

    CREATE TABLE IF NOT EXISTS sync_meta (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
}
