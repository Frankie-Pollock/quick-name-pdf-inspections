// ===============================================================
// PERFORMANCE LAYER — PDF & TEXT CACHING
// ===============================================================

// ===============================================================
// CORE HELPERS — REQUIRED BY ALL OPTIMISED CODE BELOW
// ===============================================================

// Basic sanitisation helpers
const toUpper = s => (s || "").toUpperCase();

function cleanPunc(s) {
  return toUpper(s)
    .replace(/[^A-Z0-9'\s]/g, " ") // allow apostrophes
    .replace(/\s+/g, " ")
    .trim();
}

// Preserve commas (for address) but make filename-safe
function toFilenameAddressKeepCommas(s) {
  s = (s || "").toUpperCase().trim();
  s = s.replace(/[\\\/:*?"<>|]+/g, " ");
  s = s.replace(/[^A-Z0-9,'\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\s+,/g, ",").replace(/,(\S)/g, ", $1");
  return s.replace(/[,\s]+$/g, "").trim();
}

// Ensures filenames don’t collide
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

// Natural sorting
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// Levenshtein distance
function levenshtein(a, b) {
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

function tokenize(str) {
  return cleanPunc(str).split(/\s+/).filter(Boolean);
}

// Fuzzy phrase search
function fuzzyIncludesPhrase(haystack, phrase, maxDist) {
  const hayTokens = tokenize(haystack);
  const phraseTokens = tokenize(phrase);
  if (!hayTokens.length || !phraseTokens.length) return false;

  const windowSize = phraseTokens.length;
  const target = phraseTokens.join(" ");
  for (let i = 0; i <= hayTokens.length - windowSize; i++) {
    const window = hayTokens.slice(i, i + windowSize).join(" ");
    if (levenshtein(window, target) <= maxDist) return true;
  }
  return false;
}

// Blank-text checker for page detection
function looksBlankText(cleaned) {
  return !cleaned || cleaned.trim().length < 5;
}

// Simple substring matcher
function includesAny(cleaned, arr) {
  const U = toUpper(cleaned);
  return arr.some(s => U.includes(toUpper(s)));
}

// Store cached objects so pdf.js and pdf-lib do NOT reload constantly
const pdfJsCache = new WeakMap();
const pdfLibCache = new WeakMap();
const textCache = new WeakMap();
const canvasCache = new WeakMap();

// -----------------------------------------------
// Load pdf.js doc *once per file*
// -----------------------------------------------
async function getPdfJsCached(file) {
  if (pdfJsCache.has(file)) return pdfJsCache.get(file);
  const buf = await file.arrayBuffer();
  const doc = await window.pdfjsLib.getDocument({ data: buf }).promise;
  pdfJsCache.set(file, doc);
  return doc;
}

// -----------------------------------------------
// Load PDFLib doc *once per file*
// -----------------------------------------------
async function getPdfLibCached(file) {
  if (pdfLibCache.has(file)) return pdfLibCache.get(file);
  const buf = await file.arrayBuffer();
  const doc = await PDFLib.PDFDocument.load(buf);
  pdfLibCache.set(file, doc);
  return doc;
}

// -----------------------------------------------
// Extract ALL page text once → huge speed gain
// -----------------------------------------------
async function extractAllTextCached(pdfJsDoc, file) {
  if (textCache.has(file)) return textCache.get(file);

  const pages = pdfJsDoc.numPages;
  const out = {};

  for (let p = 1; p <= pages; p++) {
    const page = await pdfJsDoc.getPage(p);
    const tc = await page.getTextContent();
    out[p] = tc.items.map(i => i.str || "").join(" ");
  }

  textCache.set(file, out);
  return out;
}

// ===============================================================
// RENDER OPTIMISED: Cached, Low-Scale, Shared Canvas
// ===============================================================

async function renderPdfPageToCanvasCached(file, pageNum = 1, scale = 1.35) {
  // If already rendered this page, return the cached canvas
  const key = `${pageNum}@${scale}`;
  if (!canvasCache.has(file)) canvasCache.set(file, {});
  const bucket = canvasCache.get(file);

  if (bucket[key]) return bucket[key];

  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(pageNum);

  const viewport = page.getViewport({ scale });

  // Prefer OffscreenCanvas if supported
  let canvas;
  let ctx;

  if (typeof OffscreenCanvas !== "undefined") {
    canvas = new OffscreenCanvas(viewport.width, viewport.height);
    ctx = canvas.getContext("2d");
  } else {
    canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    ctx = canvas.getContext("2d");
  }

  await page.render({ canvasContext: ctx, viewport }).promise;

  bucket[key] = canvas;
  return canvas;
}

// ===============================================================
// OCR UTILS (unchanged except using cached canvas)
// ===============================================================

// Greyscale + auto-level improvements remain identical
function enhanceForOcr(srcCanvas) {
  let canvas, ctx;

  // OffscreenCanvas path
  if (typeof OffscreenCanvas !== "undefined" && srcCanvas instanceof OffscreenCanvas) {
    canvas = new OffscreenCanvas(srcCanvas.width, srcCanvas.height);
    ctx = canvas.getContext("2d");
  } else {
    canvas = document.createElement("canvas");
    canvas.width = srcCanvas.width;
    canvas.height = srcCanvas.height;
    ctx = canvas.getContext("2d");
  }

  ctx.drawImage(srcCanvas, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  const hist = new Array(256).fill(0);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const y = (0.299 * r + 0.587 * g + 0.114 * b) | 0;
    hist[y]++;
    data[i] = data[i + 1] = data[i + 2] = y;
  }

  const total = canvas.width * canvas.height;
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

  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

// OCR single line remains the same EXCEPT it now uses enhanced canvas
async function ocrCroppedSingleLineFast(canvas) {
  const enhanced = enhanceForOcr(canvas);

  const r1 = await Tesseract.recognize(enhanced, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 7
  });

  let lines = (r1?.data?.text || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  if (lines.length) return cleanPunc(lines[0]);

  const r2 = await Tesseract.recognize(enhanced, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 6
  });

  lines = (r2?.data?.text || "")
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(Boolean);

  return lines.length ? cleanPunc(lines[0]) : "";
}

// Contractor OCR using same fast path
async function ocrContractorFast(canvas) {
  const enhanced = enhanceForOcr(canvas);
  const res = await Tesseract.recognize(enhanced, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 6
  });
  return cleanPunc(res?.data?.text || "");
}

// ===============================================================
// CROPPING, OCR & DETECTION (Optimised, Cached)
// ===============================================================

// ---- Crop settings (percentages of page) ----
const CROP_TOP_PCT = 0.30;
const CROP_BOTTOM_PCT = 0.43;
const CROP_LEFT_PCT = 0.05;
const CROP_RIGHT_PCT = 0.95;

// CONTRACTOR/SUPPLIER row (just above description cell)
const CONTRACTOR_TOP_PCT = 0.18;
const CONTRACTOR_BOTTOM_PCT = 0.255;
const CONTRACTOR_LEFT_PCT = CROP_LEFT_PCT;
const CONTRACTOR_RIGHT_PCT = CROP_RIGHT_PCT;

// ---------- Canvas helpers (works with OffscreenCanvas or HTMLCanvas) ----------
function createCanvas(w, h) {
  if (typeof OffscreenCanvas !== "undefined") {
    return new OffscreenCanvas(w, h);
  }
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}
function get2D(ctxCanvas) {
  return ctxCanvas.getContext("2d");
}

// ---------- Cropping using a pre-rendered (cached) page canvas ----------
function cropRegion(pageCanvas, leftPct, rightPct, topPct, bottomPct) {
  const W = pageCanvas.width;
  const H = pageCanvas.height;

  const x0 = Math.round(W * leftPct);
  const x1 = Math.round(W * rightPct);
  const y0 = Math.round(H * topPct);
  const y1 = Math.round(H * bottomPct);

  const w = Math.max(10, x1 - x0);
  const h = Math.max(10, y1 - y0);

  const out = createCanvas(w, h);
  const oc = get2D(out);
  // drawImage works with both canvas types
  oc.drawImage(pageCanvas, x0, y0, w, h, 0, 0, w, h);
  return out;
}

function cropFixedDescRegion(pageCanvas) {
  return cropRegion(pageCanvas, CROP_LEFT_PCT, CROP_RIGHT_PCT, CROP_TOP_PCT, CROP_BOTTOM_PCT);
}
function cropFixedContractorRegion(pageCanvas) {
  return cropRegion(pageCanvas, CONTRACTOR_LEFT_PCT, CONTRACTOR_RIGHT_PCT, CONTRACTOR_TOP_PCT, CONTRACTOR_BOTTOM_PCT);
}

// ===============================================================
// TEXT/HEADER DETECTION (uses cached text; OCR fallback only if needed)
// ===============================================================

// Reuse your existing helpers from your script:
//   toUpper, cleanPunc, toFilenameAddressKeepCommas,
//   looksBlankText, includesAny, naturalSort, uniquify,
//   tokenize, levenshtein, fuzzyIncludesPhrase
// (Do NOT redefine them here to avoid duplication.)

// Inspection Pack header detector (cleaned, uppercase)
function isInspectionPackHeader(cleanedText) {
  const t = toUpper(cleanedText || "");
  return (
    t.includes("INSPECTION CHECKLIST") ||
    t.includes("INTERNAL VOID PACK") ||
    t.includes("MTW WORK ORDER") ||
    t.includes("MULTI TRADE WORKS") ||   // cleaned (no hyphen)
    t.includes("MULTI-TRADE WORKS")     // as printed (safe)
  );
}

// ADDRESS extraction (postcode removed, commas preserved)
function extractAddressFromHeader(text) {
  if (!text) return "";

  const header = String(text).replace(/\s+/g, " ").trim();
  const upper = header.toUpperCase();
  const postcodeRegex = /[A-Z]{1,2}[0-9][A-Z0-9]?\s*[0-9][A-Z]{2}/i;

  let working = "";

  // Internal Void Pack "... PACK FOR <ADDRESS>"
  const idxFor = upper.indexOf("PACK FOR");
  if (idxFor !== -1) {
    working = header.slice(idxFor + "PACK FOR".length).trim();
  }

  // AC GOLD (old) "... WORKS: <ADDRESS>"
  if (!working) {
    const idxWorks = upper.indexOf("WORKS:");
    if (idxWorks !== -1) {
      working = header.slice(idxWorks + "WORKS:".length).trim();
    }
  }

  // AC GOLD (new) "... ORDER for <ADDRESS> (<job no>)"
  if (!working) {
    const marker = "ORDER FOR ";
    const idxOrderFor = upper.indexOf(marker);

    if (idxOrderFor !== -1) {
      const start = idxOrderFor + marker.length;

      // Stop before first "(" — job number starts here
      const idxParen = header.indexOf("(", start);
      if (idxParen !== -1) {
        working = header.slice(start, idxParen).trim();
      } else {
        working = header.slice(start).trim();
      }
    }
  }

  if (!working) return "";

  // Trim at postcode if present
  const m = working.match(postcodeRegex);
  if (m) {
    const pcStart = working.indexOf(m[0]);
    working = working.slice(0, pcStart).trim();
  }

  // Remove trailing separators but keep internal commas
  working = working.replace(/[,\-\:\s]+$/g, "").trim();

  return working;
}

// Single pass classifier (no extra pdf.js calls during loop)
function classifyPageType(upperText) {
  if (upperText.includes("SPARKLE")) return "PERFECT SPARKLE";
  if (upperText.includes("DEEP"))    return "PERFECT DEEP";

  if (upperText.includes("EICR") || upperText.includes("PERIODIC")) return "EICR";

  if (upperText.includes("ASBESTOS SURVEY")) return "ASBESTOS SURVEY";
  if (upperText.includes("ASBESTOS"))        return "ASBESTOS REMOVAL";

  if (upperText.includes("RODGERS")) return "RODGERS ISOLATOR";
  if (upperText.includes("ALTRO FLOORING")) return "ALTRO FLOORING";
  
  if (upperText.includes("RECHARGE")) return "RECHARGEABLE REPAIRS";
  if (upperText.includes("MTW"))     return "AC GOLD MTW";
  if (upperText.includes("BMD"))      return "BMD WORKS";

  return null;
}

// Detect work-order types in a PDF using pre-extracted text
async function detectMixedWorkOrdersCached(pdfJsDoc, textByPage) {
  const total = pdfJsDoc.numPages;
  const groups = {};

  for (let p = 1; p <= total; p++) {
    const raw = cleanPunc(textByPage[p] || "");
    const upper = raw.toUpperCase();
    const type = classifyPageType(upper);
    if (!type) continue;
    if (!groups[type]) groups[type] = [];
    groups[type].push(p);
  }
  return groups;
}

// ===============================================================
// OCR HELPERS (fast path already in Message 1)
// - ocrCroppedSingleLineFast
// - ocrContractorFast
// - enhanceForOcr
// - renderPdfPageToCanvasCached
// ===============================================================

// Read header text for page 1 with OCR fallback using cached canvas
async function getHeaderTextsCached(file) {
  const pdfJsDoc = await getPdfJsCached(file);
  const textByPage = await extractAllTextCached(pdfJsDoc, file);

  let p1Raw = textByPage[1] || "";
  let p1Clean = cleanPunc(p1Raw);

  // OCR fallback for scanned packs
  if (looksBlankText(p1Clean)) {
    try {
      const pageCanvas = await renderPdfPageToCanvasCached(file, 1, 1.35);
      const enhanced = enhanceForOcr(pageCanvas);
      const ocrRes = await Tesseract.recognize(enhanced, "eng", {
        tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
        tessedit_pageseg_mode: 6
      });
      const ocrText = (ocrRes?.data?.text || "").replace(/\s+/g, " ").trim();
      if (ocrText && ocrText.length > 5) {
        p1Raw = ocrText;           // keep punctuation for address
        p1Clean = cleanPunc(ocrText);
      }
    } catch (e) {
      console.warn("OCR fallback for pack header failed:", e);
    }
  }

  return { pdfJsDoc, textByPage, p1Raw, p1Clean };
}

// Derive ADDRESS from header text (formatted for filename)
function getPackAddressFromHeaderText(p1Raw) {
  const extracted = extractAddressFromHeader(p1Raw);
  return toFilenameAddressKeepCommas(extracted);
}

// ===============================================================
// Mapping rules and folder routing (unchanged behaviour)
// ===============================================================

function mapWorkOrderDescription(desc, contractorText) {
  const hay = `${desc || ""} ${contractorText || ""}`.trim();

  // Contractor-led (highest priority)
  if (fuzzyIncludesPhrase(hay, "ASPECT CONTRACT", 3)) return "ASBESTOS REMOVAL";
  if (fuzzyIncludesPhrase(hay, "LIFE ENVIRONMENTAL", 3) || fuzzyIncludesPhrase(hay, "LIFE ENVIROMENTAL", 4)) return "ASBESTOS SURVEY";
  if (fuzzyIncludesPhrase(hay, "RODGERS ELECTRICAL", 3)) return "RODGERS ISOLATOR";
  if (fuzzyIncludesPhrase(hay, "ALTRO FLOORING", 3)) return "ALTRO FLOORING";

  if (fuzzyIncludesPhrase(hay, "MTW AS PER VRR", 3)) return "AC GOLD MTW";
  if (fuzzyIncludesPhrase(hay, "RECHARGABLE MTW", 3)) return "ACG RECHARGABLE MTW";
  // Description-led
  if (fuzzyIncludesPhrase(hay, "DEEP", 1))     return "PERFECT DEEP";
  if (fuzzyIncludesPhrase(hay, "SPARKLE", 2))  return "PERFECT SPARKLE";

  return null; // no mapping → use original
}

function pickFolderByFilename(finalName) {
  const n = (finalName || "").toUpperCase();

  if (n.includes("ASBESTOS")) return "Asbestos";
  if (n.includes("INSPECTION CHECKLIST")) return "Inspection Checklist";

  if (n.includes("CLEAN") || n.includes("PERFECT DEEP") || n.includes("PERFECT SPARKLE"))
    return "Cleans + Clearouts";

  if (n.includes("EICR")) return "Periodic - Rewires";
  if (n.includes("EPC")) return "EPC";
  if (n.includes("ROT WORKS")) return "Rot Works";
  if (n.includes("RECHARGE")) return "Rechargeable Repairs";
  if (n.includes("AC GOLD MTW")) return "MTW";
  if (n.includes("MTW AS PER VRR")) return "MTW";
  if (n.includes("ACG RECHARGABLE MTW")) return "MTW";
  if (n.includes("BMD WORKS")) return "NEC Lines";
  if (n.includes("RODGERS ISOLATOR")) return "Power";
  if (n.includes("ALTRO FLOORING")) return "Purchase Orders MISC";
  if (n.includes("BATHROOM INSTALLATION")) return "Kitchens - Bathrooms";


  return ""; // default → ZIP root
}
// ===============================================================
// UI: Minimal progress overlay (unchanged behaviour, tiny tweaks)
// ===============================================================
function ensureProgressUI() {
  if (document.getElementById("autoProgressWrap")) return;

  const wrap = document.createElement("div");
  wrap.id = "autoProgressWrap";
  wrap.style.cssText = `
    position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,.45); z-index: 999999; font-family: system-ui,Segoe UI,Arial,sans-serif;
  `;
  wrap.innerHTML = `
    <div style="width: min(560px,90vw); background:#fff; border-radius:10px; padding:20px 22px; box-shadow: 0 10px 30px rgba(0,0,0,.3)">
      <div style="font-weight:600; margin-bottom:10px; font-size:18px">Processing…</div>
      <div id="autoStatus" style="font-size:13px;color:#333;margin-bottom:12px">Starting…</div>
      <div style="height:10px;background:#eee;border-radius:6px;overflow:hidden">
        <div id="autoBar" style="height:100%;width:0%;background:#0078d4;transition:width .2s ease"></div>
      </div>
      <div id="autoPct" style="margin-top:8px;font-size:12px;color:#666">0%</div>
    </div>
  `;
  document.body.appendChild(wrap);
}
function setProgress(current, total, msg) {
  ensureProgressUI();
  const pct = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
  const bar = document.getElementById("autoBar");
  const pctLbl = document.getElementById("autoPct");
  const st = document.getElementById("autoStatus");
  if (bar) bar.style.width = pct + "%";
  if (pctLbl) pctLbl.textContent = `${pct}%`;
  if (st && msg) st.textContent = msg;
}
function finishProgress() {
  setProgress(1, 1, "Done");
  setTimeout(() => {
    const wrap = document.getElementById("autoProgressWrap");
    if (wrap) wrap.remove();
  }, 600);
}

// ===============================================================
// DOM references and queue state
// ===============================================================
const dropzone   = document.querySelector("#dropzone");
const processBtn = document.getElementById("processBtn");
const clearBtn   = document.getElementById("clearBtn");
const queueList  = document.getElementById("queueList");

// Keep a stable queue: Array<File>
let queuedFiles = [];

// Render queue
function renderQueue() {
  if (!queueList) return;
  if (!queuedFiles.length) {
    queueList.innerHTML = `<div style="color:#666">Queue is empty.</div>`;
    return;
  }
  const items = queuedFiles.map((f, idx) => {
    const sizeKB = Math.max(1, Math.round((f.size || 0) / 1024));
    return `
      <div class="queue-item">
        <div class="queue-name" title="${f.name}">
          ${idx + 1}. ${f.name} <span style="color:#999">(${sizeKB} KB)</span>
        </div>
        <button class="rm-btn" data-remove="${idx}">Remove</button>
      </div>`;
  }).join("");
  queueList.innerHTML = items;

  // Hook remove
  queueList.querySelectorAll("button[data-remove]").forEach(btn => {
    btn.addEventListener("click", () => {
      const idx = parseInt(btn.getAttribute("data-remove"), 10);
      if (!Number.isNaN(idx)) {
        queuedFiles.splice(idx, 1);
        renderQueue();
      }
    });
  });
}

// Add files (dedupe by name+size+type)
function addToQueue(fileListOrArray) {
  const incoming = Array.from(fileListOrArray || []);
  const sig = f => `${f.name}::${f.size}::${f.type}`;
  const existing = new Set(queuedFiles.map(sig));
  for (const f of incoming) {
    const lower = (f.name || "").toLowerCase();
    if (!(lower.endsWith(".pdf") || lower.endsWith(".zip"))) continue;
    const s = sig(f);
    if (!existing.has(s)) {
      queuedFiles.push(f);
      existing.add(s);
    }
  }
  renderQueue();
}
// Initial render
renderQueue();

// ===============================================================
// Drag & Drop → queue only
// ===============================================================
["dragover", "drop"].forEach(evt => {
  document.addEventListener(evt, e => e.preventDefault());
});
dropzone.addEventListener("dragover", e => {
  e.preventDefault();
  dropzone.classList.add("dragging");
});
dropzone.addEventListener("dragleave", () => {
  dropzone.classList.remove("dragging");
});
dropzone.addEventListener("drop", e => {
  e.preventDefault();
  dropzone.classList.remove("dragging");
  const dropped = Array.from(e.dataTransfer.files || []);
  if (!dropped.length) return;
  addToQueue(dropped);
});

// Clear queue
clearBtn.addEventListener("click", () => {
  queuedFiles = [];
  renderQueue();
});

// Run
processBtn.addEventListener("click", async () => {
  if (!queuedFiles.length) {
    alert("Queue is empty. Drop PDF(s) or ZIP(s) first.");
    return;
  }
  try {
    await processQueuedFilesFast();
  } catch (err) {
    console.error(err);
    alert("An error occurred during processing.");
    finishProgress();
  }
});

// ===============================================================
// ZIP helpers
// ===============================================================
function getZipTarget(zip, folder) {
  return folder ? zip.folder(folder) : zip;
}

// Save a single page into ZIP using an existing PDFLib doc
async function saveSinglePageFromDoc(pdfLibDoc, pageIndex1, filename, zip, seenByFolder, onStep) {
  const dest = await PDFLib.PDFDocument.create();
  const [copied] = await dest.copyPages(pdfLibDoc, [pageIndex1 - 1]);
  dest.addPage(copied);
  const bytes = await dest.save();

  const folder = pickFolderByFilename(filename);
  if (!seenByFolder.has(folder)) seenByFolder.set(folder, new Set());
  const set = seenByFolder.get(folder);
  const finalName = uniquify(filename, set);

  const target = getZipTarget(zip, folder);
  target.file(finalName, bytes);

  if (onStep) onStep(`Saved → ${finalName}`);
}

// Save multiple specific pages into ZIP as one file
async function savePageSetFromDoc(pdfLibDoc, zeroBasedIndices, filename, zip, seenByFolder, onStep) {
  const dest = await PDFLib.PDFDocument.create();
  const copied = await dest.copyPages(pdfLibDoc, zeroBasedIndices);
  copied.forEach(pg => dest.addPage(pg));
  const outBytes = await dest.save();

  const folder = pickFolderByFilename(filename);
  if (!seenByFolder.has(folder)) seenByFolder.set(folder, new Set());
  const set = seenByFolder.get(folder);
  const finalName = uniquify(filename, set);

  const target = getZipTarget(zip, folder);
  target.file(finalName, outBytes);

  if (onStep) onStep(`Split → ${finalName}`);
}

// ===============================================================
// Work Order → add to ZIP (Optimised, cached)
// ===============================================================
async function addWorkOrderToZipFast(plan, zip, address, seenByFolder, onStep) {
  const { file, pdfJsDoc, pdfLibDoc, textByPage } = plan;

  // 1) Try mixed work-order split using pre-extracted text
  let usedSplit = false;
  try {
    const groups = await detectMixedWorkOrdersCached(pdfJsDoc, textByPage);
    const types = Object.keys(groups);

    if (types.length > 1) {
      for (const type of types) {
        const pages = groups[type];
        const zeroIdx = pages.map(p => p - 1);
        const filename = `${address} - VOID ${type} WORK ORDER REQUEST.pdf`;
        await savePageSetFromDoc(pdfLibDoc, zeroIdx, filename, zip, seenByFolder, onStep);
      }
      usedSplit = true;
    }
  } catch (err) {
    console.warn("Mixed work order detection failed:", err);
  }
  if (usedSplit) return;

  // 2) Standard single work order → OCR description + contractor (fast)
  const pageCanvas = await renderPdfPageToCanvasCached(file, 1, 1.35);
  const contractorCrop = cropFixedContractorRegion(pageCanvas);
  const descCrop = cropFixedDescRegion(pageCanvas);

  const contractorText = await ocrContractorFast(contractorCrop);
  const rawDesc = await ocrCroppedSingleLineFast(descCrop);

  const mapped = mapWorkOrderDescription(rawDesc, contractorText);
  const finalDesc = cleanPunc(mapped || rawDesc || "WORK ORDER");

  const newName = `${address} - VOID ${finalDesc} WORK ORDER REQUEST.pdf`;
  const folder = pickFolderByFilename(newName);

  if (!seenByFolder.has(folder)) seenByFolder.set(folder, new Set());
  const set = seenByFolder.get(folder);
  const finalName = uniquify(newName, set);

  const target = getZipTarget(zip, folder);
  const buf = await file.arrayBuffer();
  target.file(finalName, buf);

  if (onStep) onStep(`Work Order → ${finalName}`);
}
async function tryReadPage1RawTextOnly(file) {
  try {
    const pdfJsDoc = await getPdfJsCached(file);
    const page = await pdfJsDoc.getPage(1);
    // Slightly faster options (skip normalization overhead)
    const tc = await page.getTextContent({ normalizeWhitespace: false, disableNormalization: true });
    const raw = (tc.items || []).map(i => i.str || "").join(" ");
    return raw; // return RAW, do NOT clean here
  } catch {
    return "";
  }
}

async function fastFindAddress(pdfFiles) {
  for (const f of pdfFiles) {
    const raw = await tryReadPage1RawTextOnly(f);
    const clean = cleanPunc(raw);

    if (isInspectionPackHeader(clean)) {
      // IMPORTANT: pass RAW (with commas etc.) to address function
      return getPackAddressFromHeaderText(raw);
    }
  }
  return "";
}
// ===============================================================
// Inspection Pack Splitter → append parts into ZIP (Optimised)
// ===============================================================
async function appendInspectionPackToZipFast(plan, zip, address, seenByFolder, onStep) {
  const { pdfJsDoc, pdfLibDoc, textByPage } = plan;
  const total = pdfJsDoc.numPages;

  // Helper to save a single page with filename
  async function saveSingle(pageIndex1, filename) {
    await saveSinglePageFromDoc(pdfLibDoc, pageIndex1, filename, zip, seenByFolder, onStep);
  }

  // Page-1 cleaned for detection
  const p1Clean = cleanPunc(textByPage[1] || "");

  const isAcGold =
    p1Clean.toUpperCase().includes("MULTI TRADE WORKS") ||
    p1Clean.toUpperCase().includes("MTW WORK ORDER FOR") ||
    p1Clean.toUpperCase().includes("MULTI-TRADE WORKS");

  // Save Page 1 as Inspection Checklist
  await saveSingle(1, `${address} - VOID INSPECTION CHECKLIST.pdf`);

  if (isAcGold) {
    // AC GOLD MTW FLOW
    let lastText = "";
    if (total >= 2) {
      lastText = cleanPunc(textByPage[total] || "");
    }
    const lastIsBmd = lastText.toUpperCase().includes("BMD WORKS REQUIRED");
    const mtwEnd = lastIsBmd ? total - 1 : total;

    let mtwIdx = 0;
    for (let p = 2; p <= mtwEnd; p++) {
      const txt = cleanPunc(textByPage[p] || "");
      if (looksBlankText(txt)) continue;
      mtwIdx++;
      await saveSingle(p, `${address} - VOID AC GOLD MTW (${mtwIdx}).pdf`);
    }

    if (lastIsBmd) {
      await saveSingle(total, `${address} - VOID BMD WORKS.pdf`);
    }
  } else {
    // INTERNAL VOID PACK FLOW
    let startBmdFrom = 2;
    let bmdIdx = 0;

    if (total >= 2) {
      const p2Text = cleanPunc(textByPage[2] || "");
      const p2Blank = looksBlankText(p2Text);
      const p2Recharge = p2Text.toUpperCase().includes("RECHARGE WORK") || p2Text.toUpperCase().includes("RECHARGEABLE WORK");

      if (!p2Blank && p2Recharge) {
        await saveSingle(2, `${address} - VOID_RECHARGEABLE_Works.pdf`);
        startBmdFrom = 3;
      } else if (p2Blank) {
        startBmdFrom = 3;
      } else {
        startBmdFrom = 2;
      }
    }

    for (let p = startBmdFrom; p <= total; p++) {
      const txt = cleanPunc(textByPage[p] || "");
      if (looksBlankText(txt)) continue;
      bmdIdx++;
      await saveSingle(p, `${address} - VOID BMD WORKS (${bmdIdx}).pdf`);
    }
  }
}

// ===============================================================
// MAIN PIPELINE (Fast, cached, no workers)
// ===============================================================
// ===============================================================
// MAIN PIPELINE (Fast, cached, no workers)
// ===============================================================
async function processQueuedFilesFast() {
  // Clone queue at start to avoid mutation during process
  let droppedFiles = Array.from(queuedFiles);

  // 1) Flatten any ZIPs into PDFs (sorted, natural)
  if (droppedFiles.length) {
    const flattened = [];
    for (const f of droppedFiles) {
      const lower = (f.name || "").toLowerCase();
      if (lower.endsWith(".zip")) {
        try {
          setProgress(0, 1, `Reading ZIP: ${f.name}…`);
          const zipIn = await JSZip.loadAsync(f);
          const pdfEntries = Object.values(zipIn.files)
            .filter(ff => !ff.dir && ff.name.toLowerCase().endsWith(".pdf"))
            .sort((a, b) => naturalSort(a.name, b.name));

          for (const entry of pdfEntries) {
            const blob = await zipIn.file(entry.name).async("blob");
            flattened.push(new File([blob], entry.name, { type: "application/pdf" }));
          }
        } catch (err) {
          console.error(err);
          alert(`ZIP could not be read: ${f.name}`);
          finishProgress();
          return;
        }
      } else {
        flattened.push(f);
      }
    }
    droppedFiles = flattened;
  }

  // 2) Filter to PDFs
  const pdfFiles = droppedFiles.filter(f => f.name.toLowerCase().endsWith(".pdf"));
  if (!pdfFiles.length) {
    alert("No PDF files found.");
    return;
  }

  // 3) FAST SCAN: Only read page 1 (no OCR, no full text) to find address
  ensureProgressUI();
  setProgress(0, 100, "Scanning for address…");

  const address = await fastFindAddress(pdfFiles);

  if (!address) {
    alert("Could not extract address — please include an inspection pack.");
    finishProgress();
    return;
  }

  // 3b) Now that we know the address, do full processing
  setProgress(10, 100, "Analysing files…");

  const filePlans = [];
  let estimatedSteps = 0;

  for (const f of pdfFiles) {
    const pdfJsDoc = await getPdfJsCached(f);
    const pdfLibDoc = await getPdfLibCached(f);
    const textByPage = await extractAllTextCached(pdfJsDoc, f);

    const p1Raw = textByPage[1] || "";
    const p1Clean = cleanPunc(p1Raw);
    const isPack = isInspectionPackHeader(p1Clean);
    const pages = pdfJsDoc.numPages;

    filePlans.push({ file: f, isPack, pages, pdfJsDoc, pdfLibDoc, textByPage });
    estimatedSteps += isPack ? pages : 1;
  }

  // 4) Process all files into one ZIP
  const outZip = new JSZip();
  const seenByFolder = new Map();
  let done = 0;

  function onStep(msg) {
    done++;
    setProgress(done, estimatedSteps, msg || `Processed ${done}/${estimatedSteps}`);
  }

  for (const plan of filePlans) {
    if (plan.isPack) {
      await appendInspectionPackToZipFast(plan, outZip, address, seenByFolder, onStep);
    } else {
      await addWorkOrderToZipFast(plan, outZip, address, seenByFolder, onStep);
    }
  }

  // 5) Finalize ZIP + Download (balanced compression vs. speed)
  setProgress(estimatedSteps, estimatedSteps, "Packaging ZIP…");
  const outBlob = await outZip.generateAsync({
    type: "blob",
    compression: "DEFLATE",
    compressionOptions: { level: 6 } // good trade-off
  });

  const a = document.createElement("a");
  a.href = URL.createObjectURL(outBlob);
  a.download = `${address}.zip`;
  a.click();

  finishProgress();
}
