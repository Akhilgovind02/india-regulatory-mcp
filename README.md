# india-reg-mcp

An MCP server that gives Claude (and any MCP client) searchable, cited access to **RBI and SEBI regulatory documents** — circulars, master directions, notifications, and regulations.

No API keys. No subscriptions. Built entirely on free public government data.

---

## Why This Exists

Regulatory rules in India are scattered across thousands of PDFs and HTML pages on rbi.org.in and sebi.gov.in. They reference and supersede each other constantly. There is no AI-accessible way to ask "what are the current rules on X" and get sourced answers.

This MCP solves that. It scrapes, indexes, and exposes the full text of RBI and SEBI documents in a local SQLite database — so Claude can search and retrieve primary-source regulatory text with official citations, instantly.

**This is not a legal advice tool.** It retrieves primary-source documents so you can reason over actual rules instead of hallucinated summaries.

---

## What It Does

- **Full-text search** across all indexed RBI and SEBI documents
- **Retrieve full document body** by ID, with official source link
- **List recent documents** — useful for "what changed this month" questions
- **List Master Directions and Master Circulars** — the consolidated, currently-in-force rules on each subject
- **Browse by department** — SEBI's Investment Management, Market Regulation, etc.
- **On-demand sync** — pull newly published documents from regulators' sites
- **Topic search** — returns both consolidated master rules AND recent circulars on a subject in one call

---

## Tools (8 total)

| Tool | Description |
|---|---|
| `search_regulations` | Full-text search with optional regulator/type filter |
| `get_document` | Retrieve full text of a document by ID |
| `get_recent` | Most recent documents, optionally filtered |
| `list_master_directions` | All RBI Master Directions + SEBI Master Circulars |
| `list_by_department` | SEBI documents by department name |
| `sync_latest` | Incremental scrape of new documents from RBI + SEBI |
| `sync_status` | Document count breakdown + last sync time |
| `search_by_topic` | Combined master rules + recent circulars on a topic |

---

## Architecture

```
RBI / SEBI websites
        │
        ▼
   Scrapers (TypeScript)
   rbi.ts  ──── ASP.NET POST with viewstate tokens
   sebi.ts ──── AJAX pagination via JSP endpoint
        │
        ▼
   SQLite DB  (~/.india-reg-mcp/regdata.db)
   ├── documents table (full text, metadata, source URLs)
   ├── documents_fts (FTS5 full-text index, porter stemmer)
   └── sync_meta (last sync timestamp)
        │
        ▼
   MCP Server (stdio transport)
   ├── 8 tools exposed to Claude
   └── Every result includes official source URL + disclaimer
```

**Key design decision:** Tools never scrape live. The scrapers populate a local SQLite database once, and tools query that instantly. Only `sync_latest` hits the regulators' sites. This makes every tool call fast, keeps you off government servers during normal use, and works offline once indexed.

---

## Installation

### Prerequisites

- Node.js 22 LTS or higher
- Claude Desktop or Claude Code CLI

### Setup

```bash
git clone https://github.com/Akhilgovind02/india-regulatory-mcp.git
cd india-regulatory-mcp
npm install
npm run build
```

### First-run sync (populates the database)

```bash
npm run sync
```

This scrapes RBI notifications for the last 36 months and SEBI circulars (~1000 recent documents). Takes **5–15 minutes** depending on your connection. The database is stored at `~/.india-reg-mcp/regdata.db` and survives rebuilds.

Progress is printed to stderr:
```
[sync] RBI 2026-6: 12 docs found
[sync] RBI 2026-5: 18 docs found
...
[sync] SEBI ssid=6 page 0: 25 docs
...
[sync] Sync complete.
```

---

## Configuration

### Claude Code (CLI)

```bash
claude mcp add -s user india-reg node /ABSOLUTE/PATH/TO/india-regulatory-mcp/dist/index.js
```

Or add to `~/.claude.json` manually:
```json
{
  "mcpServers": {
    "india-reg": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/TO/india-regulatory-mcp/dist/index.js"]
    }
  }
}
```

### Claude Desktop

Edit `%APPDATA%\Claude\claude_desktop_config.json` (Windows) or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "india-reg": {
      "command": "node",
      "args": ["C:\\ABSOLUTE\\PATH\\TO\\india-regulatory-mcp\\dist\\index.js"]
    }
  }
}
```

Restart Claude Desktop fully after editing the config.

---

## Usage Examples

Once connected, ask Claude naturally:

```
What are the current RBI rules on digital lending?
```
→ Claude calls `search_by_topic("digital lending")` — returns the Master Direction on Digital Lending plus recent amending circulars, each with official source links.

```
What new SEBI circulars came out this month?
```
→ Claude calls `get_recent(regulator="SEBI", limit=10)`.

```
Show me all RBI Master Directions
```
→ Claude calls `list_master_directions(regulator="RBI")`.

```
What are the KYC requirements for mutual funds?
```
→ Claude calls `search_regulations("KYC mutual fund", doc_type="master_direction")`.

```
Pull in the latest regulatory updates
```
→ Claude calls `sync_latest()` — incremental, only fetches new documents.

---

## Data Sources

### RBI (Reserve Bank of India)
- **Notifications + Circulars**: `rbi.org.in/Scripts/NotificationUser.aspx`
- **Master Directions**: `rbi.org.in/Scripts/BS_ViewMasterDirections.aspx`
- **Master Circulars**: `rbi.org.in/Scripts/BS_ViewMasterCirculardetails.aspx`
- Document bodies: HTML page text (with PDF fallback for PDF-only docs)

### SEBI (Securities and Exchange Board of India)
- **Circulars** (`ssid=7`): ~2,775 documents as of June 2026
- **Master Circulars** (`ssid=6`): consolidated current rules by topic
- **Regulations** (`ssid=3`): statutory regulations
- Document bodies: primarily PDF-embedded content extracted via `pdf-parse`

---

## Document Types

| Type | Source | Description |
|---|---|---|
| `circular` | RBI + SEBI | Point-in-time regulatory guidance |
| `master_direction` | RBI | Consolidated current rules on a subject (supersedes earlier circulars) |
| `master_circular` | SEBI | Same as master direction, SEBI's term |
| `notification` | RBI | Statutory notifications under various Acts |
| `regulation` | SEBI | Formal regulations (e.g. SEBI (FPI) Regulations 2019) |

**For compliance questions, start with `master_direction`/`master_circular`.** These represent the current state of rules, not a point-in-time snapshot.

---

## Keeping the Index Fresh

The database is a point-in-time snapshot. RBI and SEBI publish new documents frequently (several per week).

**Option 1 — Ask Claude:** "Pull in the latest regulatory updates" → Claude calls `sync_latest`.

**Option 2 — CLI:**
```bash
npm run sync
```

**Option 3 — Scheduled (example cron, runs every Sunday at 2am):**
```
0 2 * * 0 cd /path/to/india-regulatory-mcp && npm run sync >> ~/.india-reg-mcp/sync.log 2>&1
```

`sync_latest` and `npm run sync` are both incremental — they skip documents already in the database.

---

## Project Structure

```
india-regulatory-mcp/
├── src/
│   ├── index.ts                  ← MCP server, all 8 tools
│   ├── db/
│   │   ├── schema.ts             ← SQLite schema + FTS5 setup
│   │   └── queries.ts            ← DB read/write functions
│   ├── scrapers/
│   │   ├── rbi.ts                ← RBI scraper (ASP.NET POST + viewstate)
│   │   ├── sebi.ts               ← SEBI scraper (AJAX pagination)
│   │   ├── pdf.ts                ← PDF download + text extraction
│   │   ├── run-sync.ts           ← CLI full sync runner
│   │   └── repair-bodies.ts      ← Utility: backfill missing body text
│   └── util/
│       ├── http.ts               ← Polite fetch (UA + retry + delay)
│       └── format.ts             ← MCP response helpers
├── dist/                         ← Compiled output (not in repo)
├── package.json
└── tsconfig.json
```

---

## Technical Notes

### Scraping approach

**RBI** uses ASP.NET with viewstate tokens. The scraper fetches viewstate on startup, then POSTs month-by-month to get document listings. Content is extracted from the HTML circular page; PDF fallback for PDF-only documents.

**SEBI** uses a JSP-based listing with AJAX pagination. Page 1 is a GET request (establishes JSESSIONID). Pages 2+ POST to `getnewslistinfo.jsp` with the session cookie. Circular content is typically a PDF embedded in an iframe — the scraper extracts the PDF URL and parses it with `pdf-parse`.

### Polite scraping
- Concurrency capped at 2 parallel requests per host
- 300ms delay between document fetches
- 500ms delay between listing pages
- Exponential backoff on 429/5xx responses
- Real User-Agent string identifying the tool

### Database
- Location: `~/.india-reg-mcp/regdata.db`
- WAL mode for performance
- FTS5 with Porter stemmer — handles morphological variants ("lending" matches "lend", "lender")
- Full-text search terms are quoted per-word to handle hyphens and special characters safely

---

## Stack

| Package | Version | Purpose |
|---|---|---|
| `@modelcontextprotocol/sdk` | 1.29.0 | MCP server framework |
| `better-sqlite3` | 12.10.0 | SQLite with built-in FTS5 |
| `cheerio` | 1.2.0 | HTML parsing |
| `pdf-parse` | 2.4.5 | PDF text extraction |
| `turndown` | 7.2.4 | HTML → Markdown |
| `p-limit` | 7.3.0 | Concurrency control |
| `zod` | 4.4.3 | Schema validation |

---

## Disclaimer

This tool retrieves and surfaces primary-source regulatory documents from official RBI and SEBI publications. It does not provide legal advice. Always verify against the official linked document. The index is a point-in-time snapshot — use `sync_latest` to pull recent publications.
