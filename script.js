// =======================================
// Utility helpers
// =======================================
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

const toUpper = s => (s || "").toUpperCase();
const cleanPunc = s =>
  toUpper(s).replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim();

// Unique filename helper
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
// Folder routing logic (NEW)
// =======================================
function pickFolderByFilename(finalName) {
  const n = (finalName || "").toUpperCase();

  if (n.includes("INSPECTION CHECKLIST")) return "Inspection Checklist";
  if (n.includes("CLEAN")) return "Cleans + Clearouts";
  if (n.includes("EICR")) return "Periodic - Rewires";
  if (n.includes("ASBESTOS")) return "ASBESTOS";
  if (n.includes("EPC")) return "EPC";
  if (n.includes("ROT WORKS")) return "Rot Works";
  if (n.includes("RECHARGE")) return "RECHARGEABLE REPAIRS"; // Rechargeable or Recharge
  if (n.includes("AC GOLD MTW")) return "MTW";
  if (n.includes("AC GOLD")) return "MTW"; // unnumbered AC GOLD
  if (n.includes("BMD WORKS")) return "NEC Lines";

  return ""; // root
}

// =======================================
// State
// =======================================
let files = [];       // [{zipName, blob, classify:{kind,desc}}]
let idx = 0;          // current file index
let mtwN = 0;         // MTW count tracker
let bmdN = 0;         // BMD count tracker

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
    alert("Failed to read the ZIP. Re‑zip the files and try again.");
  }
});

// =======================================
// Classification UI helpers
// =======================================
function getSelectedKind() {
  const r = $$("input[name='kind']").find(x => x.checked);
  return r ? r.value : null;
}

function setSelectedKind(kind) {
  $$("input[name='kind']").forEach(x => (x.checked = x.value === kind));
}

function requireInputsOrError() {
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
// File navigation + preview
// =======================================
async function showCurrent() {
  errBox.classList.add("hidden");

  idxSpan.textContent = String(idx + 1);

  prevBtn.classList.toggle("muted", idx === 0);
  nextBtn.classList.toggle("hidden", idx >= files.length - 1);
  finishBtn.classList.toggle("hidden", idx < files.length - 1);

  setSelectedKind(files[idx].classify?.kind || null);
  descWrap.classList.toggle(
    "hidden",
    (files[idx].classify?.kind || "") !== "WORK_ORDER"
  );
  descIn.value = files[idx].classify?.desc || "";

  fileLabel.textContent = files[idx].zipName;

  await renderPreview(files[idx].blob);
}

// =======================================
// SHARP PREVIEW (no blur, no degradation)
// =======================================
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

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    await page.render({
      canvasContext: ctx,
      viewport
    }).promise;
  } catch (e) {
    console.warn("Preview failed; blank canvas shown.", e);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

// =======================================
// Event: radio button changed
// =======================================
$$("input[name='kind']").forEach(r => {
  r.addEventListener("change", () => {
    const k = getSelectedKind();
    descWrap.classList.toggle("hidden", k !== "WORK_ORDER");
  });
});

// =======================================
// Navigation buttons
// =======================================
prevBtn.addEventListener("click", async () => {
  if (idx === 0) return;
  idx--;
  await showCurrent();
});

nextBtn.addEventListener("click", async () => {
  if (!requireInputsOrError()) return;
  saveChoice();
  idx++;
  await showCurrent();
});

finishBtn.addEventListener("click", async () => {
  if (!requireInputsOrError()) return;
  saveChoice();
  await buildAndDownload();
});

// =======================================
// Save the classification
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
// Build final ZIP (WITH FOLDERING)
// =======================================
async function buildAndDownload() {
  const address = cleanPunc($("#address").value);
  const zip = new JSZip();

  const seenByFolder = new Map();
  const getSeen = folder => {
    if (!seenByFolder.has(folder)) seenByFolder.set(folder, new Set());
    return seenByFolder.get(folder);
  };

  let mtwCount = 0;
  let bmdCount = 0;

  for (const item of files) {
    const c = item.classify;
    if (!c || c.kind === "SKIP") continue;

    let newName = "";

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

    const folder = pickFolderByFilename(newName);
    const seen = getSeen(folder);
    const finalName = uniquify(newName, seen);

    const target = folder ? zip.folder(folder) : zip;
    target.file(finalName, item.blob);
  }

  const blob = await zip.generateAsync({ type: "blob" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${address} - VOID RENAMED.zip`;
  a.click();
}
