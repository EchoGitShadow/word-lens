(() => {
  const CONFIDENCE_MIN = 55;
  const DICTIONARY_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
  const TESSERACT_VERSION = "5.1.1";
  const TESSERACT_CORE = "5.1.1";

  const $ = (id) => document.getElementById(id);

  const preview = $("preview");
  const frame = $("frame");
  const boxesEl = $("boxes");
  const startEl = $("start");
  const startHint = $("start-hint");
  const loadingEl = $("loading");
  const loadingText = $("loading-text");
  const controls = $("controls");
  const shutter = $("shutter");
  const retake = $("retake");
  const tapHint = $("tap-hint");
  const toastEl = $("toast");
  const sheet = $("sheet");
  const sheetBackdrop = $("sheet-backdrop");
  const sheetWord = $("sheet-word");
  const sheetPhonetic = $("sheet-phonetic");
  const sheetBody = $("sheet-body");
  const fileInput = $("file");

  let stream = null;
  let busy = false;
  let workerPromise = null;
  let progressHandler = null;
  let toastTimer = null;
  let lookupAbort = null;

  preview.setAttribute("playsinline", "true");
  preview.setAttribute("webkit-playsinline", "true");
  preview.muted = true;
  preview.autoplay = true;
  preview.playsInline = true;

  function show(el) {
    el.hidden = false;
  }

  function hide(el) {
    el.hidden = true;
  }

  function setMode(mode) {
    document.body.classList.remove("live", "frozen");
    if (mode) document.body.classList.add(mode);
  }

  function showToast(message) {
    toastEl.textContent = message;
    show(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(toastEl), 4000);
  }

  function setLoading(on, message) {
    if (on) {
      loadingText.textContent = message || "Reading words…";
      show(loadingEl);
    } else {
      hide(loadingEl);
    }
  }

  function cameraConstraints() {
    return {
      audio: false,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      },
    };
  }

  async function startCamera() {
    stopCamera();
    try {
      stream = await navigator.mediaDevices.getUserMedia(cameraConstraints());
    } catch (err) {
      if (err && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: "environment" },
        });
      } else {
        throw err;
      }
    }
    preview.srcObject = stream;
    await preview.play();
  }

  function stopCamera() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    preview.srcObject = null;
  }

  function cameraErrorMessage(err) {
    if (!window.isSecureContext) {
      return "Camera access needs a secure (HTTPS) connection.";
    }
    if (err && err.name === "NotAllowedError") {
      return "Camera permission is off. On iPhone, open Settings → Safari → Camera, then try again.";
    }
    if (err && (err.name === "NotFoundError" || err.name === "OverconstrainedError")) {
      return "No rear camera was found. You can still choose a photo.";
    }
    return "Couldn’t open the camera. You can still choose a photo.";
  }

  async function openLiveCamera() {
    if (busy) return;
    busy = true;
    startHint.hidden = true;
    try {
      await startCamera();
      hide(startEl);
      hide(retake);
      show(shutter);
      show(controls);
      hide(tapHint);
      hide(boxesEl);
      boxesEl.innerHTML = "";
      closeSheet(true);
      setMode("live");
    } catch (err) {
      console.error(err);
      startHint.textContent = cameraErrorMessage(err);
      startHint.hidden = false;
    } finally {
      busy = false;
    }
  }

  function captureVideoFrame() {
    const w = preview.videoWidth;
    const h = preview.videoHeight;
    if (!w || !h) throw new Error("Camera is not ready yet.");
    frame.width = w;
    frame.height = h;
    const ctx = frame.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(preview, 0, 0, w, h);
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const maxSide = 1920;
        let w = img.naturalWidth;
        let h = img.naturalHeight;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.max(1, Math.round(w * scale));
        h = Math.max(1, Math.round(h * scale));
        frame.width = w;
        frame.height = h;
        const ctx = frame.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Couldn’t read that image."));
      };
      img.src = url;
    });
  }

  function normalizeWord(text) {
    return String(text || "")
      .replace(/[^A-Za-z'’-]/g, "")
      .replace(/^[’'-]+|[’'-]+$/g, "")
      .replace(/’/g, "'")
      .toLowerCase();
  }

  function isKeepableToken(raw, confidence) {
    if (confidence < CONFIDENCE_MIN) return false;
    const word = normalizeWord(raw);
    if (!word) return false;
    if (!/[a-z]/.test(word)) return false;
    if (!/^[a-z]+(?:['-][a-z]+)*$/.test(word)) return false;
    if (word.length === 1 && word !== "a" && word !== "i") return false;
    return true;
  }

  function getWorker() {
    if (!workerPromise) {
      const opts = {
        logger: (m) => {
          if (typeof progressHandler === "function") progressHandler(m);
        },
        workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`,
        corePath: `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_CORE}/tesseract-core-simd-lstm.wasm.js`,
        langPath: "https://tessdata.projectnaptha.com/4.0.0",
      };
      workerPromise = Tesseract.createWorker("eng", 1, opts).catch((err) => {
        workerPromise = null;
        throw err;
      });
    }
    return workerPromise;
  }

  async function recognizeFrame() {
    const worker = await getWorker();
    const { data } = await worker.recognize(frame);
    const words = (data.words || [])
      .filter((w) => isKeepableToken(w.text, w.confidence ?? 0))
      .map((w) => ({
        text: w.text,
        word: normalizeWord(w.text),
        confidence: w.confidence,
        bbox: w.bbox,
      }));
    return words;
  }

  function containedRect() {
    const stage = frame.parentElement.getBoundingClientRect();
    const natW = frame.width || 1;
    const natH = frame.height || 1;
    const scale = Math.min(stage.width / natW, stage.height / natH);
    const width = natW * scale;
    const height = natH * scale;
    return {
      left: (stage.width - width) / 2,
      top: (stage.height - height) / 2,
      width,
      height,
      natW,
      natH,
    };
  }

  function syncOverlay() {
    if (boxesEl.hidden) return;
    const rect = containedRect();
    boxesEl.style.left = `${rect.left}px`;
    boxesEl.style.top = `${rect.top}px`;
    boxesEl.style.width = `${rect.width}px`;
    boxesEl.style.height = `${rect.height}px`;
  }

  function renderBoxes(words) {
    boxesEl.innerHTML = "";
    const sorted = words.slice().sort((a, b) => {
      const areaA = (a.bbox.x1 - a.bbox.x0) * (a.bbox.y1 - a.bbox.y0);
      const areaB = (b.bbox.x1 - b.bbox.x0) * (b.bbox.y1 - b.bbox.y0);
      return areaB - areaA;
    });
    for (const item of sorted) {
      const { x0, y0, x1, y1 } = item.bbox;
      const el = document.createElement("button");
      el.type = "button";
      el.className = "word-box";
      el.style.left = `${(x0 / frame.width) * 100}%`;
      el.style.top = `${(y0 / frame.height) * 100}%`;
      el.style.width = `${((x1 - x0) / frame.width) * 100}%`;
      el.style.height = `${((y1 - y0) / frame.height) * 100}%`;
      el.setAttribute("aria-label", `Define ${item.word}`);
      el.addEventListener("click", (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        selectWord(el, item);
      });
      boxesEl.appendChild(el);
    }
    show(boxesEl);
    syncOverlay();
  }

  function selectWord(el, item) {
    for (const box of boxesEl.querySelectorAll(".word-box.active")) {
      box.classList.remove("active");
    }
    el.classList.add("active");
    openSheet(item.word);
  }

  function closeSheet(immediate) {
    if (lookupAbort) {
      lookupAbort.abort();
      lookupAbort = null;
    }
    sheet.classList.remove("open");
    const hideSheet = () => hide(sheet);
    if (immediate) {
      hideSheet();
    } else {
      setTimeout(hideSheet, 280);
    }
    for (const box of boxesEl.querySelectorAll(".word-box.active")) {
      box.classList.remove("active");
    }
  }

  function openSheet(word) {
    sheetWord.textContent = word;
    sheetPhonetic.textContent = "";
    sheetBody.innerHTML = `<p class="pending"><span class="spinner"></span>Looking up definition…</p>`;
    show(sheet);
    requestAnimationFrame(() => sheet.classList.add("open"));
    loadDefinition(word);
  }

  async function loadDefinition(word) {
    if (lookupAbort) lookupAbort.abort();
    const ac = new AbortController();
    lookupAbort = ac;
    try {
      const result = await fetchDefinition(word, ac.signal);
      if (lookupAbort !== ac) return;
      renderDefinition(word, result);
    } catch (err) {
      if (err && err.name === "AbortError") return;
      if (lookupAbort !== ac) return;
      if (err && err.code === "not_found") {
        sheetPhonetic.textContent = "";
        sheetBody.innerHTML = `<p class="empty">No definition found for “${escapeHtml(word)}.” It might be a name, a typo, or too uncommon for this dictionary.</p>`;
        return;
      }
      sheetBody.innerHTML = `<p class="empty">Couldn’t reach the dictionary. Check your connection and try again.</p>`;
    }
  }

  async function fetchDefinition(word, signal) {
    const res = await fetch(DICTIONARY_URL + encodeURIComponent(word), { signal });
    if (res.status === 404) {
      const err = new Error("not found");
      err.code = "not_found";
      throw err;
    }
    if (!res.ok) throw new Error(`Dictionary error ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) {
      const err = new Error("not found");
      err.code = "not_found";
      throw err;
    }
    return data;
  }

  function firstPhonetic(entries) {
    for (const entry of entries) {
      if (entry.phonetic) return entry.phonetic;
      if (Array.isArray(entry.phonetics)) {
        const hit = entry.phonetics.find((p) => p && p.text);
        if (hit) return hit.text;
      }
    }
    return "";
  }

  function renderDefinition(word, entries) {
    const display = (entries[0] && entries[0].word) || word;
    sheetWord.textContent = display.toLowerCase();
    sheetPhonetic.textContent = firstPhonetic(entries);

    const meanings = [];
    for (const entry of entries) {
      for (const meaning of entry.meanings || []) {
        const defs = (meaning.definitions || [])
          .map((d) => d.definition)
          .filter(Boolean)
          .slice(0, 3);
        if (!defs.length) continue;
        meanings.push({
          pos: meaning.partOfSpeech || "",
          defs,
        });
        if (meanings.length >= 3) break;
      }
      if (meanings.length >= 3) break;
    }

    if (!meanings.length) {
      sheetBody.innerHTML = `<p class="empty">No definition found for “${escapeHtml(word)}.” It might be a name, a typo, or too uncommon for this dictionary.</p>`;
      return;
    }

    sheetBody.innerHTML = meanings
      .map(
        (m) => `
        <section class="meaning">
          ${m.pos ? `<div class="pos">${escapeHtml(m.pos)}</div>` : ""}
          <ol>${m.defs.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ol>
        </section>`
      )
      .join("");
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  async function runOcrFlow() {
    closeSheet(true);
    hide(tapHint);
    hide(boxesEl);
    boxesEl.innerHTML = "";
    setMode("frozen");
    hide(shutter);
    show(retake);
    show(controls);
    hide(startEl);

    let lastStatus = "Preparing reader…";
    setLoading(true, lastStatus);
    progressHandler = (m) => {
      if (!m) return;
      if (m.status === "recognizing text" && typeof m.progress === "number") {
        loadingText.textContent = `Reading words… ${Math.round(m.progress * 100)}%`;
      } else if (m.status && m.status !== "recognizing text") {
        const label = {
          "loading tesseract core": "Loading reader…",
          "initializing tesseract": "Starting reader…",
          "loading language traineddata": "Loading English data…",
          "initializing api": "Getting ready…",
        }[m.status];
        if (label) loadingText.textContent = label;
      }
    };

    try {
      const words = await recognizeFrame();
      setLoading(false);
      renderBoxes(words);
      if (!words.length) {
        showToast("No clear words found. Try sharper text and retake.");
        hide(tapHint);
      } else {
        show(tapHint);
      }
      return words;
    } catch (err) {
      console.error(err);
      setLoading(false);
      showToast("Couldn’t read the text. Try a clearer shot.");
      show(tapHint);
      hide(tapHint);
      throw err;
    } finally {
      progressHandler = null;
    }
  }

  async function onShutter() {
    if (busy) return;
    if (!preview.videoWidth) {
      showToast("Camera is still starting. Try again in a moment.");
      return;
    }
    busy = true;
    try {
      captureVideoFrame();
      await runOcrFlow();
    } catch (err) {
      console.error(err);
    } finally {
      busy = false;
    }
  }

  async function onRetake() {
    if (busy) return;
    closeSheet(true);
    hide(boxesEl);
    boxesEl.innerHTML = "";
    hide(tapHint);
    hide(toastEl);
    if (!stream) {
      hide(controls);
      show(startEl);
      setMode("");
      return;
    }
    try {
      await preview.play();
    } catch (err) {
      console.error(err);
    }
    hide(retake);
    show(shutter);
    setMode("live");
  }

  async function onChoosePhoto() {
    fileInput.click();
  }

  async function onFileChange(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = "";
    if (!file) return;
    if (busy) return;
    busy = true;
    try {
      await loadImageFile(file);
      await runOcrFlow();
    } catch (err) {
      console.error(err);
      setLoading(false);
      showToast(err.message || "Couldn’t use that photo.");
    } finally {
      busy = false;
    }
  }

  $("open-camera").addEventListener("click", openLiveCamera);
  $("choose-photo").addEventListener("click", onChoosePhoto);
  shutter.addEventListener("click", onShutter);
  retake.addEventListener("click", onRetake);
  fileInput.addEventListener("change", onFileChange);
  $("sheet-close").addEventListener("click", () => closeSheet());
  sheetBackdrop.addEventListener("click", () => closeSheet());
  window.addEventListener("resize", syncOverlay);
  window.addEventListener("orientationchange", () => setTimeout(syncOverlay, 250));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    if (document.body.classList.contains("live") && stream) {
      preview.play().catch(() => {});
    }
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch((err) => {
        console.warn("Service worker skipped", err);
      });
    });
  }

  // After permission has been granted, skip the start screen when possible.
  // iPhone Safari still needs a tap the first time.
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    openLiveCamera();
  }

  window.__wordLensTest = {
    normalizeWord,
    isKeepableToken,
    async recognizeImageBlob(blob) {
      const file = blob instanceof File ? blob : new File([blob], "sample.png", { type: blob.type || "image/png" });
      await loadImageFile(file);
      return runOcrFlow();
    },
    async lookup(word) {
      return fetchDefinition(normalizeWord(word));
    },
    async openWord(word) {
      openSheet(normalizeWord(word));
    },
  };
})();
