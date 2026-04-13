/**
 * MediScan — app.js
 * Architecture:
 *   1. Google ML Kit (camera capture via WebRTC — browser equivalent)
 *   2. OCR.space API (OCR / text extraction)
 *   3. OpenAI GPT-4 (medical text understanding → plain English)
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

/* ─── API Key Persistence (localStorage) ─────────────────────── */
function saveApiKeys() {
  const ocrKey    = document.getElementById("ocrApiKey").value.trim();
  const openaiKey = document.getElementById("openaiApiKey").value.trim();
  if (ocrKey)    localStorage.setItem("mediscan_ocr_key",    ocrKey);
  if (openaiKey) localStorage.setItem("mediscan_openai_key", openaiKey);
}

function loadApiKeys() {
  const ocrKey    = localStorage.getItem("mediscan_ocr_key");
  const openaiKey = localStorage.getItem("mediscan_openai_key");
  if (ocrKey)    document.getElementById("ocrApiKey").value    = ocrKey;
  if (openaiKey) document.getElementById("openaiApiKey").value = openaiKey;
}

function clearApiKeys() {
  localStorage.removeItem("mediscan_ocr_key");
  localStorage.removeItem("mediscan_openai_key");
  document.getElementById("ocrApiKey").value    = "";
  document.getElementById("openaiApiKey").value = "";
}

/* ─── Main Analysis Pipeline ─────────────────────────────────── */
async function analyzeLabel() {
  const ocrApiKey = document.getElementById("ocrApiKey").value.trim();
  const openaiKey = document.getElementById("openaiApiKey").value.trim();

  if (!ocrApiKey || !openaiKey) {
    showError(
      "API Keys Required",
      "Please expand the API Configuration panel and enter your OCR.space API key and OpenAI API key."
    );
    return;
  }

  // Persist keys so they survive refresh/reopen
  saveApiKeys();

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

    // ── Step 2: GPT-4 Medical Analysis ─────────────────────────
    setLoadingStep(2);
    const analysisJson = await runGPT4Analysis(ocrText, openaiKey);

    // ── Step 3: Render results ──────────────────────────────────
    setLoadingStep(3);
    await sleep(600);
    renderResults(ocrText, analysisJson);

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

/* ─── OpenAI GPT-4 Analysis ──────────────────────────────────── */
async function runGPT4Analysis(ocrText, apiKey) {
  const systemPrompt = `You are MediScan, a friendly medical assistant helping low-literacy users understand medicine labels.

Given raw OCR text from a medicine label, extract and explain the following in SIMPLE, plain English — as if explaining to someone with a 5th-grade reading level. Avoid medical jargon. Use short sentences.

Respond ONLY with a valid JSON object with this exact schema (no markdown, no preamble):
{
  "medicine_name": "Name of the medicine",
  "dosage": "Plain-English explanation of how much to take and when (e.g., 'Take 1 tablet by mouth, 2 times a day, after meals.')",
  "side_effects": ["Side effect 1 in simple words", "Side effect 2", "..."],
  "warnings": "Simple plain-English warnings (e.g., 'Do not drive after taking this. Keep away from children.')",
  "storage": "Simple storage instructions (e.g., 'Keep in a cool, dry place. Do not refrigerate.')",
  "plain_summary": "A 2–3 sentence friendly summary of this medicine that a child or elderly person could understand."
}

If a field is not found in the label, use null for that field.
Never make up dosage or side effects — only use what's on the label.`;

  const userPrompt = `Here is the raw OCR text from a medicine label:\n\n---\n${ocrText}\n---\n\nPlease analyze this and respond with the JSON.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user",   content: userPrompt },
      ],
      max_tokens: 1000,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    const errData = await response.json().catch(() => ({}));
    const msg = errData?.error?.message || `OpenAI API error: ${response.status}`;
    if (response.status === 401) throw new Error("Invalid OpenAI API key. Please check and try again.");
    if (response.status === 429) throw new Error("OpenAI rate limit reached. Please wait a moment and try again.");
    throw new Error(msg);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "{}";

  try {
    return JSON.parse(content);
  } catch {
    // Try to extract JSON from response if parsing fails
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("Failed to parse GPT-4 response. Please try again.");
  }
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
  // Restore saved API keys from previous session
  loadApiKeys();
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