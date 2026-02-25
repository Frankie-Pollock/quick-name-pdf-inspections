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

// Natural sort for filenames (e.g., A2 before A10)
function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

// =======================================
// State
// =======================================
let files = [];      // [{ zipName, blob, classify?:{kind,desc}, woExtracted?:string }]
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
// OCR helpers – only for Work Orders
// =======================================

/**
 * Render ALL pages of a PDF blob into canvases and OCR with Tesseract.
 * Returns raw text (uppercase/cleaning applied by caller).
 */
async function ocrAllPages(blob) {
  // UI status
  ocrDot.className = "dot busy";
  ocrStatus.textContent = "OCR scanning…";

  try {
    const buf = await blob.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;

    let combined = "";
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);

      // Higher scale improves OCR quality on scans
      const viewport = page.getViewport({ scale: 2.0 });
      const c = document.createElement("canvas");
      const cx = c.getContext("2d");
      c.width = viewport.width;
      c.height = viewport.height;

      await page.render({ canvasContext: cx, viewport }).promise;

      const { data: { text } } = await Tesseract.recognize(c, "eng");
      combined += `\n${text}`;
    }

    ocrDot.className = "dot ok";
    ocrStatus.textContent = "OCR OK";
    return combined;

  } catch (err) {
    console.error("OCR FAILED:", err);
    ocrDot.className = "dot err";
    ocrStatus.textContent = "OCR ERROR";
    return "";
  }
}

/**
 * Extract the Work Order description from OCR text.
 * We look for:
 *   "DESCRIPTION OF WORKS REQUIRED"
 * and stop at the next heading that begins with:
 *   "OUTCOME OF ONSITE"
 * Then we return ONLY the FIRST non-empty line from inside this block (Option A).
 */
function extractWorkOrderDescription(rawText) {
  if (!rawText) return "";

  // Normalise spacing for robust matching
  const normalized = rawText
    .replace(/\r/g, "")
    .replace(/[^\S\r\n]+/g, " "); // collapse horizontal whitespace

  // Case-insensitive indices for the section headers
  const hay = normalized.toUpperCase();

  // Find the start after "DESCRIPTION OF WORKS REQUIRED"
  const startHeader = "DESCRIPTION OF WORKS REQUIRED";
  const startIdx = hay.indexOf(startHeader);
  if (startIdx === -1) return ""; // Can't find the header → no extraction

  // Slice content after the header line
  let after = normalized.slice(startIdx + startHeader.length);

  // Stop at the next known header "OUTCOME OF ONSITE"
  const stopHeader = "OUTCOME OF ONSITE";
  const stopInAfter = after.toUpperCase().indexOf(stopHeader);
  if (stopInAfter !== -1) {
    after = after.slice(0, stopInAfter);
  }

  // Now 'after' is the block of interest.
  // Split into lines and pick the FIRST non-blank line (Option A).
  const lines = after
    .split(/\n+/)
    .map(s => s.trim())
    .filter(Boolean);

  if (!lines.length) return "";

  // Clean punctuation + uppercase to match your file naming convention
  return cleanPunc(lines[0]);
}

/**
 * Run OCR for current file to extract WO description.
 * Caches to files[idx].woExtracted so repeated selections are instant.
 */
async function ensureWorkOrderExtracted(current) {
  if (current.woExtracted) {
    // Already OCR'd and extracted for this file
    return current.woExtracted;
  }
  const raw = await ocrAllPages(current.blob);
  const desc = extractWorkOrderDescription(raw);
  current.woExtracted = desc || ""; // cache even if empty to avoid repeat OCR
  return current.woExtracted;
}

// =======================================
// Drag & Drop (ZIP or multiple PDFs)
// =======================================
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

      // Get file entries, PDFs only, sorted naturally by full path/name
      const entries = Object.values(zip.files)
        .filter(f => !f.dir && f.name.toLowerCase().endsWith(".pdf"))
        .sort((a, b) => naturalSort(a.name, b.name));

      if (!entries.length) {
        alert("No PDF files found in the ZIP.");
        return;
      }

      for (const entry of entries) {
        const blob = await zip.file(entry.name).async("blob");
        files.push({ zipName: entry.name, blob, classify: null, woExtracted: null });
      }
    } catch (err) {
      console.error(err);
      alert("Failed to read ZIP.");
      return;
    }
  }

  // CASE 2 — MULTIPLE PDFs (or single)
  else if (droppedFiles.every(f => f.name.toLowerCase().endsWith(".pdf"))) {
    const sorted = droppedFiles.sort((a, b) => naturalSort(a.name, b.name));
    for (const f of sorted) {
      files.push({ zipName: f.name, blob: f, classify: null, woExtracted: null });
    }
  }

  // CASE 3 — Mixed or invalid
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

// =======================================
// UI + Preview
// =======================================
function getSelectedKind() {
  const r = $$("input[name='kind']").find(x => x.checked);
  return r ? r.value : null;
}

function setSelectedKind(kind) {
  $$("input[name='kind']").forEach(x => x.checked = (x.value === kind));
}

async function showCurrent() {
  errBox.classList.add("hidden");
  ocrBadge.classList.add("hidden");
  ocrDot.className = "dot"; // reset per screen
  ocrStatus.textContent = "Idle";

  idxSpan.textContent = String(idx + 1);

  prevBtn.classList.toggle("muted", idx === 0);
  nextBtn.classList.toggle("hidden", idx >= files.length - 1);
  finishBtn.classList.toggle("hidden", idx < files.length - 1);

  const current = files[idx].classify;

  // Reset form state
  setSelectedKind(current?.kind || null);
  descWrap.classList.toggle("hidden", getSelectedKind() !== "WORK_ORDER");
  descIn.value = current?.desc || "";

  fileLabel.textContent = files[idx].zipName;

  await renderPreview(files[idx].blob);
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

// Toggle Work Order description box on radio changes.
// If user selects WORK_ORDER, immediately OCR & autofill description.
$$("input[name='kind']").forEach(r =>
  r.addEventListener("change", async () => {
    const kind = getSelectedKind();
    descWrap.classList.toggle("hidden", kind !== "WORK_ORDER");

    // If user selects Work Order → run OCR once for this file
    if (kind === "WORK_ORDER") {
      const current = files[idx];

      // Already extracted via cache? Autofill directly.
      if (current.woExtracted != null) {
        descIn.value = current.woExtracted;
        ocrBadge.classList.remove("hidden");
        return;
      }

      // Otherwise run OCR now
      descIn.value = ""; // clear while scanning
      const extracted = await ensureWorkOrderExtracted(current);
      descIn.value = extracted || ""; // may be empty if not found
      ocrBadge.classList.remove("hidden");
    }
  })
);

// =======================================
// Navigation
// =======================================
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

// =======================================
// Validation
// =======================================
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

// =======================================
// Save classification
// =======================================
function saveChoice() {
  const k = getSelectedKind();
  const d = k === "WORK_ORDER" ? cleanPunc(descIn.value) : "";
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

// =======================================
// Folder Routing (unchanged rules)
// =======================================
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
  if (n.includes("CLEAN")) return "Cleans + Clearouts";
  if (n.includes("EICR")) return "Periodic - Rewires";
  if (n.includes("EPC")) return "EPC";
  if (n.includes("ROT WORKS")) return "Rot Works";
  if (n.includes("RECHARGE")) return "Rechargeable Repairs";
  if (n.includes("AC GOLD MTW")) return "MTW";
  if (n.includes("AC GOLD")) return "MTW";
  if (n.includes("BMD WORKS")) return "NEC Lines";

  return ""; // default → ZIP root
}

// =======================================
// ZIP generation
// =======================================
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
        case "WORK_ORDER":
          newName = `${address} - VOID ${cleanPunc(c.desc)} WORK ORDER REQUEST.pdf`;
          break;
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
