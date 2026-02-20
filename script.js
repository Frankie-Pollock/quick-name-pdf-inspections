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
// FOLDER ROUTING LOGIC
// =======================================
function pickFolderByFilename(finalName) {
  const n = (finalName || "").toUpperCase();

  // ASBESTOS group
  const hasAsbestos = n.includes("ASBESTOS");
  const hasContractor = n.includes("LIFE") || n.includes("ASPECT");
  const hasRemovalOrSurvey = n.includes("REMOVAL") || n.includes("SURVEY");

  if (hasAsbestos || hasContractor || (hasRemovalOrSurvey && (hasAsbestos || hasContractor))) {
    return "ASBESTOS";
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

  const file = e.dataTransfer.files[0];
  if (!file || !file.name.toLowerCase().endsWith(".zip")) {
    alert("Please drop a .zip file.");
    return;
  }

  try {
    const zip = await JSZip.loadAsync(file);
    files = [];
    mtwN = 0;
    bmdN = 0;

    const entries = Object.values(zip.files).filter(
      f => !f.dir && f.name.toLowerCase().endsWith(".pdf")
    );

    if (!entries.length) {
      alert("No PDF files found in the ZIP.");
      return;
    }

    for (const entry of entries) {
      const blob = await zip.file(entry.name).async("blob");
      files.push({ zipName: entry.name, blob, classify: null });
    }

    idx = 0;
    wizard.classList.remove("hidden");
    dropzone.classList.add("hidden");

    totSpan.textContent = files.length;
    mtwSpan.textContent = "0";
    bmdSpan.textContent = "0";

    showCurrent();
  } catch (err) {
    console.error(err);
    alert("Failed to read the ZIP.");
  }
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

  idxSpan.textContent = String(idx + 1);

  prevBtn.classList.toggle("muted", idx === 0);
  nextBtn.classList.toggle("hidden", idx >= files.length - 1);
  finishBtn.classList.toggle("hidden", idx < files.length - 1);

  const current = files[idx].classify;

  setSelectedKind(current?.kind || null);

  // SHOW WORK ORDER FIELD PROPERLY
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
// Validation (ONLY when pressing Next/Finish)
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
// ZIP generation (WITH FOLDERS + SKIPPED FILE FIX)
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
      newName = `${address} - VOID.pdf`;   // KEEP skipped files
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
          newName = `${address} - VOID RECHARGEABLE WORKS.pdf`;
          break;
        case "BMD":
          bmdCount++;
          newName = `${address} - VOID BMD WORKS (${bmdCount}).pdf`;
          break;
        case "WORK_ORDER":
          newName = `${address} - VOID ${cleanPunc(c.desc)} REQUEST.pdf`;
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
