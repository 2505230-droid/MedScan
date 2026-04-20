/**
 * MediScan — app.js
 * BUILD: 2026-04-20-v3
 * Architecture:
 *   1. Google ML Kit  (camera capture via WebRTC)
 *   2. OCR.space API  (text extraction)
 *   3. Google Gemini 2.5 Flash  (primary medical analyzer)
 *      └─ Hugging Face BART  (automatic fallback if Gemini fails)
 */

"use strict";

/* ════════════════════════════════════════════════════════════════
   CONFIG  —  keys are loaded from config.js (not committed to git)
   ════════════════════════════════════════════════════════════════ */
const CONFIG = window.CONFIG || {};

/* ════════════════════════════════════════════════════════════════
   STATE
   ════════════════════════════════════════════════════════════════ */
const state = {
  stream               : null,
  capturedImageBase64  : null,
  uploadedImageBase64  : null,
  activeTab            : "camera",
};

/* ════════════════════════════════════════════════════════════════
   TAB SWITCHER
   ════════════════════════════════════════════════════════════════ */
function switchTab(tab) {
  state.activeTab = tab;
  const cameraPane = document.getElementById("cameraPane");
  const uploadPane = document.getElementById("uploadPane");
  const tabCamera  = document.getElementById("tabCamera");
  const tabUpload  = document.getElementById("tabUpload");
  const modeLabel  = document.getElementById("modeLabel");

  if (tab === "camera") {
    cameraPane.style.display = "flex";
    uploadPane.style.display = "none";
    tabCamera.classList.add("tab--active");
    tabUpload.classList.remove("tab--active");
    modeLabel.textContent = "Camera Mode";
  } else {
    cameraPane.style.display = "none";
    uploadPane.style.display = "flex";
    tabCamera.classList.remove("tab--active");
    tabUpload.classList.add("tab--active");
    modeLabel.textContent = "Upload Mode";
    if (state.stream) stopCamera();
  }
}

/* ════════════════════════════════════════════════════════════════
   CAMERA
   ════════════════════════════════════════════════════════════════ */
async function startCamera() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 960 } },
    });
    const video = document.getElementById("videoFeed");
    video.srcObject = state.stream;
    video.style.display = "block";
    document.getElementById("cameraPlaceholder").style.display = "none";
    document.getElementById("scanLine").style.display          = "block";
    document.getElementById("startCameraBtn").style.display    = "none";
    document.getElementById("captureBtn").style.display        = "inline-flex";
    document.getElementById("stopCameraBtn").style.display     = "inline-flex";
  } catch (err) {
    showError("Camera Access Denied", "Please allow camera access in your browser settings, or switch to Upload mode.");
  }
}

function stopCamera() {
  if (state.stream) { state.stream.getTracks().forEach(t => t.stop()); state.stream = null; }
  const video = document.getElementById("videoFeed");
  video.srcObject = null;
  video.style.display = "none";
  document.getElementById("scanLine").style.display          = "none";
  document.getElementById("cameraPlaceholder").style.display = "flex";
  document.getElementById("startCameraBtn").style.display    = "inline-flex";
  document.getElementById("captureBtn").style.display        = "none";
  document.getElementById("stopCameraBtn").style.display     = "none";
}

function captureFrame() {
  const video  = document.getElementById("videoFeed");
  const canvas = document.getElementById("captureCanvas");
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  ctx.filter = "contrast(1.08) saturate(0.95)";
  ctx.drawImage(canvas, 0, 0);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  state.capturedImageBase64 = dataUrl.split(",")[1];
  document.getElementById("capturedPreview").src = dataUrl;
  document.getElementById("capturedPreviewWrap").style.display = "flex";
  stopCamera();
}

/* ════════════════════════════════════════════════════════════════
   FILE UPLOAD
   ════════════════════════════════════════════════════════════════ */
function handleFileUpload(event) {
  const file = event.target.files[0];
  if (file) readFileAsBase64(file);
}

function readFileAsBase64(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const dataUrl = e.target.result;
    state.uploadedImageBase64 = dataUrl.split(",")[1];
    const preview = document.getElementById("uploadPreview");
    preview.src = dataUrl;
    preview.style.display = "block";
    document.getElementById("uploadZone").querySelector(".upload-zone__inner").style.display = "none";
  };
  reader.readAsDataURL(file);
}

(function setupDragDrop() {
  const zone = document.getElementById("uploadZone");
  if (!zone) return;
  zone.addEventListener("dragover",  (e) => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", ()  => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) readFileAsBase64(file);
  });
})();

/* ════════════════════════════════════════════════════════════════
   UTILITY
   ════════════════════════════════════════════════════════════════ */
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function setStepLabel(text) {
  const el = document.querySelector("#lstep2 span");
  if (el) el.textContent = text;
}

/* ════════════════════════════════════════════════════════════════
   MAIN PIPELINE
   ════════════════════════════════════════════════════════════════ */
async function analyzeLabel() {
  const imageBase64 = state.activeTab === "camera"
    ? state.capturedImageBase64
    : state.uploadedImageBase64;

  if (!imageBase64) {
    showError(
      "No Image Captured",
      state.activeTab === "camera"
        ? "Please start the camera and capture a frame first."
        : "Please upload an image of a medicine label."
    );
    return;
  }

  showLoading();

  try {
    /* ── STEP 1: OCR ─────────────────────────────────────────── */
    setLoadingStep(1);
    const ocrText = await runOCRSpace(imageBase64, CONFIG.OCR_KEY);

    if (!ocrText || ocrText.trim().length < 10) {
      throw new Error("Could not extract text from the image. Please ensure the label is clear and well-lit.");
    }

    const cleanedText = fixOcrTypos(ocrText);

    /* ── STEP 2: ANALYZE (Gemini → HF fallback) ──────────────── */
    setLoadingStep(2);
    let result;

    try {
      setStepLabel("Analyzing with Gemini…");
      result = await runGemini(cleanedText, CONFIG.GEMINI_KEY);
      console.log("✅ Engine: Gemini");
    } catch (geminiErr) {
      console.warn("⚠️ Gemini failed:", geminiErr.message, "→ trying Hugging Face backup");
      setStepLabel("Gemini unavailable — switching to Hugging Face…");

      try {
        result = await runHuggingFace(cleanedText, CONFIG.HF_KEY);
        console.log("✅ Engine: Hugging Face (backup)");
      } catch (hfErr) {
        console.error("❌ HF also failed:", hfErr.message);
        throw new Error(
          "Both analyzers failed.\n" +
          "Gemini: " + geminiErr.message + "\n" +
          "Hugging Face: " + hfErr.message
        );
      }
    }

    /* ── STEP 3: RENDER ──────────────────────────────────────── */
    setLoadingStep(3);
    await sleep(500);
    renderResults(ocrText, result);

  } catch (err) {
    console.error("MediScan pipeline error:", err);
    showError("Analysis Failed", err.message || "An unexpected error occurred. Please try again.");
  }
}

/* ════════════════════════════════════════════════════════════════
   OCR.SPACE
   ════════════════════════════════════════════════════════════════ */
async function runOCRSpace(base64Image, apiKey) {
  const formData = new FormData();
  formData.append("base64Image",       "data:image/jpeg;base64," + base64Image);
  formData.append("apikey",            apiKey);
  formData.append("language",          "eng");
  formData.append("isOverlayRequired", "false");
  formData.append("detectOrientation", "true");
  formData.append("scale",             "true");
  formData.append("isTable",           "false");
  formData.append("OCREngine",         "2");

  const res = await fetch("https://api.ocr.space/parse/image", { method: "POST", body: formData });
  if (!res.ok) throw new Error("OCR.space error: " + res.status);

  const data = await res.json();
  if (data.IsErroredOnProcessing) {
    throw new Error("OCR.space: " + (data.ErrorMessage?.[0] || "OCR failed."));
  }

  return (data.ParsedResults || []).map(r => r.ParsedText || "").join("\n").trim();
}

/* ════════════════════════════════════════════════════════════════
   GOOGLE GEMINI 2.5 FLASH  — Primary analyzer
   ════════════════════════════════════════════════════════════════ */
async function runGemini(ocrText, apiKey) {
  const endpoint =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + apiKey;

  const prompt =
    "You are a medical assistant. Read this medicine label text and return ONLY a valid JSON object " +
    "(absolutely no markdown, no code fences, no text before or after the JSON):\n" +
    '{\n' +
    '  "medicine_name": "Brand name preferred over generic (e.g. Linvas not Saroglitazar)",\n' +
    '  "dosage": "Simple plain-English dosage instructions",\n' +
    '  "side_effects": ["effect 1", "effect 2"],\n' +
    '  "warnings": "Simple plain-English warnings",\n' +
    '  "storage": "Simple storage instructions",\n' +
    '  "plain_summary": "2-3 sentences a child can understand"\n' +
    '}\n' +
    "Use null for any field not found. Never invent data. Prefer brand name for medicine_name.\n\n" +
    "Label text:\n" + ocrText.slice(0, 1500);

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
  };

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    if (res.status === 429) {
      if (attempt === 1) {
        setStepLabel("Gemini rate limited — retrying once…");
        await sleep(2000);
        continue;
      }
      throw new Error("Gemini quota exceeded.");
    }

    if (res.status === 403) throw new Error("Invalid Gemini API key.");

    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e?.error?.message || "Gemini API error " + res.status);
    }

    const data     = await res.json();
    const rawText  = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonText = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      const m = jsonText.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch { throw new Error("Gemini response was not valid JSON."); }
      } else {
        throw new Error("Gemini response was not valid JSON.");
      }
    }

    if (parsed.side_effects && !Array.isArray(parsed.side_effects)) {
      parsed.side_effects = String(parsed.side_effects).split(/[,;]/).map(s => s.trim()).filter(Boolean);
    }
    if (!parsed.medicine_name || String(parsed.medicine_name).toLowerCase() === "null") {
      parsed.medicine_name = extractMedicineName(ocrText);
    }

    return parsed;
  }

  throw new Error("Gemini did not respond.");
}

/* ════════════════════════════════════════════════════════════════
   HUGGING FACE BACKUP — facebook/bart-large-mnli zero-shot
   ════════════════════════════════════════════════════════════════ */
const HF_BASE   = "https://api-inference.huggingface.co/models";
const HF_MODEL  = "facebook/bart-large-mnli";
const HF_LABELS = [
  "dosage instructions",
  "side effects",
  "warnings and precautions",
  "storage instructions",
];

async function hfCall(payload, hfKey) {
  const url = HF_BASE + "/" + HF_MODEL;

  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url, {
      method:  "POST",
      headers: {
        "Authorization": "Bearer " + hfKey,
        "Content-Type":  "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 503) {
      const body   = await res.json().catch(() => ({}));
      const waitMs = Math.min((body.estimated_time || 20) * 1000, 30000);
      if (attempt < 5) { await sleep(waitMs); continue; }
      throw new Error("HF model is taking too long to load.");
    }

    if (res.status === 401 || res.status === 403) throw new Error("Invalid Hugging Face token.");

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error || "HF API error " + res.status);
    }

    return await res.json();
  }
}

async function runHuggingFace(ocrText, hfKey) {
  const sentences = ocrText
    .split(/\n+/)
    .map(s => s.trim())
    .filter(s => s.length > 8)
    .slice(0, 14);

  const results = await Promise.all(
    sentences.map(sent =>
      hfCall({
        inputs:     sent,
        parameters: { candidate_labels: HF_LABELS, multi_label: false },
      }, hfKey).catch(() => null)
    )
  );

  const buckets = { dosage: [], side_effects: [], warnings: [], storage: [] };

  results.forEach((res, i) => {
    if (!res || !res.labels || res.scores[0] < 0.45) return;
    const top  = res.labels[0];
    const sent = sentences[i];
    if (top === "dosage instructions")      buckets.dosage.push(sent);
    if (top === "side effects")             buckets.side_effects.push(sent);
    if (top === "warnings and precautions") buckets.warnings.push(sent);
    if (top === "storage instructions")     buckets.storage.push(sent);
  });

  const medicineName = extractMedicineName(ocrText);
  const dosage       = buckets.dosage.length       ? toReadable(buckets.dosage.slice(0, 3).join(". "))    : extractDosage(ocrText);
  const sideEffects  = buckets.side_effects.length  ? buckets.side_effects.slice(0, 8).map(toSimple)       : extractSideEffects(ocrText);
  const warnings     = buckets.warnings.length     ? toReadable(buckets.warnings.slice(0, 3).join(". "))  : extractWarnings(ocrText);
  const storage      = buckets.storage.length      ? toReadable(buckets.storage.slice(0, 2).join(". "))   : extractStorage(ocrText);

  return {
    medicine_name: medicineName,
    dosage,
    side_effects:  sideEffects,
    warnings,
    storage,
    plain_summary: buildSummary(medicineName, dosage, sideEffects, warnings),
  };
}

/* ════════════════════════════════════════════════════════════════
   TEXT HELPERS
   ════════════════════════════════════════════════════════════════ */
function fixOcrTypos(text) {
  return text
    .replace(/\bdiy\b/gi,          "dry")
    .replace(/\bIight\b/gi,        "light")
    .replace(/\bmoisure\b/gi,      "moisture")
    .replace(/\btemperture\b/gi,   "temperature")
    .replace(/\bprolect\b/gi,      "protect")
    .replace(/\bphsyician\b/gi,    "physician")
    .replace(/\bprescribtion\b/gi, "prescription");
}

function toSimple(text) {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase().replace(/[.;:,]+$/, "").trim();
}

function toTitleCase(text) {
  return text.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function toReadable(text) {
  return text.replace(/\s{2,}/g, " ").replace(/([^.])\s*$/, "$1.").trim();
}

function buildSummary(name, dosage, sideEffects, warnings) {
  const parts = [];
  if (name && name !== "Unknown Medicine") {
    parts.push(name + " is a medicine you should take as directed on the label.");
  } else {
    parts.push("This medicine should be taken exactly as directed on the label.");
  }
  if (dosage)              parts.push("Remember: " + dosage.split(".")[0] + ".");
  if (sideEffects?.length) parts.push("It may cause " + sideEffects.slice(0, 3).join(", ") + ". Talk to your doctor if anything feels wrong.");
  if (warnings)            parts.push("Always read the warnings and ask your pharmacist if unsure.");
  return parts.join(" ");
}

/* ════════════════════════════════════════════════════════════════
   MEDICINE NAME EXTRACTOR
   ════════════════════════════════════════════════════════════════ */
function extractMedicineName(text) {
  const REJECT = /dosing|interval|dose|dosage|minimum|maximum|excipient|q\.s|composition|each\s+tablet|each\s+uncoated|contains?|manufactured|store|storage|warning|caution|keep\s+out|keep\s+away|should\s+not|not\s+be|do\s+not|analgesic|antipyretic|hours|daily|times|mfg|batch|exp\b|lic\b|reg\b|plot|floor|india|chennai|mumbai|delhi|sikkim|tamil|gujarat|maharashtra|limited|private|laboratory|laboratories|sciences|lupin|zydus|cipla|sun\s+pharma|marketed|manufactured/i;

  function ok(s) {
    if (!s || s.length < 2 || s.length > 45) return false;
    if (/^\d/.test(s) || /:/.test(s))        return false;
    if (REJECT.test(s))                       return false;
    return true;
  }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // Pass 0a — brand with ®/™
  for (const line of lines) {
    const m = line.match(/([A-Za-z][A-Za-z\-]{1,20})\s*[®™°]/);
    if (m && ok(m[1])) return toTitleCase(m[1].trim());
  }

  // Pass 0b — "Brand 10 Tablets"
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z\-]{1,20})\s+\d{1,3}\s+tablets?/i);
    if (m && ok(m[1])) return toTitleCase(m[1].trim());
  }

  // Pass 1 — "Generic Tablets IP"
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z\s\-]{1,35}?)\s+(?:tablets?|capsules?|syrup|injection|suspension|drops?|cream|gel|ointment|solution)\b/i);
    if (!m) continue;
    const c = m[1].trim();
    if (ok(c) && !/dosage|dose|interval|minimum|maximum|adult|child/i.test(c)) return toTitleCase(c);
  }

  // Pass 2 — "P-650"
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z\-]{1,15})\s*[-]?\s*(\d{2,4})(?:\s*(?:mg|ml|mcg|g))?\s*$/i);
    if (m && ok(m[1])) return toTitleCase(m[1] + " " + m[2]);
  }

  // Pass 3 — short clean Title Case
  for (const line of lines) {
    if (line.length < 3 || line.length > 40)  continue;
    if (!/^[A-Z]/.test(line))                  continue;
    if (/[:\d]/.test(line.slice(-1)))           continue;
    if (!ok(line))                              continue;
    if (/\b(interval|dosing|minimum|maximum|every|hours?|times?|daily|each|uncoated|tablets?|capsules?)\b/i.test(line)) continue;
    return toTitleCase(line);
  }

  return "Unknown Medicine";
}

/* ════════════════════════════════════════════════════════════════
   REGEX FIELD EXTRACTORS
   ════════════════════════════════════════════════════════════════ */
function extractDosage(text) {
  const found = [];
  const patterns = [
    /take\s+[\w\s,]+(?:tablet|capsule|pill|drop|ml|mg|teaspoon|spoon)[^\.\n]*/gi,
    /(?:dose|dosage)[:\s]+[^\.\n]{5,120}/gi,
    /(?:adults?|children?)[:\s]+[^\.\n]{5,120}/gi,
    /\d+\s*(?:tablet|capsule|pill|drop|ml)\s+[\w\s]+(?:daily|day|hour|week|meal|food)[^\.\n]*/gi,
  ];
  for (const p of patterns) found.push(...(text.match(p) || []).map(s => s.trim()));
  if (!found.length) {
    for (const kw of ["dose", "dosage", "directions", "administration"]) {
      const m = text.match(new RegExp(kw + "[:\\s]+([^\\n]{10,200})", "i"));
      if (m) return toReadable(m[1].trim());
    }
    return null;
  }
  return toReadable([...new Set(found)].slice(0, 3).join(". "));
}

function extractWarnings(text) {
  const found = [];
  const patterns = [
    /(?:warning|caution|do not|avoid|contraindic|not recommended|keep out|keep away)[^\.\n]{5,200}/gi,
    /(?:allerg|consult\s+(?:a\s+)?(?:doctor|physician|pharmacist))[^\.\n]{5,150}/gi,
    /(?:stop\s+(?:using|taking)|discontinue)[^\.\n]{5,150}/gi,
  ];
  for (const p of patterns) found.push(...(text.match(p) || []).map(s => s.trim()));
  if (!found.length) {
    for (const kw of ["warning", "caution", "contraindication"]) {
      const m = text.match(new RegExp(kw + "[:\\s]+([^\\n]{10,200})", "i"));
      if (m) return toReadable(m[1].trim());
    }
    return null;
  }
  return toReadable([...new Set(found)].slice(0, 3).join(". "));
}

function extractStorage(text) {
  const found = [];
  const patterns = [
    /store(?:d)?\s+[^\.\n]{5,120}/gi,
    /keep\s+(?:in|at|below|between|away)[^\.\n]{5,120}/gi,
    /(?:temperature|cool|dry|refrigerat|light|moisture)[^\.\n]{5,100}/gi,
  ];
  for (const p of patterns) found.push(...(text.match(p) || []).map(s => s.trim()));
  if (!found.length) {
    for (const kw of ["store", "storage", "keep"]) {
      const m = text.match(new RegExp(kw + "[:\\s]+([^\\n]{10,200})", "i"));
      if (m) return toReadable(m[1].trim());
    }
    return null;
  }
  return toReadable([...new Set(found)].slice(0, 2).join(". "));
}

function extractSideEffects(text) {
  const sec = text.match(/(?:side\s*effects?|adverse\s*(?:effects?|reactions?))[:\s]+([^\n]{10,400})/i);
  if (sec) {
    return sec[1].split(/[,;\/]/).map(s => toSimple(s.trim())).filter(s => s.length > 2).slice(0, 8);
  }
  const words = [
    "nausea","vomiting","dizziness","headache","drowsiness","rash","itching",
    "dry mouth","constipation","diarrhea","stomach pain","fatigue","insomnia",
    "blurred vision","sweating","palpitations","swelling","fever","allergic reaction",
  ];
  return words.filter(w => new RegExp(w, "i").test(text));
}

/* ════════════════════════════════════════════════════════════════
   UI — LOADING
   ════════════════════════════════════════════════════════════════ */
function showLoading() {
  document.getElementById("resultsIdle").style.display    = "none";
  document.getElementById("resultsError").style.display   = "none";
  document.getElementById("resultCards").style.display    = "none";
  document.getElementById("resultsLoading").style.display = "flex";
  ["lstep1","lstep2","lstep3"].forEach(id => {
    document.getElementById(id).classList.remove("active", "done");
  });
  document.getElementById("progressFill").style.width = "0%";
  setStepLabel("Analyzing with Gemini / HF backup…");
}

function setLoadingStep(step) {
  const ids      = ["lstep1","lstep2","lstep3"];
  const progress = [30, 65, 90];
  ids.forEach((id, i) => {
    const el = document.getElementById(id);
    el.classList.remove("active", "done");
    if (i + 1 <  step) el.classList.add("done");
    if (i + 1 === step) el.classList.add("active");
  });
  document.getElementById("progressFill").style.width = progress[step - 1] + "%";
}

/* ════════════════════════════════════════════════════════════════
   UI — ERROR
   ════════════════════════════════════════════════════════════════ */
function showError(title, msg) {
  document.getElementById("resultsIdle").style.display    = "none";
  document.getElementById("resultsLoading").style.display = "none";
  document.getElementById("resultCards").style.display    = "none";
  document.getElementById("resultsError").style.display   = "flex";
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMsg").textContent   = msg;
}

/* ════════════════════════════════════════════════════════════════
   UI — RENDER RESULTS
   ════════════════════════════════════════════════════════════════ */
function renderResults(ocrText, analysis) {
  document.getElementById("resultsLoading").style.display = "none";
  document.getElementById("resultsIdle").style.display    = "none";
  document.getElementById("resultsError").style.display   = "none";
  document.getElementById("resultCards").style.display    = "flex";
  document.getElementById("resultBadge").style.display    = "inline-block";
  document.getElementById("progressFill").style.width     = "100%";

  document.getElementById("rawOcrText").textContent = ocrText;

  function showCard(cardId, fieldId, value, delay) {
    if (!value) return;
    const card  = document.getElementById(cardId);
    const field = document.getElementById(fieldId);
    card.style.display        = "block";
    card.style.animationDelay = (delay * 80) + "ms";
    field.textContent         = value;
  }

  if (analysis.medicine_name) {
    const card = document.getElementById("cardName");
    card.style.display        = "flex";
    card.style.animationDelay = "0ms";
    document.getElementById("medicineName").textContent = analysis.medicine_name;
  }

  showCard("cardDosage",   "dosageText",   analysis.dosage,        1);
  showCard("cardWarnings", "warningsText", analysis.warnings,      3);
  showCard("cardStorage",  "storageText",  analysis.storage,       4);
  showCard("cardSummary",  "summaryText",  analysis.plain_summary, 5);

  if (analysis.side_effects && analysis.side_effects.length) {
    const list = document.getElementById("sideEffectsList");
    list.innerHTML = "";
    analysis.side_effects.forEach(effect => {
      const li = document.createElement("li");
      li.textContent = effect;
      list.appendChild(li);
    });
    const card = document.getElementById("cardSideEffects");
    card.style.display        = "block";
    card.style.animationDelay = "160ms";
  }
}

/* ════════════════════════════════════════════════════════════════
   UI — RESET
   ════════════════════════════════════════════════════════════════ */
function resetResults() {
  document.getElementById("resultsIdle").style.display    = "flex";
  document.getElementById("resultsLoading").style.display = "none";
  document.getElementById("resultsError").style.display   = "none";
  document.getElementById("resultCards").style.display    = "none";
  document.getElementById("resultBadge").style.display    = "none";
  ["cardName","cardDosage","cardSideEffects","cardWarnings","cardStorage","cardSummary"]
    .forEach(id => { document.getElementById(id).style.display = "none"; });
  document.getElementById("progressFill").style.width = "0%";
}

function resetCapture() {
  state.capturedImageBase64 = null;
  document.getElementById("capturedPreviewWrap").style.display = "none";
  document.getElementById("capturedPreview").src = "";
  startCamera();
}

/* ════════════════════════════════════════════════════════════════
   DOM READY — ANIMATIONS
   ════════════════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener("click", function(e) {
      const target = document.querySelector(this.getAttribute("href"));
      if (target) { e.preventDefault(); target.scrollIntoView({ behavior: "smooth", block: "start" }); }
    });
  });

  document.querySelectorAll(".hero__eyebrow, .hero__title, .hero__subtitle, .hero__cta, .hero__stats")
    .forEach((el, i) => {
      el.style.opacity   = "0";
      el.style.transform = "translateY(20px)";
      el.style.transition = "opacity 0.6s ease " + (i * 100) + "ms, transform 0.6s ease " + (i * 100) + "ms";
      requestAnimationFrame(() => setTimeout(() => {
        el.style.opacity = "1"; el.style.transform = "translateY(0)";
      }, 50 + i * 100));
    });

  const observer = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.style.opacity   = "1";
        entry.target.style.transform = "translateY(0)";
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.2 });

  document.querySelectorAll(".step").forEach((step, i) => {
    step.style.opacity    = "0";
    step.style.transform  = "translateY(24px)";
    step.style.transition = "opacity 0.5s ease " + (i * 120) + "ms, transform 0.5s ease " + (i * 120) + "ms";
    observer.observe(step);
  });
});