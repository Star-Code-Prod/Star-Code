// Zero-dependency Office document readers for the desktop preview.
//
// The desktop ships without a LibreOffice or Python sidecar, so this module
// reads the OOXML packages directly: a small ZIP reader plus targeted XML
// extraction for Word, Excel and PowerPoint. It is intentionally read-only:
// previews never mutate the document.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const MAX_ZIP_BYTES = 60 * 1024 * 1024;
const MAX_UNZIPPED = 120 * 1024 * 1024;
const MAX_ENTRIES = 6000;

function u16(b, o) { return b.readUInt16LE(o); }
function u32(b, o) { return b.readUInt32LE(o); }

/** Read a ZIP archive into a filename -> Buffer map. */
export function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new Error("not a ZIP file");
  if (buf.length > MAX_ZIP_BYTES) throw new Error("document is too large to preview");
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (u32(buf, i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("not a ZIP file");
  const count = u16(buf, eocd + 10);
  const cdOff = u32(buf, eocd + 16);
  if (count > MAX_ENTRIES) throw new Error("document has too many parts");
  const out = new Map();
  let total = 0;
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || u32(buf, p) !== 0x02014b50) break;
    const method = u16(buf, p + 10);
    const csize = u32(buf, p + 20);
    const usize = u32(buf, p + 24);
    const nlen = u16(buf, p + 28);
    const elen = u16(buf, p + 30);
    const clen = u16(buf, p + 32);
    const local = u32(buf, p + 42);
    const name = buf.slice(p + 46, p + 46 + nlen).toString("utf8").replace(/\\/g, "/");
    p += 46 + nlen + elen + clen;
    if (!name || name.endsWith("/")) continue;
    if (local + 30 > buf.length || u32(buf, local) !== 0x04034b50) continue;
    const ln = u16(buf, local + 26), le = u16(buf, local + 28);
    const start = local + 30 + ln + le;
    const raw = buf.slice(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1024, usize || MAX_UNZIPPED) });
    else continue;
    total += data.length;
    if (total > MAX_UNZIPPED) throw new Error("document expands too large");
    out.set(name, data);
  }
  return out;
}

function decode(s) {
  return String(s || "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

function xmlText(xml) {
  return decode(String(xml || "").replace(/<[^>]+>/g, ""));
}

function attr(xml, name) {
  const m = new RegExp("\\b" + name + "=\"([^\"]*)\"").exec(xml);
  return m ? decode(m[1]) : "";
}

/* -------------------------------- DOCX -------------------------------- */
function docxParagraphs(xml) {
  const blocks = [];
  const pRe = /<w:p\b[\s\S]*?<\/w:p>/g;
  let pm;
  while ((pm = pRe.exec(xml))) {
    const body = pm[0];
    let text = "";
    const tRe = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>/g;
    let tm;
    while ((tm = tRe.exec(body))) {
      if (tm[0].startsWith("<w:tab")) text += "\t";
      else if (tm[0].startsWith("<w:br")) text += "\n";
      else text += decode(tm[1]);
    }
    if (!text.trim()) continue;
    const style = attr(body, "w:val") || (/<w:pStyle\b[^>]*w:val="([^"]+)"/.exec(body)?.[1] || "");
    blocks.push({ type: "p", text: text.trim(), style: style ? decode(style) : "" });
  }
  return blocks;
}

export function extractDocx(zip) {
  const xml = zip.get("word/document.xml");
  if (!xml) throw new Error("not a Word document");
  const src = xml.toString("utf8");
  const blocks = [];
  let last = 0;
  const tblRe = /<w:tbl\b[\s\S]*?<\/w:tbl>/g;
  let tm;
  while ((tm = tblRe.exec(src))) {
    const before = src.slice(last, tm.index);
    const ps = docxParagraphs(before);
    for (const p of ps) blocks.push(p);
    const rows = [];
    const trRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
    let rm;
    while ((rm = trRe.exec(tm[0]))) {
      const cells = [];
      const tcRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
      let cm;
      while ((cm = tcRe.exec(rm[0]))) {
        const t = docxParagraphs(cm[0]).map((p) => p.text).join(" ");
        cells.push(t);
      }
      rows.push(cells);
    }
    if (rows.length) blocks.push({ type: "table", rows: rows.slice(0, 200).map((r) => r.slice(0, 30)) });
    last = tm.index + tm[0].length;
  }
  for (const p of docxParagraphs(src.slice(last))) blocks.push(p);
  return { type: "docx", blocks: blocks.slice(0, 400) };
}

/* -------------------------------- XLSX -------------------------------- */
function xlsxShared(zip) {
  const xml = zip.get("xl/sharedStrings.xml");
  if (!xml) return [];
  const src = xml.toString("utf8");
  const out = [];
  const siRe = /<si\b[\s\S]*?<\/si>/g;
  let m;
  while ((m = siRe.exec(src))) out.push(xmlText(m[0]));
  return out;
}

function cellValue(cell, shared) {
  const t = attr(cell, "t");
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cell);
  if (t === "s") return shared[Number(v?.[1])] ?? "";
  if (t === "inlineStr") return xmlText(cell);
  if (t === "b") return v && v[1] === "1" ? "TRUE" : "FALSE";
  return v ? decode(v[1]) : "";
}

function colNumber(ref) {
  const letters = String(ref || "").replace(/\d+/g, "").toUpperCase();
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n > 0 ? n - 1 : 0;
}

export function extractXlsx(zip) {
  const wb = zip.get("xl/workbook.xml");
  const rels = zip.get("xl/_rels/workbook.xml.rels");
  if (!wb) throw new Error("not an Excel workbook");
  const shared = xlsxShared(zip);
  const relMap = new Map();
  if (rels) {
    const rsrc = rels.toString("utf8");
    const rRe = /<Relationship\b[^>]*>/g;
    let rm;
    while ((rm = rRe.exec(rsrc))) {
      relMap.set(attr(rm[0], "Id"), attr(rm[0], "Target"));
    }
  }
  const sheets = [];
  const sheetRe = /<sheet\b[^>]*\/?>/g;
  const src = wb.toString("utf8");
  let sm;
  while ((sm = sheetRe.exec(src))) {
    const id = attr(sm[0], "r:id");
    const name = attr(sm[0], "name");
    let target = relMap.get(id) || "";
    target = target.replace(/^\/?xl\//, "").replace(/^\.\//, "");
    const file = ("xl/" + target).replace(/\/\.\//g, "/");
    const xml = zip.get(file) || zip.get("xl/worksheets/sheet" + (sheets.length + 1) + ".xml");
    if (!xml) continue;
    const rows = [];
    const rowRe = /<row\b[\s\S]*?<\/row>/g;
    let rm;
    while ((rm = rowRe.exec(xml.toString("utf8")))) {
      const cells = [];
      const cRe = /<c\b[\s\S]*?<\/c>/g;
      let cm;
      while ((cm = cRe.exec(rm[0]))) {
        const ref = attr(cm[0], "r");
        const ci = colNumber(ref);
        while (cells.length < ci) cells.push({ value: "" });
        cells.push({ value: cellValue(cm[0], shared) });
      }
      if (cells.length) rows.push(cells);
    }
    sheets.push({ name: name || ("Sheet " + (sheets.length + 1)), rows: rows.slice(0, 300) });
    if (sheets.length >= 4) break;
  }
  return { type: "xlsx", sheets };
}

/* -------------------------------- PPTX -------------------------------- */
export function extractPptx(zip) {
  const names = [...zip.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!names.length) throw new Error("not a PowerPoint presentation");
  const slides = names.slice(0, 60).map((name, i) => {
    const src = zip.get(name).toString("utf8");
    const paras = [];
    const pRe = /<a:p\b[\s\S]*?<\/a:p>/g;
    let pm;
    while ((pm = pRe.exec(src))) {
      let text = "";
      const tRe = /<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
      let tm;
      while ((tm = tRe.exec(pm[0]))) text += decode(tm[1]);
      if (text.trim()) paras.push(text.trim());
    }
    return { index: i + 1, paragraphs: paras };
  });
  return { type: "pptx", slides };
}

/* -------------------------------- API --------------------------------- */
const OFFICE_EXT = new Set([".docx", ".xlsx", ".pptx"]);
const PDF_EXT = new Set([".pdf"]);

export function officeKind(ext) {
  ext = String(ext || "").toLowerCase();
  if (OFFICE_EXT.has(ext)) return "office";
  if (PDF_EXT.has(ext)) return "pdf";
  return "";
}

export async function extractOffice(file, ext) {
  const st = await fs.promises.stat(file);
  if (st.size > MAX_ZIP_BYTES) throw new Error("document is too large to preview");
  const zip = readZip(await fs.promises.readFile(file));
  ext = String(ext || path.extname(file)).toLowerCase();
  const out = ext === ".docx" ? extractDocx(zip) : ext === ".xlsx" ? extractXlsx(zip) : extractPptx(zip);
  out.name = path.basename(file);
  out.size = st.size;
  return out;
}
