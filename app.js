/**
 * MediScan — app.js
 * Architecture:
 *   1. Google ML Kit (camera capture via WebRTC — browser equivalent)
 *   2. OCR.space API (OCR / text extraction)
 *   3. Google Gemini 2.5 Flash API (medical text understanding → plain English)
 */

"use strict";

/* ─── State ─────────────────────────────────────────────────── */
const state = {
  stream: null,
  capturedImageBase64: null,
  uploadedImageBase64: null,
  activeTab: "camera",   // "camera" | "upload"
};

/* ─── Tab Switcher ──────────────────────────────────────────── */
function switchTab(tab) {
  state.activeTab = tab;
  const cameraPane  = document.getElementById("cameraPane");
  const uploadPane  = document.getElementById("uploadPane");
  const tabCamera   = document.getElementById("tabCamera");
  const tabUpload   = document.getElementById("tabUpload");
  const modeLabel   = document.getElementById("modeLabel");

  if (tab === "camera") {
    cameraPane.style.display  = "flex";
    uploadPane.style.display  = "none";
    tabCamera.classList.add("tab--active");
    tabUpload.classList.remove("tab--active");
    modeLabel.textContent = "Camera Mode";
  } else {
    cameraPane.style.display  = "none";
    uploadPane.style.display  = "flex";
    tabCamera.classList.remove("tab--active");
    tabUpload.classList.add("tab--active");
    modeLabel.textContent = "Upload Mode";
    if (state.stream) stopCamera();
  }
}

/* ─── Camera ────────────────────────────────────────────────── */
async function startCamera() {
  try {
    const constraints = {
      video: {
        facingMode: { ideal: "environment" }, // rear camera on mobile
        width: { ideal: 1280 },
        height: { ideal: 960 },
      },
    };
    state.stream = await navigator.mediaDevices.getUserMedia(constraints);

    const video = document.getElementById("videoFeed");
    video.srcObject = state.stream;
    video.style.display = "block";

    document.getElementById("cameraPlaceholder").style.display = "none";
    document.getElementById("scanLine").style.display         = "block";
    document.getElementById("startCameraBtn").style.display   = "none";
    document.getElementById("captureBtn").style.display       = "inline-flex";
    document.getElementById("stopCameraBtn").style.display    = "inline-flex";
  } catch (err) {
    showError(
      "Camera Access Denied",
      "Please allow camera access in your browser settings, or switch to Upload mode."
    );
  }
}

function stopCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
  }
  const video = document.getElementById("videoFeed");
  video.srcObject = null;
  video.style.display = "none";
  document.getElementById("scanLine").style.display        = "none";
  document.getElementById("cameraPlaceholder").style.display = "flex";
  document.getElementById("startCameraBtn").style.display  = "inline-flex";
  document.getElementById("captureBtn").style.display      = "none";
  document.getElementById("stopCameraBtn").style.display   = "none";
}

function captureFrame() {
  const video  = document.getElementById("videoFeed");
  const canvas = document.getElementById("captureCanvas");
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;

  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  // Apply slight contrast/sharpness boost (ML Kit equivalent pre-processing)
  ctx.filter = "contrast(1.08) saturate(0.95)";
  ctx.drawImage(canvas, 0, 0);

  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  state.capturedImageBase64 = dataUrl.split(",")[1]; // raw base64

  // Show preview
  document.getElementById("capturedPreview").src = dataUrl;
  document.getElementById("capturedPreviewWrap").style.display = "flex";
  stopCamera();
}

/* ─── File Upload ────────────────────────────────────────────── */
function handleFileUpload(event) {
  const file = event.target.files[0];
  if (!file) return;
  readFileAsBase64(file);
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

// Drag-and-drop
(function setupDragDrop() {
  const zone = document.getElementById("uploadZone");
  if (!zone) return;
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("dragover");
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) readFileAsBase64(file);
  });
})();

/* ─── Hardcoded API Keys ─────────────────────────────────────── */
const CONFIG = {
  OCR_KEY    : "K87714546788957",
  GEMINI_KEY : "AIzaSyBBw9MGOHj_Tn8gK9bmQ_aMGKNGPPq5XLw",
};

/* ─── Main Analysis Pipeline ─────────────────────────────────── */
async function analyzeLabel() {
  const ocrApiKey   = CONFIG.OCR_KEY;
  const geminiKey   = CONFIG.GEMINI_KEY;

  const imageBase64 =
    state.activeTab === "camera"
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

  // Show loading UI
  showLoading();

  try {
    // ── Step 1: OCR.space OCR ───────────────────────────────────
    setLoadingStep(1);
    const ocrText = await runOCRSpaceOCR(imageBase64, ocrApiKey);

    if (!ocrText || ocrText.trim().length < 10) {
      throw new Error("Could not extract text from the image. Please ensure the label is in focus and well-lit.");
    }

    // Fix common OCR misreads before analysis
    const cleanedText = fixOcrTypos(ocrText);

    // ── Step 2: Gemini Medical Analysis ────────────────────────
    setLoadingStep(2);
    const analysisJson = await runGeminiAnalysis(cleanedText, geminiKey);

    // ── Step 3: Render results ──────────────────────────────────
    setLoadingStep(3);
    await sleep(600);
    renderResults(ocrText, analysisJson); // show raw OCR in panel, cleaned data in cards

  } catch (err) {
    console.error("MediScan error:", err);
    showError("Analysis Failed", err.message || "An unexpected error occurred. Please try again.");
  }
}

/* ─── OCR.space API ──────────────────────────────────────────── */
async function runOCRSpaceOCR(base64Image, apiKey) {
  const endpoint = "https://api.ocr.space/parse/image";

  // OCR.space requires the base64 string prefixed with a data URI
  const base64Payload = `data:image/jpeg;base64,${base64Image}`;

  const formData = new FormData();
  formData.append("base64Image",   base64Payload);
  formData.append("apikey",        apiKey);
  formData.append("language",      "eng");       // primary language
  formData.append("isOverlayRequired", "false");
  formData.append("detectOrientation",  "true"); // auto-rotate skewed labels
  formData.append("scale",         "true");      // upscale small text
  formData.append("isTable",       "false");
  formData.append("OCREngine",     "2");         // Engine 2 = better for printed text / medicine labels

  const response = await fetch(endpoint, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`OCR.space API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  // OCR.space error handling
  if (data.IsErroredOnProcessing) {
    const errMsg = data.ErrorMessage?.[0] || data.ErrorDetails || "OCR processing failed.";
    if (errMsg.toLowerCase().includes("invalid api key") || errMsg.toLowerCase().includes("unauthorized")) {
      throw new Error("Invalid OCR.space API key. Please check and try again.");
    }
    throw new Error(`OCR.space: ${errMsg}`);
  }

  // Concatenate text from all parsed results / pages
  const fullText = (data.ParsedResults || [])
    .map((r) => r.ParsedText || "")
    .join("\n")
    .trim();

  return fullText;
}

/* ─── Google Gemini API ──────────────────────────────────────────
 *
 * Uses Gemini 1.5 Flash via the Generative Language REST API.
 * Sends the cleaned OCR text and asks Gemini to return a structured
 * JSON object with: medicine_name, dosage, side_effects, warnings,
 * storage, plain_summary — all in plain, simple English.
 *
 * Endpoint: POST /v1beta/models/gemini-1.5-flash:generateContent
 * ────────────────────────────────────────────────────────────── */

async function runGeminiAnalysis(ocrText, apiKey) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  // Concise prompt — keeps token count low to avoid free-tier TPM limits
  const prompt = `You are a medical assistant. Extract info from this medicine label OCR text and return ONLY a JSON object (no markdown, no code fences, no extra text):
{
  "medicine_name": "Brand name preferred over generic. E.g. Linvas not Saroglitazar",
  "dosage": "Simple plain-English dosage instructions",
  "side_effects": ["effect 1", "effect 2"],
  "warnings": "Simple plain-English warnings",
  "storage": "Simple storage instructions",
  "plain_summary": "2-3 simple sentences a child can understand"
}
Use null for missing fields. Never invent data. Prefer brand name for medicine_name.

Label text:
${ocrText.slice(0, 1500)}`;

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 800 },
  };

  // Retry with exponential backoff for 429 rate limits
  const MAX_RETRIES = 4;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await fetch(endpoint, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(body),
    });

    if (response.status === 429) {
      const waitMs = Math.min(3000 * Math.pow(2, attempt - 1), 20000);
      if (attempt < MAX_RETRIES) {
        const stepEl = document.querySelector("#lstep2 span");
        if (stepEl) stepEl.textContent = `Rate limited — retrying in ${waitMs / 1000}s…`;
        await sleep(waitMs);
        continue;
      }
      lastError = new Error("Gemini API is busy. Please wait 30 seconds and try again.");
      break;
    }

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      if (response.status === 403) throw new Error("Invalid Google Gemini API key. Please check and try again.");
      throw new Error(err?.error?.message || `Gemini API error: ${response.status}`);
    }

    const data     = await response.json();
    const rawText  = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const jsonText = rawText.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();

    let parsed;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      const match = jsonText.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error("Gemini returned an unexpected format. Please try again.");
    }

    if (parsed.side_effects && !Array.isArray(parsed.side_effects)) {
      parsed.side_effects = String(parsed.side_effects).split(/[,;]/).map(s => s.trim()).filter(Boolean);
    }

    if (!parsed.medicine_name || parsed.medicine_name === "null") {
      parsed.medicine_name = extractMedicineName(ocrText);
    }

    return parsed;
  }

  throw lastError || new Error("Gemini API failed after retries. Please try again.");
}

/* ─── Label Text Parsers (regex fallbacks) ───────────────────── */

/**
 * Fixes common OCR misreads on medicine labels before analysis.
 */
function fixOcrTypos(text) {
  return text
    .replace(/\bdiy\b/gi,  "dry")
    .replace(/\bIight\b/gi, "light")
    .replace(/\bmoisure\b/gi, "moisture")
    .replace(/\btemperture\b/gi, "temperature")
    .replace(/\bprolect\b/gi, "protect")
    .replace(/\bphsyician\b/gi, "physician")
    .replace(/\bprescribtion\b/gi, "prescription");
}

/**
 * Extracts the medicine/drug name from OCR label text.
 *
 * Priority order:
 *  0. Brand name — short word with ® / ™, or next to "X Tablets" count line
 *  1. "GenericName Tablets/Capsules IP/BP" pattern (full line match)
 *  2. Standalone brand+dose code on its own line e.g. "P-650"
 *  3. Short clean Title Case line that passes all blocklist checks
 *
 * Brand always beats generic — "Linvas" beats "Saroglitazar".
 */
function extractMedicineName(text) {

  // ── Blocklist: reject anything matching these as a medicine name ──
  const REJECT = /dosing|interval|dose|dosage|minimum|maximum|excipient|q\.s|composition|each\s+tablet|each\s+uncoated|contains?|manufactured|store|storage|warning|caution|keep\s+out|keep\s+away|should\s+not|not\s+be|do\s+not|analgesic|antipyretic|anti\-?pyretic|hours|daily|times|4000|650\s*mg|mfg|batch|exp\b|lic\b|reg\b|plot|floor|india|chennai|mumbai|delhi|sikkim|tamil|gujarat|maharashtra|limited|private|laboratory|laboratories|swiss|garner|genexisa|sciences|apex\s+lab|lupin|zydus|cipla|sun\s+pharma|marketed|manufactured/i;

  function isValidName(s) {
    if (!s || s.length < 2 || s.length > 45) return false;
    if (/^\d/.test(s))  return false;
    if (/:/.test(s))    return false;
    if (REJECT.test(s)) return false;
    return true;
  }

  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  // ── Pass 0: Brand name with ® or ™ symbol ─────────────────────
  // Most reliable signal — "Linvas®", "Crocin®", "Dolo®"
  // Also catches "Linvas" when ® is on the same line as tablet count
  const brandSymbolRe = /([A-Za-z][A-Za-z\-]{1,20})\s*[®™°]/;
  for (const line of lines) {
    const m = line.match(brandSymbolRe);
    if (!m) continue;
    const candidate = m[1].trim();
    if (isValidName(candidate)) return toTitleCase(candidate);
  }

  // ── Pass 0b: "BrandName  X Tablets" on one line (no ® needed) ──
  // e.g. "Linvas  10 Tablets", "Dolo 15 Tablets"
  const brandCountRe = /^([A-Za-z][A-Za-z\-]{1,20})\s+\d{1,3}\s+tablets?/i;
  for (const line of lines) {
    const m = line.match(brandCountRe);
    if (!m) continue;
    const candidate = m[1].trim();
    if (isValidName(candidate)) return toTitleCase(candidate);
  }

  // ── Pass 1: "GenericName Tablets/Capsules IP/BP" full line ─────
  const tabletRe = /^([A-Za-z][A-Za-z\s\-]{1,35}?)\s+(?:tablets?|capsules?|syrup|injection|suspension|drops?|cream|gel|ointment|solution)\b/i;
  for (const line of lines) {
    const m = line.match(tabletRe);
    if (!m) continue;
    const candidate = m[1].trim();
    if (isValidName(candidate) && !/dosage|dose|interval|minimum|maximum|adult|child/i.test(candidate)) {
      return toTitleCase(candidate);
    }
  }

  // ── Pass 2: Standalone brand+dose code e.g. "P-650", "Dolo-650" ─
  const brandRe = /^([A-Za-z][A-Za-z\-]{1,15})\s*[-–]?\s*(\d{2,4})(?:\s*(?:mg|ml|mcg|g))?\s*$/i;
  for (const line of lines) {
    const m = line.match(brandRe);
    if (!m) continue;
    if (isValidName(m[1])) return toTitleCase(`${m[1]} ${m[2]}`);
  }

  // ── Pass 3: Short clean Title Case proper noun ────────────────
  for (const line of lines) {
    if (line.length < 3 || line.length > 40) continue;
    if (!/^[A-Z]/.test(line)) continue;
    if (/[:\-\d]/.test(line.charAt(line.length - 1))) continue;
    if (/\d/.test(line) && !/^[A-Za-z]+-\d+$/.test(line)) continue;
    if (!isValidName(line)) continue;
    if (/\b(interval|dosing|minimum|maximum|every|hours?|times?|daily|each|uncoated|tablets?|capsules?)\b/i.test(line)) continue;
    return toTitleCase(line);
  }

  return "Unknown Medicine";
}

/**
 * Extracts dosage/administration instructions from label text.
 */
function extractDosage(text) {
  const patterns = [
    /take\s+[\w\s,]+(?:tablet|capsule|pill|drop|ml|mg|teaspoon|spoon)[^\.\n]*/gi,
    /(?:dose|dosage)[:\s]+[^\.\n]{5,120}/gi,
    /(?:adults?|children?)[:\s]+[^\.\n]{5,120}/gi,
    /\d+\s*(?:tablet|capsule|pill|drop|ml)\s+[\w\s]+(?:daily|day|hour|week|meal|food)[^\.\n]*/gi,
    /(?:oral|by mouth|orally)[^\.\n]{0,100}/gi,
  ];
  const found = [];
  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    found.push(...matches.map(m => m.trim()));
  }
  if (!found.length) return extractFirstMentionOf(text, ["dose", "dosage", "directions", "administration"]);
  return toReadableSentences([...new Set(found)].slice(0, 3).join(". "));
}

/**
 * Extracts warnings from label text.
 */
function extractWarnings(text) {
  const patterns = [
    /(?:warning|caution|do not|avoid|contraindic|not recommended|keep out|keep away)[^\.\n]{5,200}/gi,
    /(?:allerg|consult\s+(?:a\s+)?(?:doctor|physician|pharmacist))[^\.\n]{5,150}/gi,
    /(?:stop\s+(?:using|taking)|discontinue)[^\.\n]{5,150}/gi,
  ];
  const found = [];
  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    found.push(...matches.map(m => m.trim()));
  }
  if (!found.length) return extractFirstMentionOf(text, ["warning", "caution", "contraindication"]);
  return toReadableSentences([...new Set(found)].slice(0, 3).join(". "));
}

/**
 * Extracts storage instructions from label text.
 */
function extractStorage(text) {
  const patterns = [
    /store(?:d)?\s+[^\.\n]{5,120}/gi,
    /keep\s+(?:in|at|below|between|away)[^\.\n]{5,120}/gi,
    /(?:temperature|cool|dry|refrigerat|light|moisture)[^\.\n]{5,100}/gi,
  ];
  const found = [];
  for (const pattern of patterns) {
    const matches = text.match(pattern) || [];
    found.push(...matches.map(m => m.trim()));
  }
  if (!found.length) return extractFirstMentionOf(text, ["store", "storage", "keep"]);
  return toReadableSentences([...new Set(found)].slice(0, 2).join(". "));
}

/**
 * Fallback side-effect extraction from explicit label sections.
 */
function extractFallbackSideEffects(text) {
  const sectionMatch = text.match(/(?:side\s*effects?|adverse\s*(?:effects?|reactions?))[:\s]+([^\n]{10,400})/i);
  if (sectionMatch) {
    return sectionMatch[1]
      .split(/[,;\/]/)
      .map(s => toPlainEnglish(s.trim()))
      .filter(s => s.length > 2)
      .slice(0, 8);
  }
  const symptomWords = [
    "nausea","vomiting","dizziness","headache","drowsiness","rash","itching",
    "dry mouth","constipation","diarrhea","stomach pain","fatigue","insomnia",
    "blurred vision","sweating","palpitations","swelling","fever","allergic reaction"
  ];
  return symptomWords.filter(w => new RegExp(w, "i").test(text));
}

/* ─── Plain-English Helpers ──────────────────────────────────── */

function buildPlainSummary(name, dosage, sideEffects, warnings) {
  const parts = [];
  if (name && name !== "Unknown Medicine") {
    parts.push(`${name} is a medicine that you should take as directed on the label.`);
  } else {
    parts.push("This medicine should be taken exactly as directed on the label.");
  }
  if (dosage) parts.push(`Remember: ${dosage.split(".")[0]}.`);
  if (sideEffects?.length) {
    parts.push(`It may cause some effects like ${sideEffects.slice(0, 3).join(", ")}. Talk to your doctor if anything feels wrong.`);
  }
  if (warnings) parts.push("Always read the warnings and ask your pharmacist if you are unsure.");
  return parts.join(" ");
}

function toPlainEnglish(text) {
  if (!text) return "";
  // Capitalize first letter, lowercase rest, trim punctuation
  return text.charAt(0).toUpperCase() + text.slice(1).toLowerCase().replace(/[\.;:,]+$/, "").trim();
}

function toTitleCase(text) {
  return text.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function toReadableSentences(text) {
  // Ensure each sentence ends with a period, collapse extra spaces
  return text
    .replace(/\s{2,}/g, " ")
    .replace(/([^.])\s*$/, "$1.")
    .trim();
}

function extractFirstMentionOf(text, keywords) {
  for (const kw of keywords) {
    const re = new RegExp(`${kw}[:\\s]+([^\\n]{10,200})`, "i");
    const m  = text.match(re);
    if (m) return toReadableSentences(m[1].trim());
  }
  return null;
}

/* ─── UI: Loading ────────────────────────────────────────────── */
function showLoading() {
  document.getElementById("resultsIdle").style.display    = "none";
  document.getElementById("resultsError").style.display   = "none";
  document.getElementById("resultCards").style.display    = "none";
  document.getElementById("resultsLoading").style.display = "flex";

  // Reset steps
  ["lstep1","lstep2","lstep3"].forEach(id => {
    const el = document.getElementById(id);
    el.classList.remove("active","done");
  });
  document.getElementById("progressFill").style.width = "0%";
}

function setLoadingStep(step) {
  const steps = ["lstep1","lstep2","lstep3"];
  const progress = [30, 65, 90];
  steps.forEach((id, i) => {
    const el = document.getElementById(id);
    el.classList.remove("active","done");
    if (i + 1 < step)  el.classList.add("done");
    if (i + 1 === step) el.classList.add("active");
  });
  document.getElementById("progressFill").style.width = progress[step - 1] + "%";
}

/* ─── UI: Error ──────────────────────────────────────────────── */
function showError(title, msg) {
  document.getElementById("resultsIdle").style.display    = "none";
  document.getElementById("resultsLoading").style.display = "none";
  document.getElementById("resultCards").style.display    = "none";
  document.getElementById("resultsError").style.display   = "flex";
  document.getElementById("errorTitle").textContent = title;
  document.getElementById("errorMsg").textContent   = msg;
}

/* ─── UI: Render Results ─────────────────────────────────────── */
function renderResults(ocrText, analysis) {
  document.getElementById("resultsLoading").style.display = "none";
  document.getElementById("resultsIdle").style.display    = "none";
  document.getElementById("resultsError").style.display   = "none";
  document.getElementById("resultCards").style.display    = "flex";
  document.getElementById("resultBadge").style.display    = "inline-block";
  document.getElementById("progressFill").style.width     = "100%";

  // Raw OCR
  document.getElementById("rawOcrText").textContent = ocrText;

  // Medicine Name
  if (analysis.medicine_name) {
    document.getElementById("medicineName").textContent = analysis.medicine_name;
    document.getElementById("cardName").style.display = "flex";
    animateCard("cardName", 0);
  }

  // Dosage
  if (analysis.dosage) {
    document.getElementById("dosageText").textContent = analysis.dosage;
    document.getElementById("cardDosage").style.display = "block";
    animateCard("cardDosage", 1);
  }

  // Side Effects
  if (analysis.side_effects?.length) {
    const list = document.getElementById("sideEffectsList");
    list.innerHTML = "";
    analysis.side_effects.forEach((effect) => {
      const li = document.createElement("li");
      li.textContent = effect;
      list.appendChild(li);
    });
    document.getElementById("cardSideEffects").style.display = "block";
    animateCard("cardSideEffects", 2);
  }

  // Warnings
  if (analysis.warnings) {
    document.getElementById("warningsText").textContent = analysis.warnings;
    document.getElementById("cardWarnings").style.display = "block";
    animateCard("cardWarnings", 3);
  }

  // Storage
  if (analysis.storage) {
    document.getElementById("storageText").textContent = analysis.storage;
    document.getElementById("cardStorage").style.display = "block";
    animateCard("cardStorage", 4);
  }

  // Plain Summary
  if (analysis.plain_summary) {
    document.getElementById("summaryText").textContent = analysis.plain_summary;
    document.getElementById("cardSummary").style.display = "block";
    animateCard("cardSummary", 5);
  }
}

function animateCard(id, delayIndex) {
  const el = document.getElementById(id);
  el.style.animationDelay = `${delayIndex * 80}ms`;
}

/* ─── UI: Reset ──────────────────────────────────────────────── */
function resetResults() {
  document.getElementById("resultsIdle").style.display    = "flex";
  document.getElementById("resultsLoading").style.display = "none";
  document.getElementById("resultsError").style.display   = "none";
  document.getElementById("resultCards").style.display    = "none";
  document.getElementById("resultBadge").style.display    = "none";

  // Hide all cards
  ["cardName","cardDosage","cardSideEffects","cardWarnings","cardStorage","cardSummary"].forEach(id => {
    document.getElementById(id).style.display = "none";
  });
  document.getElementById("progressFill").style.width = "0%";
}

function resetCapture() {
  state.capturedImageBase64 = null;
  document.getElementById("capturedPreviewWrap").style.display = "none";
  document.getElementById("capturedPreview").src = "";
  startCamera();
}

/* ─── Utility ────────────────────────────────────────────────── */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ─── Smooth scroll for hero CTA ─────────────────────────────── */
document.addEventListener("DOMContentLoaded", () => {
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", function (e) {
      const target = document.querySelector(this.getAttribute("href"));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    });
  });

  // Staggered hero entrance animation
  const heroElements = document.querySelectorAll(
    ".hero__eyebrow, .hero__title, .hero__subtitle, .hero__cta, .hero__stats"
  );
  heroElements.forEach((el, i) => {
    el.style.opacity    = "0";
    el.style.transform  = "translateY(20px)";
    el.style.transition = `opacity 0.6s ease ${i * 100}ms, transform 0.6s ease ${i * 100}ms`;
    requestAnimationFrame(() => {
      setTimeout(() => {
        el.style.opacity   = "1";
        el.style.transform = "translateY(0)";
      }, 50 + i * 100);
    });
  });

  // Intersection observer for step cards
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.style.opacity   = "1";
          entry.target.style.transform = "translateY(0)";
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.2 }
  );

  document.querySelectorAll(".step").forEach((step, i) => {
    step.style.opacity    = "0";
    step.style.transform  = "translateY(24px)";
    step.style.transition = `opacity 0.5s ease ${i * 120}ms, transform 0.5s ease ${i * 120}ms`;
    observer.observe(step);
  });
});