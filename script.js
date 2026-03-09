// Copyright © 2024–2026 Francis Pollock
// All rights reserved.

// =======================================
// FINAL – Hands-free processing for Inspection Packs + Work Orders
// =======================================

// ---- Crop settings ----
const CROP_TOP_PCT = 0.30;
const CROP_BOTTOM_PCT = 0.43;
const CROP_LEFT_PCT = 0.05;
const CROP_RIGHT_PCT = 0.95;

const CONTRACTOR_TOP_PCT = 0.18;
const CONTRACTOR_BOTTOM_PCT = 0.255;
const CONTRACTOR_LEFT_PCT = CROP_LEFT_PCT;
const CONTRACTOR_RIGHT_PCT = CROP_RIGHT_PCT;

// ---------------------------------------
const $ = sel => document.querySelector(sel);

function toUpper(s){ return (s || "").toUpperCase(); }
function cleanPunc(s){
  return toUpper(s)
    .replace(/[^A-Z0-9'\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toFilenameAddressKeepCommas(s) {
  s = (s || "").toUpperCase().trim();
  s = s.replace(/[\\\/:\*\?"<>|]+/g, " ");
  s = s.replace(/[^A-Z0-9,'\s]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\s+,/g, ",").replace(/,(\S)/g, ", $1");
  return s.replace(/[,\s]+$/g, "").trim();
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

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// ---------------------------------------
async function getPdfJsDoc(blobOrBytes) {
  const data = blobOrBytes instanceof Blob ? await blobOrBytes.arrayBuffer() : blobOrBytes;
  return window.pdfjsLib.getDocument({ data }).promise;
}
async function extractPageTextRaw(pdfJsDoc, pageNum) {
  const page = await pdfJsDoc.getPage(pageNum);
  const text = await page.getTextContent();
  return text.items.map(i => (i.str || "")).join(" ");
}
async function extractPageTextClean(pdfJsDoc, pageNum) {
  return cleanPunc(await extractPageTextRaw(pdfJsDoc, pageNum));
}

// ---------------------------------------
function getRegionCoords(viewport, leftPct, rightPct, topPct, bottomPct) {
  return {
    x0: viewport.width * leftPct,
    x1: viewport.width * rightPct,
    y0: viewport.height * topPct,
    y1: viewport.height * bottomPct
  };
}

function extractTextInRegion(textContent, region) {
  const lines = [];
  for (const item of textContent.items) {
    const [,,, , x, y] = item.transform;
    if (x >= region.x0 && x <= region.x1 &&
        y >= region.y0 && y <= region.y1) {
      if (item.str && item.str.trim()) lines.push(item.str);
    }
  }
  return lines.join(" ").trim();
}

// ---------------------------------------
async function smartExtract(pdfJs, cropCanvas, region) {
  const page = await pdfJs.getPage(1);
  const textContent = await page.getTextContent();
  const txt = extractTextInRegion(textContent, region);

  if (txt && txt.length > 2) {
    return cleanPunc(txt);
  }

  return await ocrCroppedSingleLine(cropCanvas);
}

// =======================================
// Work Order Mapping
// =======================================
function mapWorkOrderDescription(desc, contractorText) {
  const hay = `${desc || ""} ${contractorText || ""}`.trim();

  if (fuzzyIncludesPhrase(hay, "ASPECT CONTRACT", 3)) return "ASBESTOS REMOVAL";
  if (fuzzyIncludesPhrase(hay, "LIFE ENVIRONMENTAL", 3) ||
      fuzzyIncludesPhrase(hay, "LIFE ENVIROMENTAL", 4)) return "ASBESTOS SURVEY";
  if (fuzzyIncludesPhrase(hay, "RODGERS ELECTRICAL", 3)) return "RODGERS ISOLATOR";
  if (fuzzyIncludesPhrase(hay, "MTW AS PER VRR", 3)) return "AC GOLD MTW";
  if (fuzzyIncludesPhrase(hay, "DEEP", 1)) return "PERFECT DEEP";
  if (fuzzyIncludesPhrase(hay, "SPARKLE", 2)) return "PERFECT SPARKLE";

  return null;
}

// =======================================
// Headless Work Order → add to ZIP (HYBRID TEXT/OCR)
// =======================================
async function addWorkOrderToZip(zip, pdfBlobOrFile, address, seenByFolder, onStep) {
  const originalBytes = await pdfBlobOrFile.arrayBuffer();

  const bytesForPdfJs = originalBytes.slice(0);
  const bytesForPdfLib = originalBytes.slice(0);

  const pdfJs = await getPdfJsDoc(bytesForPdfJs);
  const numPages = pdfJs.numPages;

  const p1TextRaw = await extractPageTextRaw(pdfJs, 1);
  const p1Clean = cleanPunc(p1TextRaw);

  const isCleanTwoPage =
    (fuzzyIncludesPhrase(p1Clean, "DEEP", 1) ||
     fuzzyIncludesPhrase(p1Clean, "SPARKLE", 2)) &&
    numPages === 2;

  if (isCleanTwoPage) {
    const srcPdf = await PDFLib.PDFDocument.load(bytesForPdfLib);

    for (let p = 1; p <= 2; p++) {
      const raw = cleanPunc(await extractPageTextRaw(pdfJs, p));
      let desc = "";
      if (fuzzyIncludesPhrase(raw, "DEEP", 1)) desc = "PERFECT DEEP";
      else if (fuzzyIncludesPhrase(raw, "SPARKLE", 2)) desc = "PERFECT SPARKLE";
      else desc = "CLEAN";

      const newName = `${address} - VOID ${desc} WORK ORDER REQUEST.pdf`;

      const newDoc = await PDFLib.PDFDocument.create();
      const [copied] = await newDoc.copyPages(srcPdf, [p - 1]);
      newDoc.addPage(copied);
      const bytes = await newDoc.save();

      const folder = pickFolderByFilename(newName);
      if (!seenByFolder.has(folder)) seenByFolder.set(folder, new Set());
      const finalName = uniquify(newName, seenByFolder.get(folder));

      const target = folder ? zip.folder(folder) : zip;
      target.file(finalName, bytes);

      if (onStep) onStep(`Clean PDF split → ${finalName}`);
    }
    return;
  }

  // Normal WO: Hybrid Text → OCR
  const page = await pdfJs.getPage(1);
  const viewport = page.getViewport({ scale: 1.0 });

  const contractorRegion = getRegionCoords(
    viewport,
    CONTRACTOR_LEFT_PCT,
    CONTRACTOR_RIGHT_PCT,
    CONTRACTOR_TOP_PCT,
    CONTRACTOR_BOTTOM_PCT
  );

  const descRegion = getRegionCoords(
    viewport,
    CROP_LEFT_PCT,
    CROP_RIGHT_PCT,
    CROP_TOP_PCT,
    CROP_BOTTOM_PCT
  );

  const pageCanvas = await renderPdfPageToCanvas(pdfBlobOrFile, 1, 2.0);

  const contractorCrop = cropFixedContractorRegion(pageCanvas);
  const descCrop = cropFixedDescRegion(pageCanvas);

  const contractorText = await smartExtract(pdfJs, contractorCrop, contractorRegion);
  const rawDesc = await smartExtract(pdfJs, descCrop, descRegion);

  const mapped = mapWorkOrderDescription(rawDesc, contractorText);
  const finalDesc = cleanPunc(mapped || rawDesc || "WORK ORDER");

  const newName = `${address} - VOID ${finalDesc} WORK ORDER REQUEST.pdf`;
  const folder = pickFolderByFilename(newName);

  if (!seenByFolder.has(folder)) seenByFolder.set(folder, new Set());
  const finalName = uniquify(newName, seenByFolder.get(folder));

  const target = folder ? zip.folder(folder) : zip;
  target.file(finalName, originalBytes);

  if (onStep) onStep(`Work Order → ${finalName}`);
}

// =======================================================
// Inspection Pack Splitter → append parts into ZIP (Optimised)
// =======================================================
async function appendInspectionPackToZip(zip, bigPdfBlob, address, seenByFolder, onStep) {
  // Read PDF once; create two independent copies for pdf.js and pdf-lib
  const originalBytes = await bigPdfBlob.arrayBuffer();
  const bytesForPdfJs  = originalBytes.slice(0);
  const bytesForPdfLib = originalBytes.slice(0);

  const pdfJsDoc = await getPdfJsDoc(bytesForPdfJs);
  const srcDoc   = await PDFLib.PDFDocument.load(bytesForPdfLib);

  const total = pdfJsDoc.numPages;

  // Read header text (page 1) — cleaned for detection
  const p1Clean = await extractPageTextClean(pdfJsDoc, 1);

  const isAcGold =
    includesAny(p1Clean, ["MULTI TRADE WORKS"]) ||
    includesAny(p1Clean, ["MULTI-TRADE WORKS"]);

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
      lastText = await extractPageTextClean(pdfJsDoc, total);
    }
    const lastIsBmd = includesAny(lastText, ["BMD WORKS REQUIRED"]);
    const mtwEnd = lastIsBmd ? total - 1 : total;

    let mtwIdx = 0;
    for (let p = 2; p <= mtwEnd; p++) {
      const txt = await extractPageTextClean(pdfJsDoc, p);
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
      const p2Text = await extractPageTextClean(pdfJsDoc, 2);
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
      const txt = await extractPageTextClean(pdfJsDoc, p);
      if (looksBlankText(txt)) continue;
      bmdIdx++;
      await saveSinglePage(p, `${address} - VOID BMD WORKS (${bmdIdx}).pdf`);
    }
  }
}


// =======================================
// QUEUE STATE + HELPERS (Optimised)
// =======================================
const processBtn = document.getElementById("processBtn");
const clearBtn = document.getElementById("clearBtn");
const queueList = document.getElementById("queueList");
const dropzone = document.getElementById("dropzone");

let queuedFiles = [];

function renderQueue() {
  if (!queueList) return;
  if (!queuedFiles.length) {
    queueList.innerHTML = `<div style="color:#666">Queue is empty.</div>`;
    return;
  }

  const items = queuedFiles.map((f, idx) => {
    const sizeKB = Math.max(1, Math.round((f.size || 0) / 1024));
    return `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border:1px solid #e5e5e5;border-radius:6px;margin-bottom:6px;background:#fff">
        <div style="max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${f.name}">
          ${idx + 1}. ${f.name} <span style="color:#999">(${sizeKB} KB)</span>
        </div>
        <button data-remove="${idx}" style="background:#eee;border:1px solid #ddd;color:#333;padding:3px 8px;border-radius:4px;cursor:pointer">Remove</button>
      </div>`;
  }).join("");

  queueList.innerHTML = items;

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

renderQueue();


// =======================================
// DRAG & DROP → Queue only (No auto-run)
// =======================================
["dragover", "drop"].forEach(evt => {
  document.addEventListener(evt, e => e.preventDefault());
});

if (dropzone) {
  dropzone.addEventListener("dragover", e => {
    e.preventDefault();
    dropzone.style.opacity = 0.85;
  });

  dropzone.addEventListener("dragleave", () => {
    dropzone.style.opacity = 1;
  });

  dropzone.addEventListener("drop", e => {
    e.preventDefault();
    dropzone.style.opacity = 1;
    addToQueue(e.dataTransfer.files);
  });
}


// =======================================
// CLEAR QUEUE
// =======================================
if (clearBtn) {
  clearBtn.addEventListener("click", () => {
    queuedFiles = [];
    renderQueue();
  });
}


// =======================================
// PROCESS BUTTON → Run pipeline
// =======================================
if (processBtn) {
  processBtn.addEventListener("click", async () => {
    if (!queuedFiles.length) {
      alert("Queue is empty. Drop PDF(s) or ZIP(s) first.");
      return;
    }
    try {
      await processQueuedFiles();
    } catch (err) {
      console.error(err);
      alert("An error occurred during processing.");
    }
  });
}


// =======================================
// MAIN PIPELINE (ZIP flatten → detect → process)
// =======================================
async function processQueuedFiles() {
  let droppedFiles = Array.from(queuedFiles);

  // Flatten ZIPs into PDFs
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

  // Filter to PDFs
  const pdfFiles = droppedFiles.filter(f => f.name.toLowerCase().endsWith(".pdf"));
  if (!pdfFiles.length) {
    alert("No PDF files found.");
    return;
  }

  // Discover address from first inspection pack
  ensureProgressUI();
  setProgress(0, 100, "Analysing files…");

  const filePlans = [];
  let estimatedSteps = 0;
  let address = "";

  for (const f of pdfFiles) {
    const bytes = await f.arrayBuffer();
    const doc = await getPdfJsDoc(bytes);

    const p1Raw = await extractPageTextRaw(doc, 1);
    const p1Clean = cleanPunc(p1Raw);

    const isPack = isInspectionPackHeader(p1Clean);
    const pages = doc.numPages;

    if (isPack && !address) {
      const extracted = extractAddressFromHeader(p1Raw);
      address = toFilenameAddressKeepCommas(extracted);
    }

    filePlans.push({ file: f, isPack, pages });
    estimatedSteps += isPack ? pages : 1;
  }

  if (!address) {
    alert("Could not auto-detect address from an Inspection Checklist header. Please include an inspection pack.");
    finishProgress();
    return;
  }

  // Process into one ZIP
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

  // Finalize ZIP + Download
  setProgress(estimatedSteps, estimatedSteps, "Packaging ZIP…");
  const outBlob = await outZip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(outBlob);
  a.download = `${address}.zip`;
  a.click();

  finishProgress();
}
