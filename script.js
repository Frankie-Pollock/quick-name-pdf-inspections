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

// =======================================
// OCR using Tesseract.js
// =======================================
async function ocrPdfFirstPage(blob) {
  ocrDot.className = "dot busy";
  ocrStatus.textContent = "OCR scanning…";

  try {
    const buf = await blob.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const page = await pdf.getPage(1);

    const viewport = page.getViewport({ scale: 2.0 });
    const c = document.createElement("canvas");
    const ctx2 = c.getContext("2d");

    c.width = viewport.width;
    c.height = viewport.height;

    await page.render({ canvasContext: ctx2, viewport }).promise;

    const result = await Tesseract.recognize(
      c,
      "eng",
      { logger: _ => {} }
    );

    ocrDot.className = "dot ok";
    ocrStatus.textContent = "OCR OK";

    return cleanPunc(result.data.text);
  } catch (err) {
    console.warn("OCR FAILED:", err);
    ocrDot.className = "dot err";
    ocrStatus.textContent = "OCR ERROR";
    return "";
  }
}

// =======================================
// Auto Classification
// =======================================
function autoClassify(text) {
  const t = toUpper(text);

  if (t.includes("INSPECTION") || t.includes("CHECKLIST"))
    return { kind: "CHECKLIST" };

  if (t.includes("AC GOLD") || t.includes("MTW"))
    return { kind: "MTW" };

  if (t.includes("RECHARGE"))
    return { kind: "RECHARGE" };

  if (t.includes("BMD"))
    return { kind: "BMD" };

  // Work order detection
  if (t.includes("WORK") || t.includes("ORDER") || t.includes("REPAIR")) {
    // Take first phrase-ish chunk
    const desc = cleanPunc(t.slice(0, 80));
    return { kind: "WORK_ORDER", desc };
  }

  return { kind: null };
}

// =======================================
// State
// =======================================
let files = [];
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
// Drag & Drop
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
  if (!droppedFiles.length) return alert("No files dropped.");

  files = [];
  mtwN = 0;
  bmdN = 0;

  // ZIP
  if (droppedFiles.length === 1 && droppedFiles[0].name.toLowerCase().endsWith(".zip")) {
    try {
      const zip = await JSZip.loadAsync(droppedFiles[0]);
      const entries = Object.values(zip.files).filter(
        f => !f.dir && f.name.toLowerCase().endsWith(".pdf")
      );

      for (const entry of entries) {
        const blob = await zip.file(entry.name).async("blob");
        const text = await ocrPdfFirstPage(blob);
        const guess = autoClassify(text);
        files.push({
          zipName: entry.name,
          blob,
          classify: guess.kind ? guess : null
        });
      }
    } catch (err) {
      console.error(err);
      return alert("Unable to read ZIP.");
    }
  }

  // Multiple PDFs
  else if (droppedFiles.every(f => f.name.toLowerCase().endsWith(".pdf"))) {
    for (const f of droppedFiles) {
      const text = await ocrPdfFirstPage(f);
      const guess = autoClassify(text);
      files.push({
        zipName: f.name,
        blob: f,
        classify: guess.kind ? guess : null
      });
    }
  }

  else return alert("Please drop a ZIP or PDFs only.");

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

  idxSpan.textContent = idx + 1;

  prevBtn.classList.toggle("muted", idx === 0);
  nextBtn.classList.toggle("hidden", idx >= files.length - 1);
  finishBtn.classList.toggle("hidden", idx < files.length - 1);

  const f = files[idx];
  const c = f.classify;

  setSelectedKind(null);
  descIn.value = "";

  if (c && c.kind) {
    setSelectedKind(c.kind);
    if (c.kind === "WORK_ORDER" && c.desc) descIn.value = c.desc;
    ocrBadge.classList.remove("hidden");
  }

  descWrap.classList.toggle("hidden", getSelectedKind() !== "WORK_ORDER");

  fileLabel.textContent = f.zipName;

  await renderPreview(f.blob);
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
    ctx.clearRect(0,0,canvas.width,canvas.height);
  }
}

$$("input[name='kind']").forEach(r =>
  r.addEventListener("change", () => {
    descWrap.classList.toggle("hidden", getSelectedKind() !== "WORK_ORDER");
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
    mtwSpan.textContent = mtwN;
  }
  if (k === "BMD") {
    bmdN++;
    bmdSpan.textContent = bmdN;
  }
}

// =======================================
// Folder Routing
// =======================================
function pickFolderByFilename(n) {
  const name = toUpper(n);

  if (name.includes("ASBESTOS") || name.includes("LIFE") || name.includes("ASPECT"))
    return "Asbestos";
  if (name.includes("INSPECTION"))
    return "Inspection Checklist";
  if (name.includes("CLEAN"))
    return "Cleans + Clearouts";
  if (name.includes("EICR"))
    return "Periodic - Rewires";
  if (name.includes("EPC"))
    return "EPC";
  if (name.includes("ROT WORKS"))
    return "Rot Works";
  if (name.includes("RECHARGE"))
    return "Rechargeable Repairs";
  if (name.includes("AC GOLD"))
    return "MTW";
  if (name.includes("BMD WORKS"))
    return "NEC Lines";

  return "";
}

// =======================================
// ZIP BUILD
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
