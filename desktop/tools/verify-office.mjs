// Office preview foundation: OOXML readers work without a sidecar.
import zlib from "node:zlib";
import { readZip, extractDocx, extractXlsx, extractPptx, officeKind } from "../lib/office.js";

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("PASS  " + name); }
  else { fail++; console.log("FAIL  " + name + (extra ? "  " + extra : "")); }
}

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, bodyRaw] of Object.entries(files)) {
    const body = Buffer.from(bodyRaw);
    const nameBuf = Buffer.from(name);
    const comp = zlib.deflateRawSync(body);
    const crc = crc32(body);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(8, 8); lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(body.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(body.length, 24); ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const docx = makeZip({
  "word/document.xml": `<w:document><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly report</w:t></w:r></w:p>
    <w:p><w:r><w:t>Revenue was </w:t></w:r><w:r><w:t>up 12%.</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
  </w:body></w:document>`,
});
{
  const zip = readZip(docx);
  const out = extractDocx(zip);
  ok("docx renders a heading and prose", out.type === "docx" && out.blocks[0].style === "Heading1" && out.blocks[0].text === "Quarterly report" && out.blocks[1].text.includes("up 12%"));
  ok("docx tables survive", out.blocks.some((b) => b.type === "table" && b.rows[1][0] === "North" && b.rows[1][1] === "42"));
}

const xlsx = makeZip({
  "xl/workbook.xml": `<workbook><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>Item</t></si><si><t>Cost</t></si><si><t>Hosting</t></si></sst>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
    <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
    <row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>120.5</v></c></row>
  </sheetData></worksheet>`,
});
{
  const out = extractXlsx(readZip(xlsx));
  ok("xlsx reads sheet names and cells", out.type === "xlsx" && out.sheets[0].name === "Budget" && out.sheets[0].rows[0][0].value === "Item" && out.sheets[0].rows[1][1].value === "120.5");
}

const pptx = makeZip({
  "ppt/slides/slide1.xml": `<p:sld><p:cSld><a:p><a:r><a:t>Find a Egg</a:t></a:r></a:p><a:p><a:r><a:t>Twelve eggs spawn each round.</a:t></a:r></a:p></p:cSld></p:sld>`,
  "ppt/slides/slide2.xml": `<p:sld><p:cSld><a:p><a:r><a:t>Round flow</a:t></a:r></a:p></p:cSld></p:sld>`,
});
{
  const out = extractPptx(readZip(pptx));
  ok("pptx reads slides in order", out.type === "pptx" && out.slides.length === 2 && out.slides[0].paragraphs[0] === "Find a Egg" && out.slides[1].paragraphs[0] === "Round flow");
}

ok("office kinds are detected", officeKind(".docx") === "office" && officeKind(".pdf") === "pdf" && officeKind(".txt") === "");
let threw = false;
try { readZip(Buffer.from("not a zip")); } catch { threw = true; }
ok("a corrupt zip is rejected", threw);
ok("zip reader keeps text files intact", readZip(makeZip({ "a.txt": "hello" })).get("a.txt").toString() === "hello");

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) process.exit(1);
