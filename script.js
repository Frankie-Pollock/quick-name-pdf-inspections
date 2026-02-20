// Utility: Remove punctuation
function cleanText(text) {
    return text.replace(/[^\w\s]/gi, "").replace(/\s+/g, " ").trim();
}

// Utility: Extract full PDF text
async function extractPDFText(file) {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let text = "";

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(item => item.str).join(" ") + " ";
    }
    return text.toUpperCase();
}

// ZIP handling
document.getElementById("dropzone").addEventListener("dragover", e => {
    e.preventDefault();
});

document.getElementById("dropzone").addEventListener("drop", async e => {
    e.preventDefault();

    const address = document.getElementById("address").value.trim().toUpperCase();
    if (!address) {
        alert("Please enter the address first.");
        return;
    }

    const zipFile = e.dataTransfer.files[0];
    const zip = await JSZip.loadAsync(zipFile);
    const newZip = new JSZip();

    let mtwCount = 0;
    let bmdCount = 0;

    const files = Object.keys(zip.files);

    for (let i = 0; i < files.length; i++) {
        const filename = files[i];
        const fileData = await zip.files[filename].async("blob");

        const text = await extractPDFText(fileData);

        let newName = "";

        // 1. First PDF = Inspection Checklist
        if (i === 0) {
            newName = `${address} - VOID INSPECTION CHECKLIST.pdf`;
        }
        // 2. MTW / AC GOLD
        else if (text.includes("AC GOLD") || text.includes("MULTI-TRADE WORKS")) {
            mtwCount++;
            newName = `${address} - VOID AC GOLD MTW (${mtwCount}).pdf`;
        }
        // 3. Rechargeable Works
        else if (text.includes("RECHARGE")) {
            newName = `${address} - VOID RECHARGEABLE WORKS.pdf`;
        }
        // 4. BMD Works
        else if (text.includes("BMD")) {
            bmdCount++;
            newName = `${address} - VOID BMD WORKS (${bmdCount}).pdf`;
        }
        // 5. Work Order – description required
        else if (text.includes("WORK ORDER") || text.includes("DESCRIPTION OF WORKS REQUIRED")) {
            let match = text.match(/DESCRIPTION OF WORKS REQUIRED(.*?)(?:CONTRACTOR|REQUEST|£|$)/);
            let description = match ? cleanText(match[1]).toUpperCase() : "WORK ORDER";

            newName = `${address} - VOID ${description} REQUEST.pdf`;
        }
        // Fallback
        else {
            newName = `${address} - VOID UNKNOWN.pdf`;
        }

        newZip.file(newName, fileData);
    }

    const output = await newZip.generateAsync({ type: "blob" });

    // Trigger download
    const a = document.createElement("a");
    a.href = URL.createObjectURL(output);
    a.download = `${address} - VOID RENAMED.zip`;
    a.click();

    alert("DONE! Your renamed ZIP has downloaded.");
});
``
