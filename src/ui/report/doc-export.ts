/**
 * doc-export.ts  —  DocModel + SemanticReport → valid .docx
 *
 * Generates genuine OOXML using jszip.
 * ALL element ordering follows the OOXML schema precisely:
 *   <w:rPr>: rFonts → b/bCs → i/iCs → color → sz/szCs
 *   <w:pPr>: pStyle → pBdr → shd → spacing → ind → jc
 *   <w:trPr>: tblHeader (cnfStyle omitted — optional, ordering-sensitive)
 *   <w:tcPr>: tcW → shd → tcMar
 * Wrong ordering is the #1 cause of "Word experienced an error".
 */

import JSZip from 'jszip';
import type { SemanticReport } from '../../core/semantic.js';
import type { RequestView, TestResult } from '../../core/types.js';
import type { DocModel } from '../../core/doc-model.js';
import { FieldId } from '../../core/doc-model.js';
import { getBlob } from '../../storage/db.js';

// ─── XML helpers ──────────────────────────────────────────────────────────────

/** Escape XML special characters in text content. */
function x(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Wrap content in a <w:TAG>. */
function w(tag: string, inner: string, attrs = ''): string {
  return `<w:${tag}${attrs ? ` ${attrs}` : ''}>${inner}</w:${tag}>`;
}

// ─── Run  (<w:r>) ─────────────────────────────────────────────────────────────
// rPr schema order: rFonts, b, bCs, i, iCs, color, sz, szCs

interface RunOpts {
  bold?: boolean;
  italic?: boolean;
  color?: string;
  sz?: number;       // half-points, e.g. 22 = 11pt
  code?: boolean;    // Consolas 9pt
}

function run(text: string, opts: RunOpts = {}): string {
  // Build rPr in schema order
  const rPrParts: string[] = [];
  if (opts.code)   rPrParts.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>');
  if (opts.bold)   rPrParts.push('<w:b/><w:bCs/>');
  if (opts.italic) rPrParts.push('<w:i/><w:iCs/>');
  if (opts.color)  rPrParts.push(`<w:color w:val="${opts.color}"/>`);
  if (opts.code) {
    rPrParts.push('<w:sz w:val="18"/><w:szCs w:val="18"/>');
  } else if (opts.sz) {
    rPrParts.push(`<w:sz w:val="${opts.sz}"/><w:szCs w:val="${opts.sz}"/>`);
  }

  const rPrEl = rPrParts.length ? w('rPr', rPrParts.join('')) : '';

  // Split on \n → separate runs joined with <w:br/>
  const parts = x(text).split('\n');  // xe() applied once here
  return parts.map((part, i) =>
    w('r', `${rPrEl}<w:t xml:space="preserve">${part}</w:t>${i < parts.length - 1 ? '<w:br/>' : ''}`)
  ).join('');
}

// ─── Paragraph  (<w:p>) ───────────────────────────────────────────────────────
// pPr schema order: pStyle, pBdr, shd, spacing, ind, jc

interface ParaOpts {
  style?:        string;
  borderBottom?: boolean;
  shade?:        string;
  before?:       number;   // spacing before (twips)
  after?:        number;   // spacing after  (twips)
  indent?:       number;   // left indent    (twips)
  center?:       boolean;
}

function para(children: string, opts: ParaOpts = {}): string {
  const pPrParts: string[] = [];
  if (opts.style) pPrParts.push(`<w:pStyle w:val="${opts.style}"/>`);
  if (opts.borderBottom) pPrParts.push(
    '<w:pBdr><w:bottom w:val="single" w:sz="8" w:space="1" w:color="1F3864"/></w:pBdr>'
  );
  if (opts.shade) pPrParts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${opts.shade}"/>`);
  if (opts.before !== undefined || opts.after !== undefined) {
    const bAttr = opts.before !== undefined ? ` w:before="${opts.before}"` : '';
    const aAttr = opts.after  !== undefined ? ` w:after="${opts.after}"`   : '';
    pPrParts.push(`<w:spacing${bAttr}${aAttr}/>`);
  }
  if (opts.indent) pPrParts.push(`<w:ind w:left="${opts.indent}"/>`);
  if (opts.center) pPrParts.push('<w:jc w:val="center"/>');

  const pPrEl = pPrParts.length ? w('pPr', pPrParts.join('')) : '';
  return w('p', `${pPrEl}${children}`);
}

function pageBreak(): string {
  return para(w('r', '<w:br w:type="page"/>'));
}

function emptyPara(): string {
  return para('');
}

// ─── Navy cover table ─────────────────────────────────────────────────────────
// Generates a full-width OOXML table with navy (#1F3864) background that
// visually reproduces the browser cover page.  Every paragraph has w:shd fill
// so the shading covers the full paragraph width.

function navyCoverTable(featureName: string, meta: string, logoText: string): string {
  // tcW in this context = 100% of text-width.  Use pct type for safety.
  const cellPr = (fill: string, marginT = 200, marginB = 200, marginL = 800, marginR = 800) =>
    w('tcPr',
      `<w:tcW w:w="5000" w:type="pct"/>` +
      `<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>` +
      `<w:tcMar>` +
        `<w:top w:w="${marginT}" w:type="dxa"/>` +
        `<w:bottom w:w="${marginB}" w:type="dxa"/>` +
        `<w:left w:w="${marginL}" w:type="dxa"/>` +
        `<w:right w:w="${marginR}" w:type="dxa"/>` +
      `</w:tcMar>`
    );

  const navyPPr = (jc?: string, borderB?: boolean, before?: number, after?: number) => {
    let inner = `<w:shd w:val="clear" w:color="auto" w:fill="1F3864"/>`;
    if (borderB) inner += `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="4" w:color="4D6699"/></w:pBdr>`;
    if (before !== undefined || after !== undefined) {
      inner += `<w:spacing${before !== undefined ? ` w:before="${before}"` : ''}${after !== undefined ? ` w:after="${after}"` : ''}/>`;
    }
    if (jc) inner += `<w:jc w:val="${jc}"/>`;
    return w('pPr', inner);
  };
  const darkPPr = (jc?: string) =>
    w('pPr', `<w:shd w:val="clear" w:color="auto" w:fill="162848"/>${jc ? `<w:jc w:val="${jc}"/>` : ''}`);

  const np = (rContent: string, opts?: { jc?: string; borderB?: boolean; before?: number; after?: number }) =>
    w('p', `${navyPPr(opts?.jc, opts?.borderB, opts?.before, opts?.after)}${rContent}`);
  const dp = (rContent: string, jc?: string) =>
    w('p', `${darkPPr(jc)}${rContent}`);

  // ── Row 1: Top bar (logo left, brand right) ──────────────────────────────
  const logoRun = logoText
    ? w('r', `${w('rPr', '<w:b/><w:bCs/><w:color w:val="4DAAFF"/><w:sz w:val="26"/><w:szCs w:val="26"/>')}<w:t xml:space="preserve">${x(logoText)}</w:t>`)
    : w('r', '<w:rPr><w:sz w:val="20"/></w:rPr><w:t></w:t>');
  const brandRun = w('r', `${w('rPr', '<w:color w:val="6677AA"/><w:sz w:val="16"/><w:szCs w:val="16"/><w:kern w:val="0"/>')}<w:t>TESTTRACE</w:t>`);

  const topRow = w('tr',
    w('trPr', `<w:trHeight w:val="520" w:hRule="exact"/>`),
    w('tc',
      cellPr('1F3864', 160, 80, 600, 400) +
      np(logoRun)
    ) +
    w('tc',
      cellPr('1F3864', 160, 80, 400, 600) +
      np(brandRun, { jc: 'right' })
    )
  );

  // ── Row 2: Main title ─────────────────────────────────────────────────────
  const eyebrowRun = w('r', `${w('rPr', '<w:color w:val="7788BB"/><w:sz w:val="20"/><w:szCs w:val="20"/>')}<w:t>QUALITY ASSURANCE</w:t>`);
  const reportRun  = w('r', `${w('rPr', '<w:b/><w:bCs/><w:color w:val="FFFFFF"/><w:sz w:val="96"/><w:szCs w:val="96"/>')}<w:t>REPORT</w:t>`);
  const featureRun = featureName
    ? w('r', `${w('rPr', '<w:b/><w:bCs/><w:color w:val="FFFFFF"/><w:sz w:val="36"/><w:szCs w:val="36"/>')}<w:t xml:space="preserve">${x(featureName)}</w:t>`)
    : w('r', `${w('rPr', '<w:i/><w:iCs/><w:color w:val="5566AA"/><w:sz w:val="26"/><w:szCs w:val="26"/>')}<w:t>[Add project / feature name]</w:t>`);

  const titleRow = w('tr',
    w('trPr', `<w:trHeight w:val="4680" w:hRule="exact"/>`),
    w('tc',
      `<w:tcPr><w:gridSpan w:val="2"/><w:shd w:val="clear" w:color="auto" w:fill="1F3864"/><w:tcMar><w:top w:w="240" w:type="dxa"/><w:bottom w:w="240" w:type="dxa"/><w:left w:w="800" w:type="dxa"/><w:right w:w="800" w:type="dxa"/></w:tcMar><w:vAlign w:val="center"/></w:tcPr>` +
      np(eyebrowRun, { after: 80 }) +
      np(reportRun, { after: 280 }) +
      np('', { borderB: true, after: 240 }) +  // separator rule
      np(featureRun, { after: 0 })
    )
  );

  // ── Row 3: Info footer (darker navy) ─────────────────────────────────────
  const metaRun  = w('r', `${w('rPr', '<w:color w:val="8899BB"/><w:sz w:val="18"/><w:szCs w:val="18"/>')}<w:t xml:space="preserve">${x(meta)}</w:t>`);
  const attrRun  = w('r', `${w('rPr', '<w:color w:val="445577"/><w:sz w:val="16"/><w:szCs w:val="16"/>')}<w:t>Generated by TestTrace  ·  All evidence captured locally</w:t>`);

  const footerRow = w('tr',
    w('trPr', `<w:trHeight w:val="1440" w:hRule="exact"/>`),
    w('tc',
      `<w:tcPr><w:gridSpan w:val="2"/><w:shd w:val="clear" w:color="auto" w:fill="162848"/><w:tcMar><w:top w:w="180" w:type="dxa"/><w:bottom w:w="180" w:type="dxa"/><w:left w:w="800" w:type="dxa"/><w:right w:w="800" w:type="dxa"/></w:tcMar></w:tcPr>` +
      dp(metaRun) +
      dp(attrRun, 'right')
    )
  );

  // Table properties — 100% width, no borders
  const noBorders = ['top','left','bottom','right','insideH','insideV']
    .map(s => `<w:${s} w:val="none" w:sz="0" w:space="0" w:color="auto"/>`)
    .join('');

  const tblPr = w('tblPr',
    '<w:tblW w:w="5000" w:type="pct"/>' +
    w('tblBorders', noBorders)
  );
  const tblGrid = w('tblGrid',
    '<w:gridCol w:w="4680"/><w:gridCol w:w="4680"/>'
  );

  return w('tbl', `${tblPr}${tblGrid}${topRow}${titleRow}${footerRow}`);
}

// ─── Table  (<w:tbl>) ─────────────────────────────────────────────────────────
// tcPr schema order: tcW, shd, tcMar
// trPr schema order: tblHeader  (cnfStyle omitted — ordering-sensitive)

function buildTable(headers: string[], rows: string[][]): string {
  const numCols = headers.length || 1;
  // A4 content width at 1 inch margins: 11906 - 2×1418 = 9070 twips
  const contentW = 9070;
  const colW     = Math.floor(contentW / numCols);

  // table-level borders
  const sides   = ['top','left','bottom','right','insideH','insideV'];
  const borders = sides.map(s =>
    `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="BBBBBB"/>`
  ).join('');

  const tblPr = w('tblPr',
    `<w:tblW w:w="${contentW}" w:type="dxa"/>` +
    w('tblBorders', borders)
  );
  const tblGrid = w('tblGrid',
    Array.from({ length: numCols }, () => `<w:gridCol w:w="${colW}"/>`).join('')
  );

  // Cell builder — tcPr order: tcW → shd → tcMar
  const mkCell = (text: string, isHeader: boolean, rowShade?: string): string => {
    const tcPrParts: string[] = [];
    tcPrParts.push(`<w:tcW w:w="${colW}" w:type="dxa"/>`);
    if (isHeader) {
      tcPrParts.push('<w:shd w:val="clear" w:color="auto" w:fill="1F3864"/>');
    } else if (rowShade) {
      tcPrParts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${rowShade}"/>`);
    }
    tcPrParts.push(
      '<w:tcMar>' +
        '<w:top w:w="60" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/>' +
        '<w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/>' +
      '</w:tcMar>'
    );
    const tcPr = w('tcPr', tcPrParts.join(''));
    const content = para(
      run(text, { bold: isHeader, color: isHeader ? 'FFFFFF' : undefined, sz: isHeader ? 18 : 20 })
    );
    return w('tc', `${tcPr}${content}`);
  };

  // Header row — trPr: tblHeader only
  const hRow = w('tr',
    w('trPr', '<w:tblHeader/>') +
    headers.map(h => mkCell(h, true)).join('')
  );

  // Data rows
  const dRows = rows.map((cells, ri) => {
    const shade = ri % 2 === 1 ? 'F5F6F8' : undefined;
    return w('tr', cells.map(c => mkCell(String(c ?? ''), false, shade)).join(''));
  }).join('');

  return w('tbl', `${tblPr}${tblGrid}${hRow}${dRows}`);
}

// ─── Image  (DrawingML inline) ────────────────────────────────────────────────

let _imgSeq = 0;

function makeImagePara(rId: string, wEmu: number, hEmu: number): string {
  _imgSeq++;
  const id = _imgSeq;
  const xml =
    '<w:drawing>' +
      `<wp:inline distT="0" distB="0" distL="0" distR="0">` +
        `<wp:extent cx="${wEmu}" cy="${hEmu}"/>` +
        `<wp:effectExtent l="0" t="0" r="0" b="0"/>` +
        `<wp:docPr id="${id}" name="img${id}"/>` +
        `<wp:cNvGraphicFramePr>` +
          `<a:graphicFrameLocks noChangeAspect="1"/>` +
        `</wp:cNvGraphicFramePr>` +
        `<a:graphic>` +
          `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
            `<pic:pic>` +
              `<pic:nvPicPr>` +
                `<pic:cNvPr id="${id}" name="img${id}"/>` +
                `<pic:cNvPicPr><a:picLocks noChangeAspect="1"/></pic:cNvPicPr>` +
              `</pic:nvPicPr>` +
              `<pic:blipFill>` +
                `<a:blip r:embed="${rId}"/>` +
                `<a:stretch><a:fillRect/></a:stretch>` +
              `</pic:blipFill>` +
              `<pic:spPr>` +
                `<a:xfrm><a:off x="0" y="0"/><a:ext cx="${wEmu}" cy="${hEmu}"/></a:xfrm>` +
                `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>` +
              `</pic:spPr>` +
            `</pic:pic>` +
          `</a:graphicData>` +
        `</a:graphic>` +
      `</wp:inline>` +
    '</w:drawing>';
  return para(w('r', xml));
}

// ─── ZIP parts ────────────────────────────────────────────────────────────────

function makeContentTypes(imgFiles: Array<{ name: string; mime: string }>): string {
  const overrides = imgFiles.map(f =>
    `<Override PartName="/word/media/${f.name}" ContentType="${f.mime}"/>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml"   ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  ${overrides}
</Types>`;
}

function makeRootRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
</Relationships>`;
}

function makeDocRels(imgRels: Array<{ id: string; file: string }>): string {
  const entries = imgRels.map(r =>
    `<Relationship Id="${r.id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${r.file}"/>`
  ).join('\n  ');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId100" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"   Target="styles.xml"/>
  <Relationship Id="rId101" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  ${entries}
</Relationships>`;
}

function makeStyles(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr>
      <w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>
      <w:sz w:val="22"/><w:szCs w:val="22"/>
    </w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr>
      <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
    </w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
  </w:style>
</w:styles>`;
}

function makeSettings(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:defaultTabStop w:val="720"/>
</w:settings>`;
}

function makeCoreProps(title: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties
  xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${x(title)}</dc:title>
  <dc:creator>TestTrace</dc:creator>
  <dcterms:created xsi:type="dcterms:W3CDTF">${new Date().toISOString()}</dcterms:created>
</cp:coreProperties>`;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function fld(doc: DocModel, id: string, fb = ''): string {
  return (doc.fields[id] ?? fb).trim() || fb;
}
function fmtDur(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function fmtDateLong(ts: number): string {
  return new Date(ts).toLocaleString([], { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function autoVerdict(reports: SemanticReport[]): string {
  const i = reports.reduce((s, r) => s + r.issues.length, 0);
  const e = reports.reduce((s, r) => s + r.failedApiCalls, 0);
  const a = reports.reduce((s, r) => s + r.totalApiCalls, 0);
  const p: string[] = [];
  if (i > 0) p.push(`${i} issue${i !== 1 ? 's' : ''} found`);
  if (e > 0) p.push(`${e} API error${e !== 1 ? 's' : ''}`);
  if (a > 0 && e === 0) p.push(`all ${a} API calls successful`);
  return p.length ? p.join(' · ') : 'No issues detected.';
}
const RL: Record<TestResult, string> = {
  pass: 'Pass', partial: 'Partial Pass', fail: 'Fail', blocked: 'Blocked', in_progress: 'In Progress',
};

type ApiSt = 'pending' | 'complete' | 'error' | 'after';
function apiState(r: RequestView, ts: number): ApiSt {
  if (r.startedAt > ts) return 'after';
  if (!r.endedAt || r.endedAt > ts) return 'pending';
  if (r.outcome !== 'success') return 'error';
  return 'complete';
}

export async function exportToDocx(
  reports: SemanticReport[],
  docModel: DocModel,
  _ps?: number[],
  _bl?: unknown[],
): Promise<Blob> {
  _imgSeq = 0;

  const zip      = new JSZip();
  const body:    string[] = [];
  const imgRels: Array<{ id: string; file: string }>   = [];
  const imgFiles: Array<{ name: string; mime: string }> = [];
  let   imgN = 0;

  async function embedImg(blobKey: string, origW: number, origH: number): Promise<string> {
    const rec = await getBlob(blobKey);
    if (!rec) return para(run('[Screenshot not available]', { italic: true, color: '999999' }));
    imgN++;
    const rId  = `rId${imgN}`;
    const mime = rec.mimeType;
    const ext  = mime === 'image/png' ? 'png' : 'jpeg';
    const name = `image${imgN}.${ext}`;
    zip.folder('word')!.folder('media')!.file(name, rec.data);
    imgRels.push({ id: rId, file: name });
    imgFiles.push({ name, mime });
    // 15cm @ 914400 EMU/inch, 1cm = 360000 EMU
    const wEmu = 5400000;
    const hEmu = origW > 0 ? Math.round(wEmu * origH / origW) : Math.round(wEmu * 9 / 16);
    return makeImagePara(rId, wEmu, hEmu);
  }

  const firstEnv = reports[0]?.session.environment;
  const genDate  = new Date().toLocaleString('en-US', {
    day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
  const featureName = fld(docModel, FieldId.docTitle(), '');
  const logoId      = fld(docModel, FieldId.docLogo(), 'none');
  const logoText = { walmart: '✦ Walmart', sams: "Sam's Club", custom: '[Logo]', none: '' }[logoId] ?? '';

  const coverMeta = [
    `Generated on ${genDate}`,
    firstEnv ? `Chrome ${firstEnv.chromeVersion}` : '',
    firstEnv?.platform ?? '',
  ].filter(Boolean).join('  ·  ');

  // ── Cover: navy full-bleed table ──────────────────────────────────────────
  // The navyCoverTable function generates a properly shaded OOXML table
  // that reproduces the dark navy cover page exactly as it appears in the browser.
  body.push(
    navyCoverTable(featureName, coverMeta, logoText),
    pageBreak(),
  );

  // ── Table of Contents ─────────────────────────────────────────────────────
  body.push(
    para(run('Contents', { bold: true, sz: 32, color: '1F3864' }), { borderBottom: true, after: 160 }),
    para(run('1.  Executive Summary', { sz: 22 })),
    para(run('2.  Test Cases', { sz: 22 })),
  );
  reports.forEach((r, i) => {
    body.push(para(
      run(`    ${i + 1}.  ${fld(docModel, FieldId.sessionTitle(r.session.id), r.session.testCaseName)}`, { sz: 22 }),
      { indent: 360 }
    ));
  });
  if (reports.some(r => (r.apiSummary?.length ?? 0) > 0)) {
    body.push(para(run(`${reports.length + 1}.  Technical Details`, { sz: 22 })));
  }
  body.push(pageBreak());

  // ── Executive Summary ─────────────────────────────────────────────────────
  body.push(
    para(run('Executive Summary', { bold: true, sz: 32, color: '1F3864' }), { borderBottom: true, after: 160 }),
    para(run(fld(docModel, FieldId.execVerdict(), autoVerdict(reports)), { sz: 22, italic: true, color: '444444' }), { after: 200 }),
    buildTable(
      ['#', 'Test Case', 'Functional Pass', 'SLA Compliance', 'Issues', 'Duration', 'Result'],
      reports.map((r, i) => {
        const slaOn  = (r.session.apiSlaSec ?? 3) < 100;
        const fnPass = r.failedApiCalls === 0 && r.session.counters.pageErrors === 0;
        const sla    = !slaOn ? 'N/A' : r.performance.slaPercent >= 95
          ? `Pass (${r.performance.slaPercent}%)` : `Fail (${r.performance.slaPercent}%)`;
        return [
          String(i + 1),
          fld(docModel, FieldId.sessionTitle(r.session.id), r.session.testCaseName),
          fnPass ? 'Pass' : 'Fail', sla,
          String(r.issues.length || '0'),
          r.session.endedAt ? fmtDur(r.session.endedAt - r.session.startedAt) : '—',
          RL[r.result],
        ];
      }),
    ),
    emptyPara(),
  );

  const revNotes = fld(docModel, FieldId.execReviewerNotes());
  if (revNotes) {
    body.push(
      para(run('Reviewer Notes', { bold: true, sz: 24 }), { before: 160 }),
      para(run(revNotes, { sz: 22, italic: true })),
    );
  }
  body.push(pageBreak());

  // ── Test Case Sections ────────────────────────────────────────────────────
  for (let si = 0; si < reports.length; si++) {
    const r = reports[si]!;
    const { session } = r;
    const slaSec    = session.apiSlaSec ?? 3;
    const slaActive = slaSec < 100;
    const title     = fld(docModel, FieldId.sessionTitle(session.id), session.testCaseName);

    body.push(
      para(run(`${si + 1}.  ${title}`, { bold: true, sz: 36, color: '1F3864' }), { borderBottom: true, before: 200, after: 120 }),
      buildTable(
        ['Field', 'Value', 'Field', 'Value'],
        [
          ['Date',     fmtDateLong(session.startedAt),  'Duration', session.endedAt ? fmtDur(session.endedAt - session.startedAt) : '—'],
          ['Browser',  `Chrome ${session.environment.chromeVersion}`, 'Platform', session.environment.platform],
          ['Scope',    session.scopeOrigins.join(', '), 'API SLA',  slaActive ? `${slaSec}s` : 'Disabled'],
          ['Viewport', session.environment.viewport
            ? `${session.environment.viewport.width}x${session.environment.viewport.height}` : '—',
            'Result', RL[session.testResult]],
        ],
      ),
    );

    if (r.issues.length > 0) {
      body.push(
        para(run(`Issues Found (${r.issues.length})`, { bold: true, sz: 24, color: '8B0000' }), { before: 160 }),
        buildTable(
          ['Severity', 'Description', 'Status', 'Notes'],
          r.issues.map(iss => [
            iss.severity.toUpperCase(),
            iss.title + (iss.apiPath ? `\n${iss.apiMethod ?? ''} ${iss.apiPath}` : ''),
            iss.status,
            fld(docModel, FieldId.issueNotes(iss.id)),
          ]),
        ),
      );
    }

    const sessNotes = fld(docModel, FieldId.sessionNotes(session.id));
    if (sessNotes) {
      body.push(para(run(sessNotes, { sz: 22, italic: true }), { before: 80 }));
    }

    // Steps
    for (const step of r.guidedSteps ?? []) {
      const isBase  = step.screenshot.trigger === 'session_start';
      const label   = isBase ? 'BASELINE' : `STEP ${step.stepNumber - 1}`;
      const before  = step.apisAround.filter(req => req.startedAt <= step.ts);
      const inflight = before.filter(req => !req.endedAt || req.endedAt > step.ts);
      const errd    = before.filter(req => req.endedAt && req.endedAt <= step.ts && req.outcome !== 'success');
      const state   = isBase ? 'Baseline - Session start'
        : errd.length   ? `Error state - ${errd.length} API${errd.length !== 1 ? 's' : ''} failed`
        : inflight.length ? `Loading state - ${inflight.length} API${inflight.length !== 1 ? 's' : ''} in-flight`
        : 'Loaded state - All APIs resolved';
      const sc = isBase ? '555555' : errd.length ? '8B0000' : inflight.length ? '8A4500' : '1D6B38';
      const sn = fld(docModel, FieldId.stepHeading(session.id, step.stepNumber),
        step.screenName + (step.sectionName ? ` - ${step.sectionName}` : ''));

      body.push(
        para(
          run(`${label}  `, { bold: true, sz: 20, color: '1F3864' }) +
          run(sn, { sz: 20 }) +
          run(`  ${fmtTime(step.ts)}`, { sz: 18, color: '999999' }),
          { shade: 'F0F0F0', before: 280, after: 60 }
        ),
        para(run(state, { sz: 20, italic: true, color: sc })),
      );

      if (step.precedingAction && !isBase) {
        body.push(para(run(`Action: "${step.precedingAction}"`, { sz: 20, italic: true, color: '666666' })));
      }

      // Screenshot
      body.push(await embedImg(step.screenshot.blobKey, step.screenshot.width ?? 1280, step.screenshot.height ?? 720));

      // Network table
      if (step.apisAround.length > 0) {
        body.push(para(run(`Network Activity - ${step.apisAround.length} requests`, { bold: true, sz: 20 })));
        body.push(buildTable(
          ['Method', 'Endpoint', 'Status', 'Duration', 'State'],
          step.apisAround.map(req => {
            const s   = apiState(req, step.ts);
            const dur = s === 'pending'
              ? `${((step.ts - req.startedAt) / 1000).toFixed(1)}s elapsed`
              : req.durationMs ? `${Math.round(req.durationMs)}ms` : '-';
            const stLbl: Record<ApiSt, string> = { pending: 'In-flight', complete: 'Complete', error: 'Error', after: 'After' };
            return [req.method, req.path, String(req.statusCode ?? '-'), dur, stLbl[s]];
          }),
        ));
      }

      // Errors
      if (step.errorsInWindow.length > 0) {
        body.push(para(run(`Browser Errors (${step.errorsInWindow.length})`, { bold: true, sz: 20, color: '8B0000' })));
        body.push(buildTable(
          ['Type', 'Message'],
          step.errorsInWindow.slice(0, 5).map(e => [
            e.kind.replace('_', ' '),
            'message' in e ? (e as { message: string }).message.slice(0, 180) : '',
          ]),
        ));
      }

      // Notes
      const notes = fld(docModel, FieldId.stepNotes(session.id, step.stepNumber));
      body.push(
        para(run('Tester notes:', { bold: true, sz: 20, color: '555555' }), { before: 160 }),
        para(run(notes || '-', { sz: 22, italic: !notes })),
        emptyPara(),
      );
    }

    if (si < reports.length - 1) body.push(pageBreak());
  }

  // ── Technical Details ─────────────────────────────────────────────────────
  const apis = reports.flatMap(r => r.apiSummary ?? []);
  if (apis.length > 0) {
    body.push(
      pageBreak(),
      para(run('Technical Details', { bold: true, sz: 32, color: '1F3864' }), { borderBottom: true, after: 160 }),
      para(run(`API Endpoint Summary - ${apis.length} unique endpoints`, { sz: 22, italic: true, color: '444444' }), { after: 200 }),
      buildTable(
        ['Method', 'Endpoint', 'Calls', 'Errors', 'Avg', 'Max'],
        apis.slice(0, 60).map(e => [
          e.method, e.path, String(e.callCount),
          String(e.failureCount || '0'),
          `${Math.round(e.avgDurationMs)}ms`,
          `${Math.round(e.maxDurationMs)}ms`,
        ]),
      ),
    );
  }

  // ── Footer + section properties ───────────────────────────────────────────
  body.push(
    emptyPara(),
    para(run('TestTrace  -  All evidence captured locally  -  Nothing sent externally', {
      sz: 16, italic: true, color: '999999',
    }), { center: true }),
  );

  // A4 (210x297mm) in twips, 25mm margins
  const sectPr = `<w:sectPr>
    <w:pgSz w:w="11906" w:h="16838"/>
    <w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/>
  </w:sectPr>`;

  // ── Full namespace set required by Word for DrawingML ─────────────────────
  const NS = [
    'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"',
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"',
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
    'mc:Ignorable="wpc"',
  ].join(' ');

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<w:document ${NS}>\n<w:body>\n` +
    body.join('\n') +
    `\n${sectPr}\n</w:body>\n</w:document>`;

  // ── Assemble ZIP ──────────────────────────────────────────────────────────
  zip.file('[Content_Types].xml', makeContentTypes(imgFiles));
  zip.folder('_rels')!.file('.rels', makeRootRels());
  zip.folder('docProps')!.file('core.xml', makeCoreProps(featureName || 'Quality Assurance Report'));
  const word = zip.folder('word')!;
  word.file('document.xml', docXml);
  word.file('styles.xml',   makeStyles());
  word.file('settings.xml', makeSettings());
  word.folder('_rels')!.file('document.xml.rels', makeDocRels(imgRels));

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
