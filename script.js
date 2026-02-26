/*****************************************************
 *  VOID PDF RENAMER – v3 FULLY AUTOMATIC ENGINE
 *  ==============================================
 *  Features:
 *   ✔ Text-based classification for PAGE PDFs (pdf.js)
 *   ✔ OCR-based classification for scanned Work Orders
 *   ✔ Auto-split Inspection/MYW/BMD/Recharge
 *   ✔ Handles hybrid packs (Recharge + BMD)
 *   ✔ Handles AC GOLD MTW with BMD tail
 *   ✔ Skip blank pages
 *   ✔ Create individual PDFs
 *   ✔ Auto naming + folder routing
 *   ✔ ZIP output
 *
 *  Dependencies (must load BEFORE this script):
 *   - pdf.js (module)
 *   - jszip.min.js
 *   - tesseract.min.js
 *   - pdf-lib.min.js  <-- local copy
 *****************************************************/


/********************************************************
 * 0) HELPER: CLEAN STRING
 ********************************************************/
function ucClean(str) {
  return (str || "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

function naturalSort(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

function uniquify(name, set) {
  if (!set.has(name)) { set.add(name); return name; }
  const i = name.lastIndexOf(".");
  const base = i >= 0 ? name.slice(0, i) : name;
  const ext  = i >= 0 ? name.slice(i) : "";
  let n = 2;
  while (set.has(`${base} (${n})${ext}`)) n++;
  const out = `${base} (${n})${ext}`;
  set.add(out);
  return out;
}


/********************************************************
 * 1) EXTRACT TOP TEXT USING PDF.JS (NO OCR FOR FIRST PDF)
 ********************************************************/
async function extractTopText(pdf, pageNumber, maxLines=5) {
  const page = await pdf.getPage(pageNumber);
  const textContent = await page.getTextContent();

  const lines = [];
  for (const item of textContent.items) {
    const txt = item.str.trim();
    if (!txt) continue;
    const y = item.transform[5];
    lines.push({ text: txt.toUpperCase(), y });
  }

  lines.sort((a,b)=> b.y - a.y); // highest y = top of page
  return lines.slice(0, maxLines).map(l=>l.text).join(" ");
}


/********************************************************
 * 2) RENDER + TEXT EXTRACTION FOR ALL PAGES
 ********************************************************/
async function extractAllPagesWithText(blob) {
  const buf = await blob.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;

  const out = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2 });

    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({
      canvasContext: canvas.getContext("2d"),
      viewport
    }).promise;

    const topText = ucClean(await extractTopText(pdf, pageNum));
    out.push({ canvas, topText, pageNum });
  }

  return out;
}


/********************************************************
 * 3) BLANK PAGE DETECTION
 ********************************************************/
function isBlankPage(canvas) {
  const ctx = canvas.getContext("2d");
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;

  let sum = 0, count = 0;
  for (let i = 0; i < img.length; i += 4) {
    const y = 0.299*img[i] + 0.587*img[i+1] + 0.114*img[i+2];
    sum += y; count++;
  }
  const avg = sum / count;
  return avg > 248; // nearly pure white
}


/********************************************************
 * 4) JOB TYPE DETECTION FOR FIRST PAGE
 ********************************************************/
function detectJobType(text) {
  if (text.includes("MULTI TRADE WORKS")) return "AC_GOLD_MTW";
  if (text.includes("INTERNAL VOID PACK FOR")) return "INTERNAL_BMD";
  return "UNKNOWN";
}

function isRechargeHeader(text) {
  return (
    text.includes("RECHARGE WORK") ||
    text.includes("RECHARGEABLE WORK")
  );
}

function isWorkHeader(text) {
  return /\b[A-Z]+\s+WORK(S)?\b/.test(text);
}

function isBmdHeader(text) {
  return text.includes("BMD WORKS REQUIRED");
}


/********************************************************
 * 5) CLASSIFY MULTI-PAGE PACK (FIRST PDF)
 ********************************************************/
async function processMultiPagePdf(blob) {
  const pages = await extractAllPagesWithText(blob);
  const out = [];

  // Page 1 ALWAYS Inspection Checklist
  out.push({ nameType: "CHECKLIST", pages: [pages[0].canvas] });

  const page1Type = detectJobType(pages[0].topText);

  /******** INTERNAL BMD PACK ********/
  if (page1Type === "INTERNAL_BMD") {
    const page2 = pages[1];
    let i = 1;

    // 1) Check Recharge on Page 2
    if (isRechargeHeader(page2.topText)) {
      const recharge = [];

      while (i < pages.length) {
        const p = pages[i];
        if (isBlankPage(p.canvas)) { i++; continue; }

        if (i !== 1 && isWorkHeader(p.topText)) break;
        recharge.push(p.canvas);
        i++;
      }

      if (recharge.length)
        out.push({ nameType: "RECHARGE", pages: recharge });

      // Remaining pages → BMD
      const bmd = [];
      while (i < pages.length) {
        const p = pages[i];
        if (!isBlankPage(p.canvas)) bmd.push(p.canvas);
        i++;
      }

      if (bmd.length)
        out.push({ nameType: "BMD", pages: bmd });

      return out;
    }

    // 2) No Recharge → All remaining pages = BMD
    const bmd = [];
    for (let j=1; j < pages.length; j++) {
      const p = pages[j];
      if (!isBlankPage(p.canvas)) bmd.push(p.canvas);
    }

    if (bmd.length)
      out.push({ nameType: "BMD", pages: bmd });

    return out;
  }

  /******** AC GOLD MTW ********/
  if (page1Type === "AC_GOLD_MTW") {
    const mtw = [];
    const bmd = [];
    let mode = "MTW";

    for (let i=1; i < pages.length; i++) {
      const p = pages[i];
      if (isBlankPage(p.canvas)) continue;

      const T = p.topText;

      if (mode === "MTW") {
        if (isBmdHeader(T)) {
          mode = "BMD";
          bmd.push(p.canvas);
        } else {
          mtw.push(p.canvas);
        }
      } else {
        bmd.push(p.canvas);
      }
    }

    if (mtw.length)
      out.push({ nameType: "MTW", pages: mtw });

    if (bmd.length)
      out.push({ nameType: "BMD", pages: bmd });

    return out;
  }

  /******** UNKNOWN TYPE → default to BMD ********/
  const bmd = [];
  for (let i=1; i < pages.length; i++) {
    if (!isBlankPage(pages[i].canvas))
      bmd.push(pages[i].canvas);
  }
  if (bmd.length)
    out.push({ nameType: "BMD", pages: bmd });

  return out;
}


/********************************************************
 * 6) EXPORT CANVAS-GROUPS → PDF BLOBS (PDF-LIB)
 ********************************************************/
async function exportCanvasGroupToPdf(pages) {
  const { PDFDocument } = PDFLib;

  const pdfDoc = await PDFDocument.create();

  for (const canvas of pages) {
    const data = canvas.toDataURL("image/jpeg", 0.92);
    const jpg = await pdfDoc.embedJpg(data);
    const page = pdfDoc.addPage([canvas.width, canvas.height]);
    page.drawImage(jpg, {x:0,y:0,width:canvas.width,height:canvas.height});
  }

  const bytes = await pdfDoc.save();
  return new Blob([bytes], { type:"application/pdf" });
}


/********************************************************
 * 7) NAMING FOR FIRST-PDF OUTPUTS
 ********************************************************/
function nameOutput(address, type, index=null) {
  switch(type) {
    case "CHECKLIST":
      return `${address} - VOID INSPECTION CHECKLIST.pdf`;
    case "MTW":
      return `${address} - VOID AC GOLD MTW (${index}).pdf`;
    case "BMD":
      return `${address} - VOID BMD WORKS (${index}).pdf`;
    case "RECHARGE":
      return `${address} - VOID_RECHARGEABLE_Works.pdf`;
  }
  return `${address} - VOID.pdf`;
}

function pickOutputFolder(name) {
  const N = name.toUpperCase();
  if (N.includes("INSPECTION CHECKLIST")) return "Inspection Checklist";
  if (N.includes("AC GOLD MTW")) return "MTW";
  if (N.includes("RECHARGEABLE_WORKS")) return "Rechargeable Repairs";
  if (N.includes("BMD WORKS")) return "NEC Lines";
  return "";
}

async function buildOutput(address, groups) {
  const out = [];
  let mtwC=1, bmdC=1;

  for (const g of groups) {
    let index=null;
    if (g.nameType==="MTW") index=mtwC++;
    if (g.nameType==="BMD") index=bmdC++;

    const name = nameOutput(address, g.nameType, index);
    const folder = pickOutputFolder(name);
    const blob = await exportCanvasGroupToPdf(g.pages);

    out.push({ folder, filename:name, blob });
  }

  return out;
}


/********************************************************
 * 8) WORK ORDER OCR (using your v2 logic)
 ********************************************************/
const CROP_L = 0.05, CROP_R = 0.95;
const CROP_T = 0.30, CROP_B = 0.43;
const C_T = 0.18, C_B = 0.255;

function cropRegion(canvas, L,R,T,B) {
  const W=canvas.width, H=canvas.height;
  const x0=Math.round(W*L), x1=Math.round(W*R);
  const y0=Math.round(H*T), y1=Math.round(H*B);
  const w=x1-x0, h=y1-y0;

  const out=document.createElement("canvas");
  out.width=w; out.height=h;
  out.getContext("2d").drawImage(canvas,x0,y0,w,h,0,0,w,h);
  return out;
}
function cropDesc(cv){ return cropRegion(cv,CROP_L,CROP_R,CROP_T,CROP_B); }
function cropContr(cv){ return cropRegion(cv,CROP_L,CROP_R,C_T,C_B); }

/* OCR Enhance */
function enh(cv){
  const w=cv.width,h=cv.height;
  const o=document.createElement("canvas");
  o.width=w;o.height=h;
  const c=o.getContext("2d");
  c.drawImage(cv,0,0);
  const img=c.getImageData(0,0,w,h);
  const d=img.data;
  const hist=new Array(256).fill(0);
  for(let i=0;i<d.length;i+=4){
    const y=(0.299*d[i]+0.587*d[i+1]+0.114*d[i+2])|0;
    hist[y]++; d[i]=d[i+1]=d[i+2]=y;
  }
  const total=w*h, clip=Math.max(1,Math.round(total*0.01));
  let lo=0, hi=255, acc=0;
  for(let v=0;v<256;v++){ acc+=hist[v]; if(acc>clip){lo=v;break;} }
  acc=0;
  for(let v=255;v>=0;v--){ acc+=hist[v]; if(acc>clip){hi=v;break;} }
  const range=Math.max(1,hi-lo);
  for(let i=0;i<d.length;i+=4){
    let y=d[i];
    y=((y-lo)*255/range)|0;
    if(y>170)y=Math.min(255,y+20);
    d[i]=d[i+1]=d[i+2]=y;
  }
  c.putImageData(img,0,0);
  return o;
}

async function ocrSingle(cv){
  const e=enh(cv);
  const r=await Tesseract.recognize(e,"eng",{
    tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode:7
  });
  let L=r.data.text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  if(L.length) return ucClean(L[0]);

  const r2=await Tesseract.recognize(e,"eng",{
    tessedit_char_whitelist:"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 /-&",
    tessedit_pageseg_mode:6
  });
  L=r2.data.text.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  return L.length?ucClean(L[0]):"";
}

function fuzzy(hay,needle,max=3){
  hay=ucClean(hay); needle=ucClean(needle);
  const h=hay.split(/\s+/), n=needle.split(/\s+/);
  const win=n.length, J=n.join(" ");
  for(let i=0;i<=h.length-win;i++){
    const w=h.slice(i,i+win).join(" ");
    if(lev(w,J)<=max) return true;
  }
  return false;
}

function lev(a,b){
  const m=a.length,n=b.length;
  const dp=Array.from({length:m+1},()=>new Array(n+1));
  for(let i=0;i<=m;i++)dp[i][0]=i;
  for(let j=0;j<=n;j++)dp[0][j]=j;
  for(let i=1;i<=m;i++){
    for(let j=1;j<=n;j++){
      const cost=a[i-1]===b[j-1]?0:1;
      dp[i][j]=Math.min(
        dp[i-1][j]+1,
        dp[i][j-1]+1,
        dp[i-1][j-1]+cost
      );
    }
  }
  return dp[m][n];
}

function mapWO(desc,contract){
  const h=ucClean(desc+" "+contract);
  if(fuzzy(h,"ASPECT CONTRACT",3))return"ASBESTOS REMOVAL";
  if(fuzzy(h,"LIFE ENVIRONMENTAL",3)||fuzzy(h,"LIFE ENVIROMENTAL",4))return"ASBESTOS SURVEY";
  if(fuzzy(h,"RODGERS ELECTRICAL",3))return"RODGERS ISOLATOR";
  if(fuzzy(h,"DEEP",1))return"PERFECT DEEP";
  if(fuzzy(h,"SPARKLE",2))return"PERFECT SPARKLE";
  return null;
}

function pickWOfolder(name){
  const N=name.toUpperCase();
  const hasAsb=N.includes("ASBESTOS");
  const hasContract=N.includes("LIFE")||N.includes("ASPECT");
  const hasRS=N.includes("REMOVAL")||N.includes("SURVEY");
  if(hasAsb||hasContract||(hasRS&&(hasAsb||hasContract)))
    return"Asbestos";

  if(N.includes("INSPECTION CHECKLIST"))return"Inspection Checklist";
  if(N.includes("CLEAN")||N.includes("PERFECT DEEP")||N.includes("PERFECT SPARKLE"))
    return"Cleans + Clearouts";
  if(N.includes("EICR"))return"Periodic - Rewires";
  if(N.includes("EPC"))return"EPC";
  if(N.includes("ROT WORKS"))return"Rot Works";
  if(N.includes("RECHARGE"))return"Rechargeable Repairs";
  if(N.includes("AC GOLD MTW"))return"MTW";
  if(N.includes("BMD WORKS"))return"NEC Lines";
  return"";
}

async function extractWO(blob){
  const buf=await blob.arrayBuffer();
  const pdf=await pdfjsLib.getDocument({data:buf}).promise;
  const page=await pdf.getPage(1);
  const vp=page.getViewport({scale:2});
  const cv=document.createElement("canvas");
  cv.width=vp.width; cv.height=vp.height;
  await page.render({canvasContext:cv.getContext("2d"),viewport:vp}).promise;

  const cC=cropContr(cv);
  const contr=await ocrSingle(cC);

  if(fuzzy(contr,"ASPECT CONTRACT",3))
    return{contr,desc:"ASBESTOS REMOVAL"};
  if(fuzzy(contr,"LIFE ENVIRONMENTAL",3)||fuzzy(contr,"LIFE ENVIROMENTAL",4))
    return{contr,desc:"ASBESTOS SURVEY"};
  if(fuzzy(contr,"RODGERS ELECTRICAL",3))
    return{contr,desc:"RODGERS ISOLATOR"};

  const dC=cropDesc(cv);
  const desc=await ocrSingle(dC);

  return{contr,desc};
}

async function autoNameWO(address, blob){
  const {contr,desc}=await extractWO(blob);
  const mapped=mapWO(desc,contr);
  const final=ucClean(mapped||desc||"WORK ORDER");
  const name=`${address} - VOID ${final} WORK ORDER REQUEST.pdf`;
  const folder=pickWOfolder(name);
  return{folder, filename:name, blob};
}


/********************************************************
 * 9) ZIP BUILDER
 ********************************************************/
async function buildZip(outFiles, address) {
  const zip = new JSZip();
  const seen = new Map();

  function setFor(folder){
    if(!seen.has(folder)) seen.set(folder,new Set());
    return seen.get(folder);
  }

  for(const f of outFiles){
    const folder=f.folder||"";
    const s=setFor(folder);
    const unique=uniquify(f.filename,s);

    const tgt = folder ? zip.folder(folder) : zip;
    tgt.file(unique, f.blob);
  }

  const blob=await zip.generateAsync({type:"blob"});
  const a=document.createElement("a");
  a.href=URL.createObjectURL(blob);
  a.download=`${address} - VOID RENAMED.zip`;
  a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),2000);
}


/********************************************************
 * 10) INPUT HANDLING + MAIN PIPELINE
 ********************************************************/
async function explodeZip(file){
  const zip=await JSZip.loadAsync(file);
  const PDFs=[];
  const items=Object.values(zip.files)
    .filter(f=>!f.dir && f.name.toLowerCase().endsWith(".pdf"))
    .sort((a,b)=>naturalSort(a.name,b.name));

  for(const e of items){
    const blob = await zip.file(e.name).async("blob");
    PDFs.push({name:e.name, blob});
  }
  return PDFs;
}

async function normalizeInput(files){
  if(files.length===1 && files[0].name.toLowerCase().endsWith(".zip"))
    return explodeZip(files[0]);

  if(files.every(f=>f.name.toLowerCase().endsWith(".pdf")))
    return files.map(f=>({name:f.name,blob:f})).sort((a,b)=>naturalSort(a.name,b.name));

  throw new Error("Drop ZIP or PDFs only.");
}

async function processAll(addressRaw, droppedFiles){
  const address=ucClean(addressRaw);
  if(!address){
    alert("Please enter the ADDRESS first.");
    return;
  }

  const pdfs = await normalizeInput(droppedFiles);
  if(!pdfs.length){
    alert("No PDFs found.");
    return;
  }

  // First PDF = multi-page pack
  const first = pdfs[0];
  const workOrders = pdfs.slice(1);

  // 1) classify + split first PDF
  const groups = await processMultiPagePdf(first.blob);

  // 2) export groups
  const packOut = await buildOutput(address, groups);

  // 3) process work orders
  const woOut = [];
  for(const wo of workOrders){
    woOut.push(await autoNameWO(address, wo.blob));
  }

  // 4) ZIP everything
  await buildZip([...packOut, ...woOut], address);
}


/********************************************************
 * 11) DRAG & DROP WIRING (for your HTML)
 ********************************************************/
const dropzone=document.getElementById("dropzone");
const addressInput=document.getElementById("address");

dropzone.addEventListener("dragover", e=>{
  e.preventDefault();
  dropzone.style.opacity=0.7;
});
dropzone.addEventListener("dragleave", ()=>{
  dropzone.style.opacity=1;
});
dropzone.addEventListener("drop", async e=>{
  e.preventDefault();
  dropzone.style.opacity=1;

  const files=[...e.dataTransfer.files];
  try {
    await processAll(addressInput.value, files);
  } catch(err){
    console.error(err);
    alert(err.message||"Processing failed.");
  }
});
