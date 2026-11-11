(() => {
  const CONFIDENCE_MIN = 55;
  const SHORT_WORD_MAX = 2;
  const DICTIONARY_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
  const TESSERACT_VERSION = "5.1.1";
  const TESSERACT_CORE = "5.1.1";
  const ANALYZE_MAX = 400;
  const FLIP_MAX = 480;
  const FLIP_CONF_OK = 70;
  const FLIP_WORDS_OK = 4;
  const SHOW_ALL_KEY = "word-lens-show-all";

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
  const toggleCommon = $("toggle-common");
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
  let commonWords = new Set();
  let lastWords = [];
  let lastOrientation = { angle: 0 };
  let showAll = false;
  let quietOcr = false;

  try {
    showAll = localStorage.getItem(SHOW_ALL_KEY) === "1";
  } catch (err) {
    showAll = false;
  }

  const commonReady = fetch("./common-words.json")
    .then((res) => {
      if (!res.ok) throw new Error("common list missing");
      return res.json();
    })
    .then((list) => {
      if (Array.isArray(list)) commonWords = new Set(list.map((w) => String(w).toLowerCase()));
    })
    .catch((err) => {
      console.warn("Common-word list unavailable", err);
    });

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
      hide(toggleCommon);
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

  function isCommonWord(word) {
    return commonWords.has(word);
  }

  function isFilteredOut(word) {
    if (word.length <= SHORT_WORD_MAX) return true;
    return isCommonWord(word);
  }

  function visibleWords(words) {
    if (showAll) return words.slice();
    return words.filter((w) => !isFilteredOut(w.word));
  }

  function updateToggleLabel() {
    toggleCommon.textContent = "Show all";
    toggleCommon.setAttribute("aria-pressed", showAll ? "true" : "false");
    toggleCommon.setAttribute("aria-label", showAll ? "Hide common words" : "Show all words");
  }

  function setShowAll(next) {
    showAll = !!next;
    try {
      localStorage.setItem(SHOW_ALL_KEY, showAll ? "1" : "0");
    } catch (err) {
      // ignore quota / private mode
    }
    updateToggleLabel();
    if (lastWords.length) renderBoxes(lastWords);
  }

  function getWorker() {
    if (!workerPromise) {
      const opts = {
        logger: (m) => {
          if (quietOcr) return;
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

  function makeScaledCanvas(source, maxSide) {
    const scale = Math.min(1, maxSide / Math.max(source.width, source.height));
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    return canvas;
  }

  function rotateCanvas(source, angleDeg) {
    const angle = ((angleDeg % 360) + 360) % 360;
    if (angle < 0.05 || angle > 359.95) {
      const copy = document.createElement("canvas");
      copy.width = source.width;
      copy.height = source.height;
      copy.getContext("2d").drawImage(source, 0, 0);
      return copy;
    }
    const rad = (angle * Math.PI) / 180;
    const w = source.width;
    const h = source.height;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round(Math.abs(w * c) + Math.abs(h * s)));
    out.height = Math.max(1, Math.round(Math.abs(w * s) + Math.abs(h * c)));
    const ctx = out.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(rad);
    ctx.drawImage(source, -w / 2, -h / 2);
    return out;
  }

  function otsuThreshold(hist, total) {
    let sum = 0;
    for (let t = 0; t < 256; t += 1) sum += t * hist[t];
    let sumB = 0;
    let wB = 0;
    let max = 0;
    let thresh = 127;
    for (let t = 0; t < 256; t += 1) {
      wB += hist[t];
      if (!wB) continue;
      const wF = total - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > max) {
        max = between;
        thresh = t;
      }
    }
    return thresh;
  }

  function binarizeCanvas(source) {
    const w = source.width;
    const h = source.height;
    const srcCtx = source.getContext("2d", { willReadFrequently: true });
    const img = srcCtx.getImageData(0, 0, w, h);
    const gray = new Uint8Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < img.data.length; i += 4, p += 1) {
      const value = (img.data[i] * 299 + img.data[i + 1] * 587 + img.data[i + 2] * 114) / 1000;
      const g = value < 0 ? 0 : value > 255 ? 255 : value | 0;
      gray[p] = g;
      hist[g] += 1;
    }
    const thresh = otsuThreshold(hist, w * h);
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d", { willReadFrequently: true });
    const outImg = ctx.createImageData(w, h);
    for (let p = 0, i = 0; p < gray.length; p += 1, i += 4) {
      const v = gray[p] < thresh ? 0 : 255;
      outImg.data[i] = v;
      outImg.data[i + 1] = v;
      outImg.data[i + 2] = v;
      outImg.data[i + 3] = 255;
    }
    ctx.putImageData(outImg, 0, 0);
    return out;
  }

  function rowSumVariance(ctx, width, height) {
    const data = ctx.getImageData(0, 0, width, height).data;
    const sums = new Float64Array(height);
    let ink = 0;
    for (let y = 0; y < height; y += 1) {
      let row = 0;
      for (let x = 0; x < width; x += 1) {
        if (data[(y * width + x) * 4] < 128) {
          row += 1;
          ink += 1;
        }
      }
      sums[y] = row;
    }
    if (ink < 20) return 0;
    let mean = 0;
    for (let y = 0; y < height; y += 1) mean += sums[y];
    mean /= height;
    let variance = 0;
    for (let y = 0; y < height; y += 1) {
      const d = sums[y] - mean;
      variance += d * d;
    }
    return variance / height;
  }

  function scoreSkewAngle(binary, angleDeg, scratch) {
    const rad = (angleDeg * Math.PI) / 180;
    const w = binary.width;
    const h = binary.height;
    const c = Math.cos(rad);
    const s = Math.sin(rad);
    const nw = Math.max(1, Math.ceil(Math.abs(w * c) + Math.abs(h * s)));
    const nh = Math.max(1, Math.ceil(Math.abs(w * s) + Math.abs(h * c)));
    if (scratch.width < nw || scratch.height < nh) {
      scratch.width = Math.max(scratch.width, nw);
      scratch.height = Math.max(scratch.height, nh);
    }
    const ctx = scratch.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, scratch.width, scratch.height);
    ctx.save();
    ctx.translate(nw / 2, nh / 2);
    ctx.rotate(rad);
    ctx.drawImage(binary, -w / 2, -h / 2);
    ctx.restore();
    return rowSumVariance(ctx, nw, nh);
  }

  function findLineAngle(source) {
    const small = makeScaledCanvas(source, ANALYZE_MAX);
    const binary = binarizeCanvas(small);
    const scratch = document.createElement("canvas");
    scratch.getContext("2d", { willReadFrequently: true });
    let bestAngle = 0;
    let bestScore = -1;
    for (let angle = -45; angle < 135; angle += 5) {
      const score = scoreSkewAngle(binary, angle, scratch);
      if (score > bestScore) {
        bestScore = score;
        bestAngle = angle;
      }
    }
    const start = bestAngle - 4;
    const end = bestAngle + 4;
    for (let angle = start; angle <= end; angle += 1) {
      if (angle === bestAngle) continue;
      const score = scoreSkewAngle(binary, angle, scratch);
      if (score > bestScore) {
        bestScore = score;
        bestAngle = angle;
      }
    }
    if (bestScore <= 0) return 0;
    return bestAngle;
  }

  function scoreOcrData(data) {
    const words = (data.words || []).filter((w) => isKeepableToken(w.text, w.confidence ?? 0));
    const avgConf = words.length
      ? words.reduce((sum, w) => sum + (w.confidence || 0), 0) / words.length
      : 0;
    return {
      keepable: words.length,
      avgConf,
      total: words.length * 8 + avgConf,
    };
  }

  async function scoreOcrCanvas(canvas) {
    const worker = await getWorker();
    quietOcr = true;
    try {
      const { data } = await worker.recognize(canvas);
      return scoreOcrData(data);
    } finally {
      quietOcr = false;
    }
  }

  async function chooseReadingAngle(source, lineAngle) {
    const small = makeScaledCanvas(source, FLIP_MAX);
    const upright = rotateCanvas(small, lineAngle);
    const first = await scoreOcrCanvas(upright);
    if (first.keepable >= FLIP_WORDS_OK && first.avgConf >= FLIP_CONF_OK) {
      return { angle: lineAngle, score: first };
    }
    const flipped = rotateCanvas(small, lineAngle + 180);
    const second = await scoreOcrCanvas(flipped);
    if (second.total > first.total) return { angle: lineAngle + 180, score: second };
    return { angle: lineAngle, score: first };
  }

  function rotatedToOrig(rx, ry, srcW, srcH, rotW, rotH, angleRad) {
    const dx = rx - rotW / 2;
    const dy = ry - rotH / 2;
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);
    return {
      x: srcW / 2 + dx * c + dy * s,
      y: srcH / 2 - dx * s + dy * c,
    };
  }

  function mapBoxToOriginal(bbox, srcW, srcH, rotW, rotH, angleRad) {
    const corners = [
      [bbox.x0, bbox.y0],
      [bbox.x1, bbox.y0],
      [bbox.x1, bbox.y1],
      [bbox.x0, bbox.y1],
    ].map(([x, y]) => rotatedToOrig(x, y, srcW, srcH, rotW, rotH, angleRad));
    const p0 = corners[0];
    const p1 = corners[1];
    const p3 = corners[3];
    const width = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const height = Math.hypot(p3.x - p0.x, p3.y - p0.y);
    const cx = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
    const cy = (corners[0].y + corners[1].y + corners[2].y + corners[3].y) / 4;
    const cssAngle = (Math.atan2(p1.y - p0.y, p1.x - p0.x) * 180) / Math.PI;
    return { quad: corners, width, height, cx, cy, cssAngle };
  }

  function wordArea(item) {
    return Math.max(1, (item.width || 0) * (item.height || 0));
  }

  async function recognizeFrame() {
    await commonReady;
    const srcW = frame.width;
    const srcH = frame.height;
    loadingText.textContent = "Finding orientation…";
    const lineAngle = findLineAngle(frame);
    loadingText.textContent = "Checking orientation…";
    const { angle } = await chooseReadingAngle(frame, lineAngle);
    const normalized = ((angle % 360) + 360) % 360;
    const needsRotate = Math.min(normalized, 360 - normalized) >= 0.5;
    const ocrCanvas = needsRotate ? rotateCanvas(frame, angle) : frame;
    const worker = await getWorker();
    const { data } = await worker.recognize(ocrCanvas);
    const rotW = ocrCanvas.width;
    const rotH = ocrCanvas.height;
    const angleRad = (angle * Math.PI) / 180;
    const words = (data.words || [])
      .filter((w) => isKeepableToken(w.text, w.confidence ?? 0))
      .map((w) => {
        const mapped = mapBoxToOriginal(w.bbox, srcW, srcH, rotW, rotH, angleRad);
        const word = normalizeWord(w.text);
        return {
          text: w.text,
          word,
          confidence: w.confidence,
          common: isFilteredOut(word),
          bbox: w.bbox,
          quad: mapped.quad,
          width: mapped.width,
          height: mapped.height,
          cx: mapped.cx,
          cy: mapped.cy,
          angle: mapped.cssAngle,
        };
      });
    lastWords = words;
    lastOrientation = { angle, lineAngle, srcW, srcH, rotW, rotH };
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
    const visible = visibleWords(words);
    boxesEl.innerHTML = "";
    const sorted = visible.slice().sort((a, b) => wordArea(b) - wordArea(a));
    for (const item of sorted) {
      const el = document.createElement("button");
      el.type = "button";
      el.className = "word-box";
      el.style.left = `${((item.cx - item.width / 2) / frame.width) * 100}%`;
      el.style.top = `${((item.cy - item.height / 2) / frame.height) * 100}%`;
      el.style.width = `${(item.width / frame.width) * 100}%`;
      el.style.height = `${(item.height / frame.height) * 100}%`;
      if (Math.abs(item.angle) >= 0.4) {
        el.style.transform = `rotate(${item.angle}deg)`;
      }
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
    return visible;
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
    lastWords = [];
    setMode("frozen");
    hide(shutter);
    show(retake);
    hide(toggleCommon);
    show(controls);
    hide(startEl);

    setLoading(true, "Preparing reader…");
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
      updateToggleLabel();
      show(toggleCommon);
      const visible = renderBoxes(words);
      if (!words.length) {
        showToast("No clear words found. Try sharper text and retake.");
        hide(tapHint);
      } else if (!visible.length) {
        showToast("Common words are hidden. Tap Show all if you need one.");
        hide(tapHint);
      } else {
        show(tapHint);
      }
      return words;
    } catch (err) {
      console.error(err);
      setLoading(false);
      showToast("Couldn’t read the text. Try a clearer shot.");
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
    hide(toggleCommon);
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
  toggleCommon.addEventListener("click", () => setShowAll(!showAll));
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

  updateToggleLabel();

  window.__wordLensTest = {
    normalizeWord,
    isKeepableToken,
    isCommonWord,
    isFilteredOut,
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
    setShowAll,
    getShowAll() {
      return showAll;
    },
    getState() {
      const words = lastWords.map((w) => ({
        word: w.word,
        confidence: w.confidence,
        common: w.common,
        cx: w.cx,
        cy: w.cy,
        width: w.width,
        height: w.height,
        angle: w.angle,
        quad: w.quad,
      }));
      return {
        words,
        visible: visibleWords(lastWords).map((w) => w.word),
        showAll,
        orientation: lastOrientation,
        frame: { width: frame.width, height: frame.height },
        commonCount: commonWords.size,
      };
    },
  };
})();
