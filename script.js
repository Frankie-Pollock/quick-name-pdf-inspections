// =======================================
// FINAL – Hands-free processing for Inspection Packs + Work Orders
// =======================================

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

// =======================================
// Utility helpers
// =======================================
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function toUpper(s){ return (s || "").toUpperCase(); }
function cleanPunc(s){
  return toUpper(s).replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();
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

// Natural sort (A2 before A10)
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// Simple Levenshtein distance
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
function tokenize(str){ return cleanPunc(str).split(/\s+/).filter(Boolean); }

// Fuzzy phrase search: sliding window
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

// =======================================
// Minimal progress UI (auto-injected)
// =======================================
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

// =======================================
// DOM references (minimal)
// =======================================
const dropzone = $("#dropzone");

// =======================================
// PDF rendering helpers
// =======================================
async function renderPdfPageToCanvas(blob, pageNum = 1, scale = 2.2) {
  const buf = await blob.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const page = await pdf.getPage(pageNum);

  const viewport = page.getViewport({ scale });
  const c = document.createElement("canvas");
  const cx = c.getContext("2d");
  c.width = viewport.width;
  c.height = viewport.height;
  await page.render({ canvasContext: cx, viewport }).promise;
  return c;
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

// =======================================
// Image enhancement for OCR (greyscale + auto-level)
// =======================================
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

// =======================================
// OCR helpers (headless)
// =======================================
async function ocrCroppedSingleLine(cropCanvas) {
  const enhanced = enhanceForOcr(cropCanvas);

  const res1 = await Tesseract.recognize(enhanced, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 7
  });

  let lines = (res1?.data?.text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length) return cleanPunc(lines[0]);

  const res2 = await Tesseract.recognize(enhanced, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 6
  });

  lines = (res2?.data?.text || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.length ? cleanPunc(lines[0]) : "";
}

async function ocrCroppedContractor(cropCanvas) {
  const enhanced = enhanceForOcr(cropCanvas);
  const res = await Tesseract.recognize(enhanced, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 6
  });
  return cleanPunc(res?.data?.text || "");
}

// ================================
// Work Order Mapping Rules
// ================================
function mapWorkOrderDescription(desc, contractorText) {
  const hay = `${desc || ""} ${contractorText || ""}`.trim();

  // Contractor-led (highest priority)
  if (fuzzyIncludesPhrase(hay, "ASPECT CONTRACT", 3)) return "ASBESTOS REMOVAL";
  if (fuzzyIncludesPhrase(hay, "LIFE ENVIRONMENTAL", 3) || fuzzyIncludesPhrase(hay, "LIFE ENVIROMENTAL", 4)) return "ASBESTOS SURVEY";
  if (fuzzyIncludesPhrase(hay, "RODGERS ELECTRICAL", 3)) return "RODGERS ISOLATOR";

  // Description-led
  if (fuzzyIncludesPhrase(hay, "DEEP", 1))     return "PERFECT DEEP";
  if (fuzzyIncludesPhrase(hay, "SPARKLE", 2))  return "PERFECT SPARKLE";

  return null; // no mapping → use original
}

// ================================
// Folder Routing  (includes PERFECT DEEP/SPARKLE)
// ================================
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
  if (n.includes("BMD WORKS")) return "NEC Lines";

  return ""; // default → ZIP root
}

// =======================================
// TEXT EXTRACTION helpers (pdf.js)
// =======================================
async function getPdfJsDoc(blobOrBytes) {
  const data = blobOrBytes instanceof Blob ? await blobOrBytes.arrayBuffer() : blobOrBytes;
  return window.pdfjsLib.getDocument({ data }).promise;
}
async function extractPageText(pdfJsDoc, pageNum) {
  const page = await pdfJsDoc.getPage(pageNum);
  const textContent = await page.getTextContent();
  const text = textContent.items.map(i => (i.str || "")).join(" ");
  return cleanPunc(text);
}
function looksBlankText(cleaned) {
  return !cleaned || cleaned.trim().length < 5;
}
function includesAny(cleaned, arr) {
  const U = toUpper(cleaned);
  return arr.some(s => U.includes(toUpper(s)));
}

// =======================================
// Inspection Pack header detector
// =======================================
function isInspectionPackHeader(text) {
  const t = toUpper(text || "");
  return (
    t.includes("INSPECTION CHECKLIST") ||
    t.includes("INTERNAL VOID PACK") ||
    t.includes("MULTI TRADE WORKS") ||   // cleaned (no hyphen)
    t.includes("MULTI-TRADE WORKS")     // as printed
  );
}

// ================================
// Headless Work Order → add to ZIP
// ================================
async function addWorkOrderToZip(zip, pdfBlobOrFile, address, seenByFolder, onStep) {
  // 1) Extract description + contractor from page 1 crops
  const pageCanvas = await renderPdfPageToCanvas(pdfBlobOrFile, 1, 2.2);
  const contractorCrop = cropFixedContractorRegion(pageCanvas);
  const contractorText = await ocrCroppedContractor(contractorCrop);

  const descCrop = cropFixedDescRegion(pageCanvas);
  const rawDesc = await ocrCroppedSingleLine(descCrop);

  const mapped = mapWorkOrderDescription(rawDesc, contractorText);
  const finalDesc = cleanPunc(mapped || rawDesc || "WORK ORDER");

  // 2) Build target filename (same pattern you used previously)
  const newName = `${address} - VOID ${finalDesc} WORK ORDER REQUEST.pdf`;
  const folder = pickFolderByFilename(newName);

  if (!seenByFolder.has(folder)) seenByFolder.set(folder, new Set());
  const set = seenByFolder.get(folder);
  const finalName = uniquify(newName, set);

  const target = folder ? zip.folder(folder) : zip;

  // Store original bytes (unchanged)
  const buf = pdfBlobOrFile instanceof Blob ? await pdfBlobOrFile.arrayBuffer() : pdfBlobOrFile;
  target.file(finalName, buf);

  if (onStep) onStep(`Work Order → ${finalName}`);
}

// =======================================================
// Inspection Pack Splitter → append parts into ZIP
// =======================================================
async function appendInspectionPackToZip(zip, bigPdfBlob, address, seenByFolder, onStep) {
  // Read PDF once; create two independent copies for pdf.js and pdf-lib
  const originalBytes = await bigPdfBlob.arrayBuffer();
  const bytesForPdfJs  = originalBytes.slice(0);
  const bytesForPdfLib = originalBytes.slice(0);

  const pdfJsDoc = await getPdfJsDoc(bytesForPdfJs);
  const srcDoc   = await PDFLib.PDFDocument.load(bytesForPdfLib);

  const total = pdfJsDoc.numPages;

  // Read header text (page 1)
  const p1Text = await extractPageText(pdfJsDoc, 1);

  const isAcGold =
    includesAny(p1Text, ["MULTI TRADE WORKS"]) ||
    includesAny(p1Text, ["MULTI-TRADE WORKS"]);

  async function saveSinglePage(pageIndex1, filename) {
    const dest = await PDFLib.PDFDocument.create();
    const [copied] = await dest.copyPages(srcDoc, [pageIndex1 - 1]);
    dest.addPage(copied);
    const bytes = await dest.save();

    const folder = pickFolderByFilename(filename);
    if (!seenByFolder.has(folder)) seenByFolder.set(folder, new Set());
    const set = seenByFolder.get(folder);
    const finalName = uniquify(filename, set);

    const target = folder ? zip.folder(folder) : zip;
    target.file(finalName, bytes);

    if (onStep) onStep(`Saved → ${finalName}`);
  }

  // Save Page 1 as Inspection Checklist
  await saveSinglePage(1, `${address} - VOID INSPECTION CHECKLIST.pdf`);

  // AC GOLD MTW FLOW
  if (isAcGold) {
    let lastText = "";
    if (total >= 2) {
      lastText = await extractPageText(pdfJsDoc, total);
    }
    const lastIsBmd = includesAny(lastText, ["BMD WORKS REQUIRED"]);
    const mtwEnd = lastIsBmd ? total - 1 : total;

    let mtwIdx = 0;
    for (let p = 2; p <= mtwEnd; p++) {
      const txt = await extractPageText(pdfJsDoc, p);
      if (looksBlankText(txt)) continue;
      mtwIdx++;
      await saveSinglePage(p, `${address} - VOID AC GOLD MTW (${mtwIdx}).pdf`);
    }

    if (lastIsBmd) {
      await saveSinglePage(total, `${address} - VOID BMD WORKS.pdf`);
    }
  }

  // INTERNAL VOID PACK FLOW
  else {
    let startBmdFrom = 2;
    let bmdIdx = 0;

    if (total >= 2) {
      const p2Text = await extractPageText(pdfJsDoc, 2);
      const p2Blank = looksBlankText(p2Text);
      const p2Recharge = includesAny(p2Text, ["RECHARGE WORK","RECHARGEABLE WORK"]);

      if (!p2Blank && p2Recharge) {
        await saveSinglePage(2, `${address} - VOID_RECHARGEABLE_Works.pdf`);
        startBmdFrom = 3;
      } else if (p2Blank) {
        startBmdFrom = 3;
      } else {
        startBmdFrom = 2;
      }
    }

    for (let p = startBmdFrom; p <= total; p++) {
      const txt = await extractPageText(pdfJsDoc, p);
      if (looksBlankText(txt)) continue;
      bmdIdx++;
      await saveSinglePage(p, `${address} - VOID BMD WORKS (${bmdIdx}).pdf`);
    }
  }
}

// =======================================================
// DRAG & DROP → Fully Automatic Pipeline (NO WIZARD)
// =======================================================
dropzone.addEventListener("dragover", e => {
  e.preventDefault();
  dropzone.style.opacity = 0.85;
});
dropzone.addEventListener("dragleave", () => {
  dropzone.style.opacity = 1;
});

dropzone.addEventListener("drop", async e => {
  e.preventDefault();
  dropzone.style.opacity = 1;

  const addressRaw = $("#address") ? $("#address").value : "";
  const address = cleanPunc(addressRaw);
  if (!address) {
    alert("Please enter the ADDRESS first.");
    return;
  }

  let droppedFiles = Array.from(e.dataTransfer.files);
  if (!droppedFiles.length) {
    alert("No files dropped.");
    return;
  }

  // -----------------------------
  // If a ZIP was dropped, flatten it
  // -----------------------------
  if (droppedFiles.length === 1 && droppedFiles[0].name.toLowerCase().endsWith(".zip")) {
    try {
      setProgress(0, 1, "Reading ZIP…");
      const zipIn = await JSZip.loadAsync(droppedFiles[0]);
      const pdfEntries = Object.values(zipIn.files)
        .filter(f => !f.dir && f.name.toLowerCase().endsWith(".pdf"))
        .sort((a, b) => naturalSort(a.name, b.name));

      const extracted = [];
      for (const entry of pdfEntries) {
        const blob = await zipIn.file(entry.name).async("blob");
        extracted.push(new File([blob], entry.name, { type: "application/pdf" }));
      }
      droppedFiles = extracted;
    } catch (err) {
      console.error(err);
      alert("ZIP could not be read.");
      finishProgress();
      return;
    }
  }

  // Filter to PDFs
  const pdfFiles = droppedFiles.filter(f => f.name.toLowerCase().endsWith(".pdf"));
  if (!pdfFiles.length) {
    alert("No PDF files found.");
    return;
  }

  // -----------------------------
  // First pass → identify which are inspection packs
  // -----------------------------
  ensureProgressUI();
  setProgress(0, 100, "Analysing files…");

  const filePlans = [];
  let estimatedSteps = 0;

  for (const f of pdfFiles) {
    const bytes = await f.arrayBuffer();
    const doc = await getPdfJsDoc(bytes);
    const p1 = await extractPageText(doc, 1);
    const isPack = isInspectionPackHeader(p1);
    const pages = doc.numPages;

    filePlans.push({ file: f, isPack, pages });
    estimatedSteps += isPack ? pages : 1;
  }

  // -----------------------------
  // Process all files into one ZIP
  // -----------------------------
  const outZip = new JSZip();
  const seenByFolder = new Map();
  let done = 0;

  function onStep(msg) {
    done++;
    setProgress(done, estimatedSteps, msg || `Processed ${done}/${estimatedSteps}`);
  }

  for (const plan of filePlans) {
    if (plan.isPack) {
      await appendInspectionPackToZip(outZip, plan.file, address, seenByFolder, onStep);
    } else {
      await addWorkOrderToZip(outZip, plan.file, address, seenByFolder, onStep);
    }
  }

  // -----------------------------
  // Finalize ZIP + Download
  // -----------------------------
  setProgress(estimatedSteps, estimatedSteps, "Packaging ZIP…");
  const outBlob = await outZip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(outBlob);
  a.download = `${address} - VOID RENAMED.zip`;
  a.click();

  finishProgress();
});

// =======================================================
// OPTIONAL: Hide any existing wizard UI on load
// =======================================================
window.addEventListener("DOMContentLoaded", () => {
  const wiz = document.getElementById("wizard");
  if (wiz) wiz.style.display = "none";
});
