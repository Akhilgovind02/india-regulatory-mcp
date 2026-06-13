import { politeFetch } from "../util/http.js";
import { PDFParse } from "pdf-parse";

export async function extractPdfText(pdfUrl: string): Promise<string> {
  try {
    const res = await politeFetch(pdfUrl);
    const buf = Buffer.from(await res.arrayBuffer());
    const parser = new PDFParse({ data: buf });
    const result = await parser.getText();
    return cleanText(result.text);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`PDF extract failed for ${pdfUrl}: ${msg}`);
    return "";
  }
}

function cleanText(t: string): string {
  return t.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}
