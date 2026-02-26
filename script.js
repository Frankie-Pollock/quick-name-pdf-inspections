// ==========================================
// V3 — FULLY AUTOMATIC MULTI–PAGE PROCESSOR
// MESSAGE 1 OF 3 — CORE ENGINE + CLASSIFICATION
// ==========================================

// ---------- OCR UTILS ----------
function clean(str) {
  return (str || "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

async function ocrTopLine(canvas) {
  const ctx = canvas.getContext("2d");
  const h = Math.floor(canvas.height * 0.12);  // top 12% of page
  const w = canvas.width;

  const top = document.createElement("canvas");
  top.width = w;
  top.height = h;
  top.getContext("2d").drawImage(canvas, 0, 0, w, h, 0, 0, w, h);

  const res = await Tesseract.recognize(top, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 6
  });

  const text = clean(res?.data?.text || "");
  return text.split(/\s+/).slice(0, 12).join(" "); // first few words only
}

// ---------- BLANK PAGE TEST ----------
function isBlankPage(canvas) {
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  let sum = 0;
  let count = 0;

  for (let i = 0; i < img.length; i += 4) {
    const r = img[i], g = img[i+1], b = img[i+2];
    const y = (0.299*r + 0.587*g + 0.114*b);
    sum += y; count++;
  }

  const avg = sum / count;
  return avg > 248; // very close to pure white => blank page
}

// ---------- PAGE RENDER ----------
async function renderPdfPage(blob, pageNum, scale = 2) {
  const buf = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(pageNum);

  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = vp.width;
  c.height = vp.height;

  await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;

  return c;
}

// ---------- MULTI-PAGE EXTRACTION ----------
async function extractAllPages(blob) {
  const buf = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const vp = page.getViewport({ scale: 2 });
    const c = document.createElement("canvas");
    c.width = vp.width;
    c.height = vp.height;
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    pages.push(c);
  }
  return pages;
}

// ==========================================
// PART 1 — JOB TYPE DETECTION (PAGE 1)
// ==========================================

function detectJobType(page1TopLine) {
  if (page1TopLine.includes("MULTI TRADE WORKS")) {
    return "AC_GOLD_MTW";
  }
  if (page1TopLine.includes("INTERNAL VOID PACK FOR")) {
    return "INTERNAL_BMD";
  }
  return "UNKNOWN";
}

// ==========================================
// PART 2 — INTERNAL BMD SECTION LOGIC
// ==========================================

function isRechargeHeader(text) {
  return (
    text.includes("RECHARGE WORK") ||
    text.includes("RECHARGEABLE WORK")
  );
}

function isWorkHeader(text) {
  // Any "<X> WORK" pattern
  return /\b[A-Z]+\s+WORK\b/.test(text);
}

// ==========================================
// PART 3 — AC GOLD MTW LOGIC
// ==========================================

function isBmdHeader(text) {
  return text.includes("BMD WORKS REQUIRED");
}

// ==========================================
// MAIN CLASSIFIER FOR MULTI-PAGE FIRST PDF
// Returns an array of virtual documents:
// [
//   { nameType:"CHECKLIST", pages:[canvas] },
//   { nameType:"MTW", pages:[canvas...] },
//   { nameType:"BMD", pages:[canvas...] },
//   { nameType:"RECHARGE", pages:[canvas...] }
// ]
// ==========================================

async function processMultiPagePdf(blob) {
  const pages = await extractAllPages(blob);
  const out = [];

  // ------------------------------------------
  // PAGE 1 — ALWAYS CHECKLIST
  // ------------------------------------------
  const page1 = pages[0];
  const page1Top = await ocrTopLine(page1);
  const jobType = detectJobType(page1Top);

  out.push({ nameType: "CHECKLIST", pages: [page1] });

  // ------------------------------------------
  // INTERNAL BMD PROCESSING
  // ------------------------------------------
  if (jobType === "INTERNAL_BMD") {
    const second = pages[1];
    const top2 = await ocrTopLine(second);

    let i = 1;

    // CASE 1 — RECHARGEABLE SECTION PRESENT
    if (isRechargeHeader(top2)) {
      // Collect Recharge pages
      const rechargePages = [];
      while (i < pages.length) {
        const p = pages[i];
        if (isBlankPage(p)) { i++; continue; }

        const top = await ocrTopLine(p);
        if (i !== 1 && isWorkHeader(top)) break; // NEW WORK TYPE => stop recharge set

        rechargePages.push(p);
        i++;
      }

      if (rechargePages.length) {
        out.push({ nameType: "RECHARGE", pages: rechargePages });
      }

      // Remaining pages = BMD
      const bmdPages = [];
      while (i < pages.length) {
        const p = pages[i];
        if (!isBlankPage(p)) bmdPages.push(p);
        i++;
      }
      if (bmdPages.length) {
        out.push({ nameType: "BMD", pages: bmdPages });
      }

      return out;
    }

    // CASE 2 — NO RECHARGE, EVERYTHING = BMD
    const bmdPages = [];
    for (let j = 1; j < pages.length; j++) {
      const p = pages[j];
      if (!isBlankPage(p)) bmdPages.push(p);
    }
    if (bmdPages.length) {
      out.push({ nameType: "BMD", pages: bmdPages });
    }
    return out;
  }

  // ------------------------------------------
  // AC GOLD MTW PROCESSING
  // ------------------------------------------
  if (jobType === "AC_GOLD_MTW") {
    let mode = "MTW";
    const mtw = [];
    const bmd = [];

    for (let i = 1; i < pages.length; i++) {
      const p = pages[i];
      if (isBlankPage(p)) continue;

      const top = await ocrTopLine(p);

      if (mode === "MTW") {
        if (isBmdHeader(top)) {
          mode = "BMD";
          bmd.push(p);
        } else {
          mtw.push(p);
        }
      } else {
        bmd.push(p);
      }
    }

    if (mtw.length) out.push({ nameType: "MTW", pages: mtw });
    if (bmd.length) out.push({ nameType: "BMD", pages: bmd });

    return out;
  }

  // ------------------------------------------
  // UNKNOWN — treat all pages as BMD
  // ------------------------------------------
  const all = [];
  for (let i = 1; i < pages.length; i++) {
    if (!isBlankPage(pages[i])) all.push(pages[i]);
  }
  out.push({ nameType: "BMD", pages: all });
  return out;
}

// ============================================
// PDF EXPORT (MULTI-PAGE DOCUMENT CREATION)
// ============================================

async function exportCanvasGroupToPdf(pages) {
  const { PDFDocument } = PDFLib;

  const pdfDoc = await PDFDocument.create();

  for (const canvas of pages) {
    const imgData = canvas.toDataURL("image/jpeg", 0.92);
    const jpeg = await pdfDoc.embedJpg(imgData);

    const page = pdfDoc.addPage([canvas.width, canvas.height]);
    page.drawImage(jpeg, { x: 0, y: 0, width: canvas.width, height: canvas.height });
  }

  const bytes = await pdfDoc.save();
  return new Blob([bytes], { type: "application/pdf" });
}

// ============================================
// FILENAME GENERATION RULES
// ============================================

function generateName(address, docType, index = null) {
  address = address.toUpperCase();

  switch (docType) {

    case "CHECKLIST":
      return `${address} - VOID INSPECTION CHECKLIST.pdf`;

    case "MTW":
      return `${address} - VOID AC GOLD MTW (${index}).pdf`;

    case "BMD":
      return `${address} - VOID BMD WORKS (${index}).pdf`;

    case "RECHARGE":
      // Rechargeable Repairs is NOT numbered
      return `${address} - VOID_RECHARGEABLE_Works.pdf`;

    default:
      return `${address} - VOID.pdf`;
  }
}

// ============================================
// ROUTE OUTPUT FILES TO CORRECT FOLDER
// ============================================

function pickOutputFolder(filename) {
  const n = filename.toUpperCase();

  if (n.includes("INSPECTION CHECKLIST")) return "Inspection Checklist";

  if (n.includes("AC GOLD MTW")) return "MTW";
  if (n.includes("BMD WORKS")) return "NEC Lines";      // your v2 mapping

  if (n.includes("RECHARGEABLE_WORKS")) return "Rechargeable Repairs";

  // fallback
  return "";
}

// ============================================
// CONVERT CLASSIFIED GROUPS → NAMED PDF FILES
// ============================================

async function buildOutputFromGroups(address, groups) {
  const out = [];
  let mtwCount = 1;
  let bmdCount = 1;

  for (const group of groups) {
    let filename = "";
    let pdfBlob = null;

    switch (group.nameType) {

      case "CHECKLIST":
        pdfBlob = await exportCanvasGroupToPdf(group.pages);
        filename = generateName(address, "CHECKLIST");
        break;

      case "MTW":
        pdfBlob = await exportCanvasGroupToPdf(group.pages);
        filename = generateName(address, "MTW", mtwCount++);
        break;

      case "BMD":
        pdfBlob = await exportCanvasGroupToPdf(group.pages);
        filename = generateName(address, "BMD", bmdCount++);
        break;

      case "RECHARGE":
        pdfBlob = await exportCanvasGroupToPdf(group.pages);
        filename = generateName(address, "RECHARGE");
        break;
    }

    const folder = pickOutputFolder(filename);
    out.push({ folder, filename, blob: pdfBlob });
  }

  return out;
}

// ============================================
// PROCESS ALL WORK ORDERS (PDFs after the first)
// USING YOUR EXISTING V2 WORK ORDER LOGIC
// ============================================

async function processWorkOrders(address, pdfBlobs) {
  const results = [];

  for (const blob of pdfBlobs) {
    const named = await autoNameWorkOrderPdf(address, blob);
    // -> returns { folder, filename, blob }

    results.push(named);
  }

  return results;
}

// ============================================
// GENERAL HELPERS
// ============================================
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function uniquify(name, existing) {
  if (!existing.has(name)) {
    existing.add(name);
    return name;
  }
  const extIdx = name.lastIndexOf(".");
  const base = extIdx >= 0 ? name.slice(0, extIdx) : name;
  const ext = extIdx >= 0 ? name.slice(extIdx) : "";
  let i = 2;
  while (existing.has(`${base} (${i})${ext}`)) i++;
  const unique = `${base} (${i})${ext}`;
  existing.add(unique);
  return unique;
}

function uppercaseClean(s) {
  return (s || "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

// ============================================
// WORK ORDER OCR CONSTANTS (from your v2)
// ============================================
const CROP_TOP_PCT = 0.30;
const CROP_BOTTOM_PCT = 0.43;
const CROP_LEFT_PCT = 0.05;
const CROP_RIGHT_PCT = 0.95;

const CONTRACTOR_TOP_PCT = 0.18;
const CONTRACTOR_BOTTOM_PCT = 0.255;
const CONTRACTOR_LEFT_PCT = CROP_LEFT_PCT;
const CONTRACTOR_RIGHT_PCT = CROP_RIGHT_PCT;

// Reuse render from Message 1 (alias)
async function renderPdfPageToCanvas(blob, pageNum = 1, scale = 2.2) {
  return await renderPdfPage(blob, pageNum, scale);
}

function cropRegion(pageCanvas, leftPct, rightPct, topPct, bottomPct) {
  const W = pageCanvas.width;
  const H = pageCanvas.height;

  const x0 = Math.round(W * leftPct);
  const x1 = Math.round(W * rightPct);
  const y0 = Math.round(H * topPct);
  const y1 = Math.round(H * bottomPct);

  const w = Math.max(10, x1 - x0);
  const h = Math.max(10, y1 - y0);

  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  const oc = out.getContext("2d");
  oc.drawImage(pageCanvas, x0, y0, w, h, 0, 0, w, h);
  return out;
}

function cropFixedDescRegion(pageCanvas) {
  return cropRegion(pageCanvas, CROP_LEFT_PCT, CROP_RIGHT_PCT, CROP_TOP_PCT, CROP_BOTTOM_PCT);
}

function cropFixedContractorRegion(pageCanvas) {
  return cropRegion(pageCanvas, CONTRACTOR_LEFT_PCT, CONTRACTOR_RIGHT_PCT, CONTRACTOR_TOP_PCT, CONTRACTOR_BOTTOM_PCT);
}

// Image enhancement (same spirit as v2)
function enhanceForOcr(srcCanvas) {
  const w = srcCanvas.width;
  const h = srcCanvas.height;
  const dst = document.createElement("canvas");
  dst.width = w;
  dst.height = h;
  const dctx = dst.getContext("2d");
  dctx.drawImage(srcCanvas, 0, 0);

  const img = dctx.getImageData(0, 0, w, h);
  const data = img.data;

  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    hist[y]++;
    data[i] = data[i + 1] = data[i + 2] = y;
  }

  const total = w * h;
  const clip = Math.max(1, Math.round(total * 0.01));
  let lo = 0, hi = 255, acc = 0;

  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > clip) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > clip) { hi = v; break; } }

  const range = Math.max(1, hi - lo);

  for (let i = 0; i < data.length; i += 4) {
    let y = data[i];
    y = ((y - lo) * 255 / range);
    y = Math.max(0, Math.min(255, y));
    if (y > 170) y = Math.min(255, y + 20);
    data[i] = data[i + 1] = data[i + 2] = y;
  }

  dctx.putImageData(img, 0, 0);
  return dst;
}

// OCR helpers
async function ocrCroppedSingleLine(cropCanvas) {
  const enhanced = enhanceForOcr(cropCanvas);
  const res1 = await Tesseract.recognize(enhanced, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 7
  });

  let lines = (res1?.data?.text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length) return uppercaseClean(lines[0]);

  const res2 = await Tesseract.recognize(enhanced, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 6
  });

  lines = (res2?.data?.text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.length ? uppercaseClean(lines[0]) : "";
}

async function ocrCroppedContractor(cropCanvas) {
  const enhanced = enhanceForOcr(cropCanvas);
  const res = await Tesseract.recognize(enhanced, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 6
  });
  return uppercaseClean(res?.data?.text || "");
}

// Fuzzy helpers
function lev(a, b) {
  a = a || ""; b = b || "";
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}
function fuzzyContains(hay, needle, maxDist) {
  const h = uppercaseClean(hay).split(/\s+/);
  const n = uppercaseClean(needle).split(/\s+/);
  const win = n.length;
  for (let i = 0; i <= h.length - win; i++) {
    const s = h.slice(i, i + win).join(" ");
    if (lev(s, n.join(" ")) <= maxDist) return true;
  }
  return false;
}

// Work Order mapping (your v2 rules)
function mapWorkOrderDescription(desc, contractorText) {
  const hay = `${uppercaseClean(desc)} ${uppercaseClean(contractorText)}`.trim();

  if (fuzzyContains(hay, "ASPECT CONTRACT", 3)) return "ASBESTOS REMOVAL";
  if (fuzzyContains(hay, "LIFE ENVIRONMENTAL", 3) || fuzzyContains(hay, "LIFE ENVIROMENTAL", 4)) return "ASBESTOS SURVEY";
  if (fuzzyContains(hay, "RODGERS ELECTRICAL", 3)) return "RODGERS ISOLATOR";

  if (fuzzyContains(hay, "DEEP", 1)) return "PERFECT DEEP";
  if (fuzzyContains(hay, "SPARKLE", 2)) return "PERFECT SPARKLE";

  return null;
}

// Folder routing for Work Orders (your v2 rules)
function pickFolderByFilename(finalName) {
  const n = (finalName || "").toUpperCase();

  const hasAsbestos = n.includes("ASBESTOS");
  const hasContractor = n.includes("LIFE") || n.includes("ASPECT");
  const hasRemovalOrSurvey = n.includes("REMOVAL") || n.includes("SURVEY");

  if (hasAsbestos || hasContractor || (hasRemovalOrSurvey && (hasAsbestos || hasContractor))) {
    return "Asbestos";
  }

  if (n.includes("INSPECTION CHECKLIST")) return "Inspection Checklist";

  if (n.includes("CLEAN") || n.includes("PERFECT DEEP") || n.includes("PERFECT SPARKLE"))
    return "Cleans + Clearouts";

  if (n.includes("EICR")) return "Periodic - Rewires";
  if (n.includes("EPC")) return "EPC";
  if (n.includes("ROT WORKS")) return "Rot Works";
  if (n.includes("RECHARGE")) return "Rechargeable Repairs";
  if (n.includes("AC GOLD MTW")) return "MTW";
  if (n.includes("MTW AS PER VRR")) return "MTW";
  if (n.includes("BMD WORKS")) return "NEC Lines";

  return ""; // ZIP root
}

// Core WO extractor (contractor-first override, then desc)
async function extractWorkOrderFields(blob) {
  try {
    const pageCanvas = await renderPdfPageToCanvas(blob, 1, 2.2);

    const contractorCrop = cropFixedContractorRegion(pageCanvas);
    const contractorText = await ocrCroppedContractor(contractorCrop);

    if (fuzzyContains(contractorText, "ASPECT CONTRACT", 3)) {
      return { contractor: contractorText, desc: "ASBESTOS REMOVAL" };
    }
    if (fuzzyContains(contractorText, "LIFE ENVIRONMENTAL", 3) || fuzzyContains(contractorText, "LIFE ENVIROMENTAL", 4)) {
      return { contractor: contractorText, desc: "ASBESTOS SURVEY" };
    }
    if (fuzzyContains(contractorText, "RODGERS ELECTRICAL", 3)) {
      return { contractor: contractorText, desc: "RODGERS ISOLATOR" };
    }

    const descCrop = cropFixedDescRegion(pageCanvas);
    const descText = await ocrCroppedSingleLine(descCrop);

    return { contractor: contractorText, desc: descText };
  } catch (e) {
    console.warn("Work Order OCR failed", e);
    return { contractor: "", desc: "" };
  }
}

// High-level WO naming bridge (returns {folder, filename, blob})
async function autoNameWorkOrderPdf(address, blob) {
  const { contractor, desc } = await extractWorkOrderFields(blob);

  const mapped = mapWorkOrderDescription(desc, contractor);
  const finalDesc = uppercaseClean(mapped || desc || "WORK ORDER");
  const filename = `${uppercaseClean(address)} - VOID ${finalDesc} WORK ORDER REQUEST.pdf`;

  const folder = pickFolderByFilename(filename);
  return { folder, filename, blob };
}

// ============================================
// ZIP BUILDER
// ============================================

async function buildZipAndDownload(address, outputFiles) {
  const zip = new JSZip();

  const seenByFolder = new Map();
  function getSet(folder) {
    if (!seenByFolder.has(folder)) seenByFolder.set(folder, new Set());
    return seenByFolder.get(folder);
  }

  for (const item of outputFiles) {
    const folder = item.folder || "";
    const set = getSet(folder);
    const uniqueName = uniquify(item.filename, set);

    const target = folder ? zip.folder(folder) : zip;
    target.file(uniqueName, item.blob);
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${uppercaseClean(address)} - VOID RENAMED.zip`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ============================================
// MAIN DRIVER: UPLOAD → PROCESS → EXPORT
// ============================================

async function readDroppedInput(e) {
  e.preventDefault();
  const dt = e.dataTransfer;
  return Array.from(dt.files || []);
}

async function explodeZipToPdfs(file) {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files)
    .filter(f => !f.dir && f.name.toLowerCase().endsWith(".pdf"))
    .sort((a, b) => naturalSort(a.name, b.name));

  const PDFs = [];
  for (const entry of entries) {
    const blob = await zip.file(entry.name).async("blob");
    PDFs.push({ name: entry.name, blob });
  }
  return PDFs;
}

async function normalizeInputFiles(droppedFiles) {
  // Case 1: Single ZIP
  if (droppedFiles.length === 1 && droppedFiles[0].name.toLowerCase().endsWith(".zip")) {
    return await explodeZipToPdfs(droppedFiles[0]);
  }

  // Case 2: Multiple PDFs
  if (droppedFiles.every(f => f.name.toLowerCase().endsWith(".pdf"))) {
    return droppedFiles
      .map(f => ({ name: f.name, blob: f }))
      .sort((a, b) => naturalSort(a.name, b.name));
  }

  throw new Error("Please drop either a ZIP (containing PDFs) or one/multiple PDFs.");
}

async function processAll(address, droppedFiles) {
  if (!address || !address.trim()) {
    alert("Please enter the ADDRESS first.");
    return;
  }
  const addressClean = uppercaseClean(address);

  const pdfs = await normalizeInputFiles(droppedFiles);
  if (!pdfs.length) {
    alert("No PDF files found.");
    return;
  }

  // First PDF is the multi-page pack:
  const firstPack = pdfs[0];
  const workOrders = pdfs.slice(1);

  // 1) Classify and split the multi-page pack
  const groups = await processMultiPagePdf(firstPack.blob);

  // 2) Export those groups to PDFs with proper names and folders
  const packOutputs = await buildOutputFromGroups(addressClean, groups);

  // 3) Process all Work Orders after the first
  const woOutputs = [];
  for (const wo of workOrders) {
    const result = await autoNameWorkOrderPdf(addressClean, wo.blob);
    woOutputs.push(result);
  }

  // 4) Combine and zip
  const allOutputs = [...packOutputs, ...woOutputs];
  await buildZipAndDownload(addressClean, allOutputs);
}

// ============================================
// UI WIRING (example)
// ============================================
const dropzone = document.getElementById("dropzone");
const addressInput = document.getElementById("address");

dropzone.addEventListener("dragover", e => {
  e.preventDefault();
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragging");
});
dropzone.addEventListener("drop", async e => {
  dropzone.classList.remove("dragging");
  e.preventDefault();

  const files = Array.from(e.dataTransfer.files);
  try {
    await processAll(addressInput.value, files);
  } catch (err) {
    console.error(err);
    alert(err.message || "Processing failed.");
  }
});
