// Minimal OOXML writers: docx, xlsx and pptx built from plain data.
// Everything is stored uncompressed, so the output is byte-deterministic and
// does not depend on zlib behaviour across Node versions.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const DOS_TIME = 0;
const DOS_DATE = (() => {
  const y = 2026 - 1980;
  return (y << 9) | (1 << 5) | 1;
})();

export function zipStore(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const crc = crc32(data);
    const localStart = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    centrals.push(central, name);
    central.writeUInt32LE(localStart, 42);

    offset += local.length + name.length + data.length;
  }
  const centralSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const esc = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const NS_W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NS_R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const NS_P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const NS_A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
const REL_DOC = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function contentTypes(overrides) {
  return (
    XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join("") +
    "</Types>"
  );
}

function rels(list) {
  return (
    XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    list.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${r.target}"/>`).join("") +
    "</Relationships>"
  );
}

/* -------------------------------- DOCX -------------------------------- */

export function docxParts({ title = "Document", sections = [] }) {
  const body = [];
  if (title && sections.length) {
    body.push(
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${esc(title)}</w:t></w:r></w:p>`,
    );
  }
  for (const s of sections) {
    if (s.heading) {
      body.push(
        `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">${esc(s.heading)}</w:t></w:r></w:p>`,
      );
    }
    for (const para of s.paragraphs || []) {
      body.push(`<w:p><w:r><w:t xml:space="preserve">${esc(para)}</w:t></w:r></w:p>`);
    }
    for (const item of s.bullets || []) {
      body.push(
        `<w:p><w:pPr><w:pStyle w:val="ListBullet"/></w:pPr><w:r><w:t xml:space="preserve">${esc(item)}</w:t></w:r></w:p>`,
      );
    }
  }
  if (!body.length) body.push(`<w:p><w:r><w:t xml:space="preserve">${esc(title)}</w:t></w:r></w:p>`);

  const document =
    XML_HEAD +
    `<w:document ${NS_W} ${NS_R}><w:body>` +
    body.join("") +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    "</w:body></w:document>";

  const styles =
    XML_HEAD +
    `<w:styles ${NS_W}>` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="280" w:after="120"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>' +
    '<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/>' +
    '<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr></w:style>' +
    "</w:styles>";

  const numbering =
    XML_HEAD +
    `<w:numbering ${NS_W}>` +
    '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/>' +
    '<w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>' +
    "</w:numbering>";

  const core =
    XML_HEAD +
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
    'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
    `<dc:title>${esc(title)}</dc:title><dc:creator>Star</dc:creator>` +
    '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-01T00:00:00Z</dcterms:created>' +
    "</cp:coreProperties>";

  return [
    { name: "[Content_Types].xml", data: contentTypes([["/word/document.xml", "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"]]) },
    { name: "_rels/.rels", data: rels([
      { id: "rId1", type: REL_DOC + "/officeDocument", target: "word/document.xml" },
      { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" },
    ]) },
    { name: "docProps/core.xml", data: core },
    { name: "word/document.xml", data: document },
    { name: "word/styles.xml", data: styles },
    { name: "word/numbering.xml", data: numbering },
    { name: "word/_rels/document.xml.rels", data: rels([
      { id: "rId1", type: REL_DOC + "/styles", target: "styles.xml" },
      { id: "rId2", type: REL_DOC + "/numbering", target: "numbering.xml" },
    ]) },
  ];
}

export function writeDocx(data) {
  return zipStore(docxParts(data));
}

/* -------------------------------- XLSX -------------------------------- */

const colName = (i) => {
  let s = "";
  let n = i;
  while (n >= 0) {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  }
  return s;
};

function sheetXml(rows) {
  const out = [];
  rows.forEach((row, r) => {
    const cells = (row || []).map((value, c) => {
      const ref = colName(c) + (r + 1);
      if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"><v>${value}</v></c>`;
      if (typeof value === "boolean") return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
      if (value == null || value === "") return "";
      return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(value)}</t></is></c>`;
    });
    out.push(`<row r="${r + 1}">${cells.join("")}</row>`);
  });
  return (
    XML_HEAD +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    `<sheetData>${out.join("")}</sheetData></worksheet>`
  );
}

export function xlsxParts({ sheets = [] }) {
  const list = (sheets.length ? sheets : [{ name: "Sheet1", rows: [[""]] }]).slice(0, 20);
  const safeName = (name, i) => String(name || "Sheet" + (i + 1)).replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Sheet" + (i + 1);

  const files = [
    { name: "[Content_Types].xml", data: contentTypes(
      [["/xl/workbook.xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"]]
        .concat(list.map((_, i) => ["/xl/worksheets/sheet" + (i + 1) + ".xml", "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"])),
    ) },
    { name: "_rels/.rels", data: rels([{ id: "rId1", type: REL_DOC + "/officeDocument", target: "xl/workbook.xml" }]) },
    {
      name: "xl/workbook.xml",
      data:
        XML_HEAD +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' + NS_R + "><sheets>" +
        list.map((s, i) => `<sheet name="${esc(safeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
        "</sheets></workbook>",
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: rels(list.map((_, i) => ({ id: "rId" + (i + 1), type: REL_DOC + "/worksheet", target: "worksheets/sheet" + (i + 1) + ".xml" }))),
    },
  ];
  list.forEach((sheet, i) => files.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml", data: sheetXml(sheet.rows || []) }));
  return files;
}

export function writeXlsx(data) {
  return zipStore(xlsxParts(data));
}

/* -------------------------------- PPTX -------------------------------- */

function slideXml({ title = "", paragraphs = [] }) {
  const body = [];
  body.push(
    `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
      `<p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="10515600" cy="1325563"/></a:xfrm></p:spPr>` +
      `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"/>` +
      `<a:t>${esc(title)}</a:t></a:r></a:p></p:txBody></p:sp>`,
  );
  if (paragraphs.length) {
    const paras = paragraphs
      .map((p) => `<a:p><a:r><a:rPr lang="en-US" sz="1800"/><a:t>${esc(p)}</a:t></a:r></a:p>`)
      .join("");
    body.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
        `<p:spPr><a:xfrm><a:off x="838200" y="1825625"/><a:ext cx="10515600" cy="4351338"/></a:xfrm></p:spPr>` +
        `<p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`,
    );
  }
  return (
    XML_HEAD +
    `<p:sld ${NS_P} ${NS_A} ${NS_R}><p:cSld><p:spTree>` +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    body.join("") +
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"
  );
}

function layoutXml() {
  return (
    XML_HEAD +
    `<p:sldLayout ${NS_P} ${NS_A} ${NS_R} type="blank" preserve="1">` +
    '<p:cSld name="Blank"><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"
  );
}

function masterXml() {
  return (
    XML_HEAD +
    `<p:sldMaster ${NS_P} ${NS_A} ${NS_R}>` +
    '<p:cSld name="Master"><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    "</p:spTree></p:cSld>" +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    "</p:sldMaster>"
  );
}

function themeXml() {
  return (
    XML_HEAD +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Star">' +
    "<a:themeElements><a:clrScheme name=\"Star\">" +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="1B1A18"/></a:dk2><a:lt2><a:srgbClr val="FAF9F5"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="D97757"/></a:accent1><a:accent2><a:srgbClr val="5B7F95"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="7C9463"/></a:accent3><a:accent4><a:srgbClr val="B45535"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="8B877D"/></a:accent5><a:accent6><a:srgbClr val="3F3C36"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="B45535"/></a:hlink><a:folHlink><a:srgbClr val="6F6C63"/></a:folHlink>' +
    "</a:clrScheme>" +
    '<a:fontScheme name="Star"><a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/></a:minorFont></a:fontScheme>' +
    '<a:fmtScheme name="Star"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>' +
    '<a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
    '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst>' +
    "</a:fmtScheme></a:themeElements></a:theme>"
  );
}

export function pptxParts({ slides = [] }) {
  const list = (slides.length ? slides : [{ title: "Slide 1", paragraphs: [] }]).slice(0, 60);
  const files = [
    { name: "[Content_Types].xml", data: contentTypes(
      [
        ["/ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],
        ["/ppt/slideMasters/slideMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"],
        ["/ppt/slideLayouts/slideLayout1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"],
        ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
      ].concat(list.map((_, i) => ["/ppt/slides/slide" + (i + 1) + ".xml", "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"])),
    ) },
    { name: "_rels/.rels", data: rels([{ id: "rId1", type: REL_DOC + "/officeDocument", target: "ppt/presentation.xml" }]) },
    {
      name: "ppt/presentation.xml",
      data:
        XML_HEAD +
        `<p:presentation ${NS_P} ${NS_A} ${NS_R}>` +
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
        "<p:sldIdLst>" +
        list.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join("") +
        "</p:sldIdLst>" +
        '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>' +
        "</p:presentation>",
    },
    {
      name: "ppt/_rels/presentation.xml.rels",
      data: rels(
        [{ id: "rId1", type: REL_DOC + "/slideMaster", target: "slideMasters/slideMaster1.xml" }]
          .concat(list.map((_, i) => ({ id: "rId" + (i + 2), type: REL_DOC + "/slide", target: "slides/slide" + (i + 1) + ".xml" }))),
      ),
    },
    { name: "ppt/slideMasters/slideMaster1.xml", data: masterXml() },
    { name: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: rels([
      { id: "rId1", type: REL_DOC + "/slideLayout", target: "../slideLayouts/slideLayout1.xml" },
      { id: "rId2", type: REL_DOC + "/theme", target: "../theme/theme1.xml" },
    ]) },
    { name: "ppt/slideLayouts/slideLayout1.xml", data: layoutXml() },
    { name: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: rels([
      { id: "rId1", type: REL_DOC + "/slideMaster", target: "../slideMasters/slideMaster1.xml" },
    ]) },
    { name: "ppt/theme/theme1.xml", data: themeXml() },
  ];
  list.forEach((slide, i) => {
    files.push({ name: "ppt/slides/slide" + (i + 1) + ".xml", data: slideXml(slide) });
    files.push({
      name: "ppt/slides/_rels/slide" + (i + 1) + ".xml.rels",
      data: rels([
        { id: "rId1", type: REL_DOC + "/slideLayout", target: "../slideLayouts/slideLayout1.xml" },
        { id: "rId2", type: REL_DOC + "/slideMaster", target: "../slideMasters/slideMaster1.xml" },
      ]),
    });
  });
  return files;
}

export function writePptx(data) {
  return zipStore(pptxParts(data));
}
