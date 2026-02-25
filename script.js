// =======================================
// FAST WORKFLOW: Fixed-crop OCR only for Work Orders (Trimmed + Optimised)
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

const toUpper = s => (s || "").toUpperCase();
const cleanPunc = s =>
  toUpper(s).replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

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

// Natural sort for filenames (A2 before A10)
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// --- A2: simplified, fast tokenization + fuzzy ---
function tokenize(str) {
  return cleanPunc(str).split(/\s+/).filter(Boolean);
}

// Lightweight Levenshtein (OK for short phrases)
function levenshtein(a, b) {
  a = a || ""; b = b || "";
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return prev[n];
}

// A2: fast fuzzy phrase search with a quick direct-include check first
function fuzzyIncludesPhrase(haystack, phrase, maxDist) {
  const H = cleanPunc(haystack);
  const P = cleanPunc(phrase);
  if (!H || !P) return false;

  // direct include fast-path
  if (H.includes(P)) return true;

  const hayTokens = H.split(" ");
  const phraseTokens = P.split(" ");
  const windowSize = phraseTokens.length;
  const target = phraseTokens.join(" ");

  if (hayTokens.length < windowSize) return false;

  for (let i = 0; i <= hayTokens.length - windowSize; i++) {
    const window = hayTokens.slice(i, i + windowSize).join(" ");
    if (levenshtein(window, target) <= maxDist) return true;
  }
  return false;
}

// =======================================
// State
// =======================================
let files = []; // [{ zipName, blob, classify?:{kind,desc}, woExtracted?:string, contractorExtracted?:string }]
let idx = 0;
let mtwN = 0;
let bmdN = 0;

// =======================================
// DOM references
// =======================================
const dropzone = $("#dropzone");
const wizard = $("#wizard");
const canvas = $("#pdfCanvas");
const ctx = canvas.getContext("2d");
const fileLabel = $("#fileLabel");
const idxSpan = $("#idx");
const totSpan = $("#total");
const mtwSpan = $("#mtwCount");
const bmdSpan = $("#bmdCount");
const descWrap = $("#descWrap");
const descIn = $("#desc");
const errBox = $("#err");
const prevBtn = $("#prevBtn");
const nextBtn = $("#nextBtn");
const finishBtn = $("#finishBtn");

const ocrBadge = $("#ocrBadge");
const ocrDot = $("#ocrDot");
const ocrStatus = $("#ocrStatus");

// =======================================
// PDF rendering helpers (faster scale)
// =======================================
async function renderPdfPageToCanvas(blob, pageNum = 1, scale = 1.5) {
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
// Image enhancement (E3: only used for contractor region)
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

  // grayscale + simple auto-level
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
    if (y > 170) y = Math.min(255, y + 20); // slight highlight push
    data[i] = data[i + 1] = data[i + 2] = y;
  }

  dctx.putImageData(img, 0, 0);
  return dst;
}

// =======================================
// OCR helpers (single-pass, fast)
// =======================================

async function ocrFast(cropCanvas) {
  const res = await Tesseract.recognize(cropCanvas, "eng", {
    tessedit_char_whitelist: "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode: 6 // uniform block (good for 1 line too)
  });
  const text = (res?.data?.text || "")
    .toUpperCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

// Description: no enhancement (fast)
async function ocrCroppedSingleLine(cropCanvas) {
  return await ocrFast(cropCanvas);
}

// Contractor: keep enhancement (E3)
async function ocrCroppedContractor(cropCanvas) {
  const enhanced = enhanceForOcr(cropCanvas);
  return await ocrFast(enhanced);
}

// =======================================
// Work Order extraction pipeline (Contractor-first override)
// =======================================
async function ensureWorkOrderExtracted(fileItem) {
  if (fileItem.woExtracted != null && fileItem.contractorExtracted != null) {
    return fileItem.woExtracted;
  }

  ocrDot.className = "dot busy";
  ocrStatus.textContent = "Scanning…";

  try {
    const pageCanvas = await renderPdfPageToCanvas(fileItem.blob, 1, 1.5);

    // 1) Contractor row first (drives mapping)
    const contractorCrop = cropFixedContractorRegion(pageCanvas);
    const contractor = await ocrCroppedContractor(contractorCrop);
    fileItem.contractorExtracted = contractor || "";
    const contractorNorm = cleanPunc(contractor);

    // 2) Contractor-led mapping (A2 fast fuzzy)
    if (fuzzyIncludesPhrase(contractorNorm, "ASPECT CONTRACT", 2)) {
      fileItem.woExtracted = "ASBESTOS REMOVAL";
      ocrDot.className = "dot ok";
      ocrStatus.textContent = "Contractor mapped";
      return fileItem.woExtracted;
    }

    if (fuzzyIncludesPhrase(contractorNorm, "LIFE ENVIRONMENTAL", 2) ||
        fuzzyIncludesPhrase(contractorNorm, "LIFE ENVIROMENTAL", 2)) {
      fileItem.woExtracted = "ASBESTOS SURVEY";
      ocrDot.className = "dot ok";
      ocrStatus.textContent = "Contractor mapped";
      return fileItem.woExtracted;
    }

    if (fuzzyIncludesPhrase(contractorNorm, "RODGERS ELECTRICAL", 2)) {
      fileItem.woExtracted = "RODGERS ISOLATOR";
      ocrDot.className = "dot ok";
      ocrStatus.textContent = "Contractor mapped";
      return fileItem.woExtracted;
    }

    // 3) No contractor match → description OCR
    const descCrop = cropFixedDescRegion(pageCanvas);
    const desc = await ocrCroppedSingleLine(descCrop);

    fileItem.woExtracted = desc || "";
    ocrDot.className = desc ? "dot ok" : "dot err";
    ocrStatus.textContent = desc ? "OK" : "No text found";
    return fileItem.woExtracted;

  } catch (e) {
    console.error("WO fixed-crop OCR failed", e);
    ocrDot.className = "dot err";
    ocrStatus.textContent = "OCR error";
    fileItem.woExtracted = "";
    fileItem.contractorExtracted = "";
    return "";
  }
}

// ================================
// DRAG & DROP (ZIP or multiple PDFs)
// ================================
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

  const address = cleanPunc($("#address").value);
  if (!address) {
    alert("Please enter the ADDRESS first.");
    return;
  }

  const droppedFiles = Array.from(e.dataTransfer.files);
  if (!droppedFiles.length) {
    alert("No files dropped.");
    return;
  }

  files = [];
  mtwN = 0;
  bmdN = 0;
  ocrDot.className = "dot";
  ocrStatus.textContent = "Idle";

  // CASE 1 — ZIP FILE
  if (droppedFiles.length === 1 && droppedFiles[0].name.toLowerCase().endsWith(".zip")) {
    try {
      const zip = await JSZip.loadAsync(droppedFiles[0]);
      const entries = Object.values(zip.files)
        .filter(f => !f.dir && f.name.toLowerCase().endsWith(".pdf"))
        .sort((a, b) => naturalSort(a.name, b.name));

      if (!entries.length) {
        alert("No PDF files found in the ZIP.");
        return;
      }

      for (const entry of entries) {
        const blob = await zip.file(entry.name).async("blob");
        files.push({
          zipName: entry.name,
          blob,
          classify: null,
          woExtracted: null,
          contractorExtracted: null
        });
      }
    } catch (err) {
      console.error(err);
      alert("Failed to read ZIP.");
      return;
    }
  }

  // CASE 2 — MULTIPLE PDFs
  else if (droppedFiles.every(f => f.name.toLowerCase().endsWith(".pdf"))) {
    const sorted = droppedFiles.sort((a, b) => naturalSort(a.name, b.name));
    for (const f of sorted) {
      files.push({
        zipName: f.name,
        blob: f,
        classify: null,
        woExtracted: null,
        contractorExtracted: null
      });
    }
  }

  else {
    alert("Please drop either:\n• A ZIP file\n• OR one/multiple PDFs (only PDFs)");
    return;
  }

  // Start wizard
  idx = 0;
  wizard.classList.remove("hidden");
  dropzone.classList.add("hidden");

  totSpan.textContent = files.length;
  mtwSpan.textContent = "0";
  bmdSpan.textContent = "0";

  await showCurrent();
});

// ================================
// UI + Preview
// ================================
function getSelectedKind() {
  const r = $$("input[name='kind']").find(x => x.checked);
  return r ? r.value : null;
}

function setSelectedKind(kind) {
  $$("input[name='kind']").forEach(x => x.checked = (x.value === kind));
}

// ---- Patched: auto-run OCR when needed, restore radio reliably ----
async function showCurrent() {
  errBox.classList.add("hidden");
  ocrBadge.classList.add("hidden");
  ocrDot.className = "dot";
  ocrStatus.textContent = "Idle";

  idxSpan.textContent = String(idx + 1);

  prevBtn.classList.toggle("muted", idx === 0);
  nextBtn.classList.toggle("hidden", idx >= files.length - 1);
  finishBtn.classList.toggle("hidden", idx < files.length - 1);

  const file = files[idx];

  // Restore radio
  if (file.classify && file.classify.kind) {
    setSelectedKind(file.classify.kind);
  } else if (idx === 0) {
    setSelectedKind("CHECKLIST");
  } else {
    setSelectedKind("CHECKLIST");
  }

  const selectedKind = getSelectedKind();

  // Toggle description input for Work Order
  descWrap.classList.toggle("hidden", selectedKind !== "WORK_ORDER");

  // Auto-OCR if Work Order selected
  if (selectedKind === "WORK_ORDER") {
    if (file.woExtracted != null) {
      // Already OCR'ed → restore
      descIn.value = file.woExtracted;
      ocrBadge.classList.remove("hidden");
    } else {
      // Not OCR'ed → run now
      ocrDot.className = "dot busy";
      ocrStatus.textContent = "Scanning…";

      descIn.value = "";
      const extracted = await ensureWorkOrderExtracted(file);

      descIn.value = extracted || "";
      ocrBadge.classList.remove("hidden");

      if (!file.classify) file.classify = {};
      file.classify.kind = "WORK_ORDER";
      file.classify.desc = cleanPunc(descIn.value);

      ocrDot.className = extracted ? "dot ok" : "dot err";
      ocrStatus.textContent = extracted ? "OK" : "No text found";
    }
  } else {
    // Non-Work Order: restore text if any
    descIn.value = file.classify?.desc || "";
  }

  // Render preview
  fileLabel.textContent = file.zipName;
  await renderPreview(file.blob);
}

async function renderPreview(blob) {
  try {
    const buf = await blob.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);

    const desiredWidth = 420;
    const initialViewport = page.getViewport({ scale: 1 });
    const scale = desiredWidth / initialViewport.width;
    const viewport = page.getViewport({ scale });

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    ctx.setTransform(1,0,0,1,0,0);
    ctx.clearRect(0,0,canvas.width,canvas.height);

    await page.render({ canvasContext: ctx, viewport }).promise;
  } catch (err) {
    console.warn("Preview failed", err);
    ctx.clearRect(0,0,canvas.width,canvas.height);
  }
}

// --- Save radio change immediately + trigger OCR when switched to Work Order
$$("input[name='kind']").forEach(r =>
  r.addEventListener("change", async () => {
    const kind = r.value;

    // save immediately
    if (kind === "WORK_ORDER") {
      files[idx].classify = { kind, desc: cleanPunc(descIn.value) };
    } else {
      files[idx].classify = { kind, desc: "" };
    }

    // UI toggle
    descWrap.classList.toggle("hidden", kind !== "WORK_ORDER");

    // OCR only when switched to Work Order
    if (kind === "WORK_ORDER") {
      const current = files[idx];

      if (current.woExtracted != null) {
        descIn.value = current.woExtracted;
        ocrBadge.classList.remove("hidden");
        return;
      }

      descIn.value = "";
      const extracted = await ensureWorkOrderExtracted(current);
      descIn.value = extracted || "";
      ocrBadge.classList.remove("hidden");

      // Save again after OCR fills description
      files[idx].classify.desc = cleanPunc(descIn.value);
    }
  })
);

// ================================
// Navigation
// ================================
prevBtn.addEventListener("click", async () => {
  if (idx === 0) return;
  idx--;
  await showCurrent();
});

nextBtn.addEventListener("click", async () => {
  if (!validateCurrent()) return;
  saveChoice();
  idx++;
  await showCurrent();
});

finishBtn.addEventListener("click", async () => {
  if (!validateCurrent()) return;
  saveChoice();
  await buildAndDownload();
});

// ================================
// Validation
// ================================
function validateCurrent() {
  errBox.classList.add("hidden");

  const k = getSelectedKind();
  if (!k) {
    errBox.textContent = "Please choose a type.";
    errBox.classList.remove("hidden");
    return false;
  }

  if (k === "WORK_ORDER") {
    const d = cleanPunc(descIn.value);
    if (!d) {
      errBox.textContent = "Please enter the Work Order description.";
      errBox.classList.remove("hidden");
      return false;
    }
  }
  return true;
}

// ================================
// Save choice (used by Next/Finish)
// ================================
function saveChoice() {
  const k = getSelectedKind();
  const d = (k === "WORK_ORDER") ? cleanPunc(descIn.value) : "";
  files[idx].classify = { kind: k, desc: d };

  if (k === "MTW") {
    mtwN++;
    mtwSpan.textContent = String(mtwN);
  }
  if (k === "BMD") {
    bmdN++;
    bmdSpan.textContent = String(bmdN);
  }
}

// ================================
// Folder Routing  (includes PERFECT DEEP/SPARKLE)
// ================================
function pickFolderByFilename(finalName) {
  const n = (finalName || "").toUpperCase();

  // ASBESTOS group
  const hasAsbestos = n.includes("ASBESTOS");
  const hasContractor = n.includes("LIFE") || n.includes("ASPECT");
  const hasRemovalOrSurvey = n.includes("REMOVAL") || n.includes("SURVEY");

  if (hasAsbestos || hasContractor || (hasRemovalOrSurvey && (hasAsbestos || hasContractor))) {
    return "Asbestos";
  }

  if (n.includes("INSPECTION CHECKLIST")) return "Inspection Checklist";

  // CLEANS + CLEAROUTS — supports new mapped names
  if (
      n.includes("CLEAN") ||
      n.includes("PERFECT DEEP") ||
      n.includes("PERFECT SPARKLE")
  ) return "Cleans + Clearouts";

  if (n.includes("EICR")) return "Periodic - Rewires";
  if (n.includes("EPC")) return "EPC";
  if (n.includes("ROT WORKS")) return "Rot Works";
  if (n.includes("RECHARGE")) return "Rechargeable Repairs";
  if (n.includes("AC GOLD MTW")) return "MTW";
  if (n.includes("MTW AS PER VRR")) return "MTW";
  if (n.includes("BMD WORKS")) return "NEC Lines";

  return ""; // default → ZIP root
}

// ================================
// Work Order Mapping Rules (A2 thresholds)
// ================================
function mapWorkOrderDescription(desc, contractorText) {
  const hay = `${desc || ""} ${contractorText || ""}`.trim();

  // Contractor-led (highest priority)
  if (fuzzyIncludesPhrase(hay, "ASPECT CONTRACT", 2)) {
    return "ASBESTOS REMOVAL";
  }

  if (fuzzyIncludesPhrase(hay, "LIFE ENVIRONMENTAL", 2) ||
      fuzzyIncludesPhrase(hay, "LIFE ENVIROMENTAL", 2)) {
    return "ASBESTOS SURVEY";
  }

  if (fuzzyIncludesPhrase(hay, "RODGERS ELECTRICAL", 2)) {
    return "RODGERS ISOLATOR";
  }

  // Description-led
  if (fuzzyIncludesPhrase(hay, "DEEP", 1)) {
    return "PERFECT DEEP";
  }

  if (fuzzyIncludesPhrase(hay, "SPARKLE", 1)) {
    return "PERFECT SPARKLE";
  }

  return null; // no mapping → use original
}

// ================================
// ZIP generation
// ================================
async function buildAndDownload() {
  const address = cleanPunc($("#address").value);
  const zip = new JSZip();

  const seenByFolder = new Map();
  const seenSet = folder => {
    if (!seenByFolder.has(folder)) seenByFolder.set(folder, new Set());
    return seenByFolder.get(folder);
  };

  let mtwCount = 0;
  let bmdCount = 0;

  for (const item of files) {
    const c = item.classify;
    let newName = "";

    if (!c || c.kind === "SKIP") {
      newName = `${address} - VOID.pdf`;
    } else {

      switch (c.kind) {
        case "CHECKLIST":
          newName = `${address} - VOID INSPECTION CHECKLIST.pdf`;
          break;

        case "MTW":
          mtwCount++;
          newName = `${address} - VOID AC GOLD MTW (${mtwCount}).pdf`;
          break;

        case "RECHARGE":
          newName = `${address} - VOID_RECHARGEABLE_Works.pdf`;
          break;

        case "BMD":
          bmdCount++;
          newName = `${address} - VOID BMD WORKS (${bmdCount}).pdf`;
          break;

        case "WORK_ORDER": {
          const contractText = item.contractorExtracted || "";
          const mapped = mapWorkOrderDescription(c.desc, contractText);
          const finalDesc = cleanPunc(mapped || c.desc);
          newName = `${address} - VOID ${finalDesc} WORK ORDER REQUEST.pdf`;
          break;
        }
      }
    }

    const folder = pickFolderByFilename(newName);
    const set = seenSet(folder);
    const finalName = uniquify(newName, set);

    const target = folder ? zip.folder(folder) : zip;
    target.file(finalName, item.blob);
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${address} - VOID RENAMED.zip`;
  a.click();
}
