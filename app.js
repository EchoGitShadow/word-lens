(() => {
  const CONFIDENCE_LONG = 40;
  const CONFIDENCE_SHORT = 48;
  const SHORT_WORD_MAX = 2;
  const DICTIONARY_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
  const WIKTIONARY_URL = "https://en.wiktionary.org/api/rest_v1/page/definition/";
  const TESSERACT_VERSION = "5.1.1";
  const TESSERACT_CORE = "5.1.1";
  const ANALYZE_MAX = 400;
  const FLIP_MAX = 480;
  const FLIP_CONF_OK = 70;
  const FLIP_WORDS_OK = 4;
  const OCR_MIN_SIDE = 2000;
  const OCR_MAX_SIDE = 2200;
  const DISPLAY_MAX_SIDE = 2500;
  const SHOW_ALL_KEY = "word-lens-show-all";
  const CACHE_KEY = "word-lens-def-cache-v1";
  const CACHE_LIMIT = 80;

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
  const steadyHint = $("steady-hint");
  const toastEl = $("toast");
  const sheet = $("sheet");
  const sheetBackdrop = $("sheet-backdrop");
  const sheetWord = $("sheet-word");
  const sheetPhonetic = $("sheet-phonetic");
  const sheetBody = $("sheet-body");
  const fileInput = $("file");
  const focusReticle = $("focus-reticle");

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
  let reticleTimer = null;
  const lookupCache = new Map();

  try {
    showAll = localStorage.getItem(SHOW_ALL_KEY) === "1";
  } catch (err) {
    showAll = false;
  }

  try {
    const stored = JSON.parse(localStorage.getItem(CACHE_KEY) || "[]");
    if (Array.isArray(stored)) {
      for (const [key, value] of stored) lookupCache.set(key, value);
    }
  } catch (err) {
    // ignore bad cache
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
    if (el) el.hidden = false;
  }

  function hide(el) {
    if (el) el.hidden = true;
  }

  function setMode(mode) {
    document.body.classList.remove("live", "frozen");
    if (mode) document.body.classList.add(mode);
    if (mode === "live") show(steadyHint);
    else hide(steadyHint);
  }

  function showToast(message, ms) {
    toastEl.textContent = message;
    show(toastEl);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => hide(toastEl), ms || 4500);
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

  async function tightenCameraTrack(mediaStream) {
    const track = mediaStream.getVideoTracks()[0];
    if (!track || !track.applyConstraints) return;
    try {
      const caps = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
      const next = {
        width: { ideal: 1920 },
        height: { ideal: 1080 },
      };
      if (caps.width && caps.width.max) next.width.ideal = Math.min(caps.width.max, 1920);
      if (caps.height && caps.height.max) next.height.ideal = Math.min(caps.height.max, 1080);
      if (caps.focusMode && caps.focusMode.includes("continuous")) next.focusMode = "continuous";
      else if (caps.focusMode && caps.focusMode.includes("single-shot")) next.focusMode = "single-shot";
      await track.applyConstraints(next);
    } catch (err) {
      // Some browsers reject optional constraints; the initial stream is still usable.
    }
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
    await tightenCameraTrack(stream);
    preview.srcObject = stream;
    await preview.play();
    await waitForVideoReady();
  }

  function stopCamera() {
    if (stream) {
      for (const track of stream.getTracks()) track.stop();
      stream = null;
    }
    preview.srcObject = null;
  }

  function waitForEvent(el, name, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Camera is not ready yet.")), ms);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      el.addEventListener(name, done, { once: true });
    });
  }

  async function waitForVideoReady() {
    if (!preview.videoWidth || !preview.videoHeight) {
      try {
        await waitForEvent(preview, "loadeddata", 4000);
      } catch (err) {
        if (!preview.videoWidth) throw err;
      }
    }
    if (typeof preview.requestVideoFrameCallback === "function") {
      await new Promise((resolve) => preview.requestVideoFrameCallback(() => resolve()));
    } else {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!preview.videoWidth || !preview.videoHeight) {
      throw new Error("Camera is not ready yet.");
    }
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

  function drawFrameFromVideo() {
    const w = preview.videoWidth;
    const h = preview.videoHeight;
    if (!w || !h) throw new Error("Camera is not ready yet.");
    const scale = Math.min(1, DISPLAY_MAX_SIDE / Math.max(w, h));
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    frame.width = dw;
    frame.height = dh;
    const ctx = frame.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(preview, 0, 0, dw, dh);
  }

  function frameLooksEmpty() {
    const w = frame.width;
    const h = frame.height;
    if (!w || !h) return true;
    const ctx = frame.getContext("2d", { willReadFrequently: true });
    const sample = 6;
    const data = ctx.getImageData(0, 0, w, h).data;
    let lum = 0;
    let count = 0;
    for (let y = 0; y < sample; y += 1) {
      for (let x = 0; x < sample; x += 1) {
        const px = Math.floor(((x + 0.5) / sample) * (w - 1));
        const py = Math.floor(((y + 0.5) / sample) * (h - 1));
        const i = (py * w + px) * 4;
        lum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
        count += 1;
      }
    }
    return lum / count < 6;
  }

  async function captureVideoFrame() {
    await waitForVideoReady();
    drawFrameFromVideo();
    for (let attempt = 0; attempt < 4 && frameLooksEmpty(); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (typeof preview.requestVideoFrameCallback === "function") {
        await new Promise((resolve) => preview.requestVideoFrameCallback(() => resolve()));
      }
      drawFrameFromVideo();
    }
    if (frameLooksEmpty()) throw new Error("The camera frame was empty. Tap Retake and try again.");
  }

  function loadImageFile(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const maxSide = DISPLAY_MAX_SIDE;
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
      .replace(/[\u2018\u2019\u201B\u2032]/g, "'")
      .replace(/[\u201C\u201D\u00AB\u00BB]/g, "")
      .replace(/[\u2010-\u2015\u2212\u00AD]/g, "-")
      .replace(/[^A-Za-z'-]/g, "")
      .replace(/^[ '-]+|[ '-]+$/g, "")
      .toLowerCase();
  }

  function isKeepableToken(raw, confidence) {
    const word = normalizeWord(raw);
    if (!word) return false;
    if (!/^[a-z]+(?:['-][a-z]+)*$/.test(word)) return false;
    const conf = confidence ?? 0;
    if (word.length === 1) return (word === "a" || word === "i") && conf >= CONFIDENCE_LONG;
    if (word.length <= 3) return conf >= CONFIDENCE_SHORT;
    return conf >= CONFIDENCE_LONG;
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

  function doubledConsonantStem(stem) {
    if (stem.length < 3) return "";
    const last = stem[stem.length - 1];
    const prev = stem[stem.length - 2];
    if (last === prev && /[bcdfghjklmnpqrstvwxyz]/.test(last)) return stem.slice(0, -1);
    return "";
  }

  function lemmaCandidates(word) {
    const base = normalizeWord(word);
    const out = [];
    const add = (w) => {
      if (w && /^[a-z]+(?:['-][a-z]+)*$/.test(w) && !out.includes(w)) out.push(w);
    };
    add(base);
    if (!base) return out;
    if (base.endsWith("'s")) add(base.slice(0, -2));
    if (base.endsWith("s'")) add(base.slice(0, -2) + "s");
    if (base.includes("-")) add(base.replace(/-/g, ""));
    if (base.endsWith("ies") && base.length > 4) add(base.slice(0, -3) + "y");
    if (base.endsWith("ves") && base.length > 4) {
      add(base.slice(0, -3) + "f");
      add(base.slice(0, -3) + "fe");
    }
    if (base.endsWith("es") && base.length > 4) add(base.slice(0, -2));
    if (base.endsWith("s") && !base.endsWith("ss") && base.length > 3) add(base.slice(0, -1));
    if (base.endsWith("ing") && base.length > 5) {
      const stem = base.slice(0, -3);
      add(stem);
      add(stem + "e");
      add(doubledConsonantStem(stem));
    }
    if (base.endsWith("ed") && base.length > 4) {
      const stem = base.slice(0, -2);
      add(stem);
      add(stem + "e");
      add(doubledConsonantStem(stem));
    }
    if (base.endsWith("ily") && base.length > 5) add(base.slice(0, -3) + "y");
    else if (base.endsWith("ly") && base.length > 4) add(base.slice(0, -2));
    if (base.endsWith("est") && base.length > 5) {
      const stem = base.slice(0, -3);
      add(stem);
      add(stem + "e");
      add(doubledConsonantStem(stem));
    } else if (base.endsWith("er") && base.length > 4) {
      const stem = base.slice(0, -2);
      add(stem);
      add(stem + "e");
      add(doubledConsonantStem(stem));
    }
    return out;
  }

  async function getWorker() {
    if (!workerPromise) {
      workerPromise = createWorkerWithFallback().catch((err) => {
        workerPromise = null;
        throw err;
      });
    }
    return workerPromise;
  }

  async function createWorkerWithFallback() {
    const cores = [
      `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_CORE}/tesseract-core-simd-lstm.wasm.js`,
      `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_CORE}/tesseract-core-lstm.wasm.js`,
    ];
    let lastErr;
    for (const corePath of cores) {
      try {
        return await Tesseract.createWorker("eng", 1, {
          logger: (m) => {
            if (quietOcr) return;
            if (typeof progressHandler === "function") progressHandler(m);
          },
          workerPath: `https://cdn.jsdelivr.net/npm/tesseract.js@${TESSERACT_VERSION}/dist/worker.min.js`,
          corePath,
          langPath: "https://tessdata.projectnaptha.com/4.0.0",
        });
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr || new Error("Couldn’t start the text reader.");
  }

  async function recognizeSafe(canvas, options) {
    const tryOnce = async () => {
      const worker = await getWorker();
      return worker.recognize(canvas, options || {});
    };
    try {
      return await tryOnce();
    } catch (err) {
      try {
        const old = await workerPromise;
        if (old && old.terminate) await old.terminate();
      } catch (termErr) {
        // ignore
      }
      workerPromise = null;
      return tryOnce();
    }
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
    return { thresh, score: max };
  }

  function histogram(gray) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i += 1) hist[gray[i]] += 1;
    return hist;
  }

  function percentileFromHist(hist, total, p) {
    const target = Math.max(0, Math.min(total - 1, Math.floor(total * p)));
    let seen = 0;
    for (let i = 0; i < 256; i += 1) {
      seen += hist[i];
      if (seen > target) return i;
    }
    return 255;
  }

  function applyGrayWorld(data) {
    let rSum = 0;
    let gSum = 0;
    let bSum = 0;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const y = r * 0.299 + g * 0.587 + b * 0.114;
      if (y > 18 && y < 250) {
        rSum += r;
        gSum += g;
        bSum += b;
        count += 1;
      }
    }
    if (count < 50) return;
    const rMean = rSum / count;
    const gMean = gSum / count;
    const bMean = bSum / count;
    const gray = (rMean + gMean + bMean) / 3;
    const clampGain = (gain) => Math.max(0.45, Math.min(2.4, gain));
    const rGain = clampGain(gray / Math.max(1, rMean));
    const gGain = clampGain(gray / Math.max(1, gMean));
    const bGain = clampGain(gray / Math.max(1, bMean));
    for (let i = 0; i < data.length; i += 4) {
      data[i] = Math.max(0, Math.min(255, (data[i] * rGain) | 0));
      data[i + 1] = Math.max(0, Math.min(255, (data[i + 1] * gGain) | 0));
      data[i + 2] = Math.max(0, Math.min(255, (data[i + 2] * bGain) | 0));
    }
  }

  function stretchChannel(values) {
    const hist = histogram(values);
    const p1 = percentileFromHist(hist, values.length, 0.001);
    const p5 = percentileFromHist(hist, values.length, 0.02);
    const p95 = percentileFromHist(hist, values.length, 0.98);
    const p99 = percentileFromHist(hist, values.length, 0.999);
    let lo = p5;
    let hi = p95;
    // Sparse text on a large page can be well under 2% of pixels, so p5/p95
    // both sit on the paper color and a naive stretch would crush the page to black.
    if (hi - lo < 40) {
      lo = p1;
      hi = Math.max(p99, lo + 16);
    }
    if (hi - lo < 24) return values.slice ? values.slice() : Uint8Array.from(values);
    const span = hi - lo;
    const out = new Uint8Array(values.length);
    for (let i = 0; i < values.length; i += 1) {
      const v = ((values[i] - lo) * 255) / span;
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
    return out;
  }

  function claheGray(gray, width, height, tileSize, clipLimit) {
    const tilesX = Math.max(2, Math.ceil(width / tileSize));
    const tilesY = Math.max(2, Math.ceil(height / tileSize));
    const tileW = width / tilesX;
    const tileH = height / tilesY;
    const maps = [];
    for (let ty = 0; ty < tilesY; ty += 1) {
      for (let tx = 0; tx < tilesX; tx += 1) {
        const x0 = Math.floor(tx * tileW);
        const y0 = Math.floor(ty * tileH);
        const x1 = Math.min(width, Math.floor((tx + 1) * tileW));
        const y1 = Math.min(height, Math.floor((ty + 1) * tileH));
        const hist = new Float64Array(256);
        let count = 0;
        let sum = 0;
        let sumSq = 0;
        for (let y = y0; y < y1; y += 1) {
          const row = y * width;
          for (let x = x0; x < x1; x += 1) {
            const v = gray[row + x];
            hist[v] += 1;
            sum += v;
            sumSq += v * v;
            count += 1;
          }
        }
        const identity = new Uint8Array(256);
        for (let i = 0; i < 256; i += 1) identity[i] = i;
        const mean = count ? sum / count : 0;
        const variance = count ? sumSq / count - mean * mean : 0;
        // Flat paper tiles should not be equalized or they turn into noise.
        if (count < 16 || variance < 40) {
          maps.push(identity);
          continue;
        }
        const clip = Math.max(1, (clipLimit * count) / 256);
        let excess = 0;
        for (let i = 0; i < 256; i += 1) {
          if (hist[i] > clip) {
            excess += hist[i] - clip;
            hist[i] = clip;
          }
        }
        const inc = excess / 256;
        for (let i = 0; i < 256; i += 1) hist[i] += inc;
        const cdf = new Uint8Array(256);
        let acc = 0;
        const scale = 255 / Math.max(1, count);
        for (let i = 0; i < 256; i += 1) {
          acc += hist[i];
          cdf[i] = Math.max(0, Math.min(255, Math.round(acc * scale)));
        }
        maps.push(cdf);
      }
    }
    const out = new Uint8Array(gray.length);
    for (let y = 0; y < height; y += 1) {
      const ty = (y + 0.5) / tileH - 0.5;
      const ty0 = Math.max(0, Math.min(tilesY - 1, Math.floor(ty)));
      const ty1 = Math.max(0, Math.min(tilesY - 1, ty0 + 1));
      const fy = ty0 === ty1 ? 0 : ty - ty0;
      for (let x = 0; x < width; x += 1) {
        const tx = (x + 0.5) / tileW - 0.5;
        const tx0 = Math.max(0, Math.min(tilesX - 1, Math.floor(tx)));
        const tx1 = Math.max(0, Math.min(tilesX - 1, tx0 + 1));
        const fx = tx0 === tx1 ? 0 : tx - tx0;
        const v = gray[y * width + x];
        const a = maps[ty0 * tilesX + tx0][v];
        const b = maps[ty0 * tilesX + tx1][v];
        const c = maps[ty1 * tilesX + tx0][v];
        const d = maps[ty1 * tilesX + tx1][v];
        const top = a * (1 - fx) + b * fx;
        const bot = c * (1 - fx) + d * fx;
        out[y * width + x] = (top * (1 - fy) + bot * fy) | 0;
      }
    }
    return out;
  }

  function grayToCanvas(gray, width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    const img = ctx.createImageData(width, height);
    const data = img.data;
    for (let p = 0, i = 0; p < gray.length; p += 1, i += 4) {
      const v = gray[p];
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  function preprocessForOcr(source) {
    const w = source.width;
    const h = source.height;
    const ctx = source.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    applyGrayWorld(img.data);
    const n = w * h;
    const chR = new Uint8Array(n);
    const chG = new Uint8Array(n);
    const chB = new Uint8Array(n);
    const chL = new Uint8Array(n);
    const chM = new Uint8Array(n);
    const data = img.data;
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      chR[p] = r;
      chG[p] = g;
      chB[p] = b;
      chL[p] = (r * 299 + g * 587 + b * 114) / 1000;
      chM[p] = r < g ? (r < b ? r : b) : g < b ? g : b;
    }
    let best = chL;
    let bestScore = -1;
    for (const channel of [chR, chG, chB, chL, chM]) {
      const stretched = stretchChannel(channel);
      const hist = histogram(stretched);
      const score = otsuThreshold(hist, n).score;
      if (score > bestScore) {
        bestScore = score;
        best = stretched;
      }
    }
    const hist = histogram(best);
    const p10 = percentileFromHist(hist, n, 0.1);
    const p90 = percentileFromHist(hist, n, 0.9);
    const median = percentileFromHist(hist, n, 0.5);
    if (median < 100 && p90 < 150 && p10 < 40) {
      // Dim dark-text photo: stretch already applied; do not invert.
    } else if (median < 90 && p90 > 160) {
      for (let i = 0; i < best.length; i += 1) best[i] = 255 - best[i];
    }
    const contrast = p90 - p10;
    const enhanced = contrast >= 100 ? best : claheGray(best, w, h, 64, 2.0);
    return grayToCanvas(enhanced, w, h);
  }

  function contentBounds(source) {
    const w = source.width;
    const h = source.height;
    const ctx = source.getContext("2d", { willReadFrequently: true });
    const data = ctx.getImageData(0, 0, w, h).data;
    const hist = new Uint32Array(256);
    const gray = new Uint8Array(w * h);
    for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
      const g = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
      const v = g < 0 ? 0 : g > 255 ? 255 : g | 0;
      gray[p] = v;
      hist[v] += 1;
    }
    const thresh = Math.min(220, otsuThreshold(hist, w * h).thresh + 8);
    let minX = w;
    let minY = h;
    let maxX = 0;
    let maxY = 0;
    for (let y = 0; y < h; y += 1) {
      const row = y * w;
      for (let x = 0; x < w; x += 1) {
        if (gray[row + x] < thresh) {
          if (x < minX) minX = x;
          if (y < minY) minY = y;
          if (x > maxX) maxX = x;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX <= minX || maxY <= minY) {
      return { x: 0, y: 0, w, h };
    }
    const padX = Math.max(12, Math.round((maxX - minX) * 0.08));
    const padY = Math.max(12, Math.round((maxY - minY) * 0.08));
    const x = Math.max(0, minX - padX);
    const y = Math.max(0, minY - padY);
    return {
      x,
      y,
      w: Math.min(w - x, maxX - minX + padX * 2),
      h: Math.min(h - y, maxY - minY + padY * 2),
    };
  }

  function prepareOcrSource(source) {
    const bounds = contentBounds(source);
    const contentArea = bounds.w * bounds.h;
    const fullArea = source.width * source.height;
    const cropped = contentArea < fullArea * 0.72;
    const srcW = cropped ? bounds.w : source.width;
    const srcH = cropped ? bounds.h : source.height;
    const longSide = Math.max(srcW, srcH);
    let scale = 1;
    if (longSide < OCR_MIN_SIDE) scale = OCR_MIN_SIDE / longSide;
    else if (longSide > OCR_MAX_SIDE) scale = OCR_MAX_SIDE / longSide;
    const w = Math.max(1, Math.round(srcW * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    if (cropped) {
      ctx.drawImage(source, bounds.x, bounds.y, bounds.w, bounds.h, 0, 0, w, h);
    } else {
      ctx.drawImage(source, 0, 0, w, h);
    }
    return {
      canvas,
      scaleX: w / srcW,
      scaleY: h / srcH,
      offsetX: cropped ? bounds.x : 0,
      offsetY: cropped ? bounds.y : 0,
    };
  }

  function binarizeCanvas(source) {
    const w = source.width;
    const h = source.height;
    const srcCtx = source.getContext("2d", { willReadFrequently: true });
    const img = srcCtx.getImageData(0, 0, w, h);
    const gray = new Uint8Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < img.data.length; i += 4, p += 1) {
      const value = img.data[i];
      gray[p] = value;
      hist[value] += 1;
    }
    const thresh = otsuThreshold(hist, w * h).thresh;
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
    const score0 = scoreSkewAngle(binary, 0, scratch);
    bestScore = score0;
    bestAngle = 0;
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
      if (angle === 0 || angle === bestAngle) continue;
      const score = scoreSkewAngle(binary, angle, scratch);
      if (score > bestScore) {
        bestScore = score;
        bestAngle = angle;
      }
    }
    if (bestScore <= 0) return 0;
    // Ignore uncertain skew so a straight page is not twisted.
    if (Math.abs(bestAngle) <= 3) return 0;
    if (Math.abs(bestAngle) < 50 && bestScore < score0 * 1.28) return 0;
    return bestAngle;
  }

  function scoreOcrData(data) {
    const words = (data.words || []).filter((w) => isKeepableToken(w.text, w.confidence ?? 0));
    const avgConf = words.length
      ? words.reduce((sum, w) => sum + (w.confidence || 0), 0) / words.length
      : 0;
    const longWords = words.filter((w) => normalizeWord(w.text).length >= 5).length;
    return {
      keepable: words.length,
      longWords,
      avgConf,
      total: words.length * 8 + longWords * 6 + avgConf,
    };
  }

  function isWeakScore(score) {
    if (!score) return true;
    if (score.keepable < 4) return true;
    if (score.longWords < 2 && score.keepable < 8) return true;
    if (score.avgConf < 58 && score.keepable < 8) return true;
    return false;
  }

  async function scoreOcrCanvas(canvas) {
    quietOcr = true;
    try {
      const { data } = await recognizeSafe(canvas);
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

  function mapBoxToOriginal(bbox, srcW, srcH, rotW, rotH, angleRad, prepared) {
    const corners = [
      [bbox.x0, bbox.y0],
      [bbox.x1, bbox.y0],
      [bbox.x1, bbox.y1],
      [bbox.x0, bbox.y1],
    ].map(([x, y]) => {
      const p = rotatedToOrig(x, y, srcW, srcH, rotW, rotH, angleRad);
      return {
        x: p.x / prepared.scaleX + prepared.offsetX,
        y: p.y / prepared.scaleY + prepared.offsetY,
      };
    });
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

  function mergeHyphenBreaks(rawWords) {
    const sorted = rawWords.slice().sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0);
    const out = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const cur = sorted[i];
      const text = String(cur.text || "");
      const next = sorted[i + 1];
      if (next && /[-\u00AD\u2010-\u2015]$/.test(text)) {
        const joinedText = text.replace(/[-\u00AD\u2010-\u2015]\s*$/, "") + String(next.text || "");
        out.push({
          text: joinedText,
          confidence: Math.min(cur.confidence ?? 0, next.confidence ?? 0),
          bbox: {
            x0: Math.min(cur.bbox.x0, next.bbox.x0),
            y0: Math.min(cur.bbox.y0, next.bbox.y0),
            x1: Math.max(cur.bbox.x1, next.bbox.x1),
            y1: Math.max(cur.bbox.y1, next.bbox.y1),
          },
        });
        i += 1;
        continue;
      }
      out.push(cur);
    }
    return out;
  }

  function wordsFromData(data, srcW, srcH, rotW, rotH, angle, prepared) {
    const angleRad = (angle * Math.PI) / 180;
    return mergeHyphenBreaks(data.words || [])
      .filter((w) => isKeepableToken(w.text, w.confidence ?? 0))
      .map((w) => {
        const mapped = mapBoxToOriginal(w.bbox, srcW, srcH, rotW, rotH, angleRad, prepared);
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
  }

  async function recognizeAt(processed, angle, psm, prepared) {
    const normalized = ((angle % 360) + 360) % 360;
    const needsRotate = Math.min(normalized, 360 - normalized) >= 0.5;
    const ocrCanvas = needsRotate ? rotateCanvas(processed, angle) : processed;
    const { data } = await recognizeSafe(ocrCanvas, { tessedit_pageseg_mode: String(psm) });
    const score = scoreOcrData(data);
    const words = wordsFromData(data, processed.width, processed.height, ocrCanvas.width, ocrCanvas.height, angle, prepared);
    return { words, score, angle, psm, rotW: ocrCanvas.width, rotH: ocrCanvas.height };
  }

  async function recognizeFrame() {
    await commonReady;
    loadingText.textContent = "Enhancing photo…";
    const prepared = prepareOcrSource(frame);
    const processed = preprocessForOcr(prepared.canvas);
    loadingText.textContent = "Finding orientation…";
    const lineAngle = findLineAngle(processed);
    loadingText.textContent = "Checking orientation…";
    const chosen = await chooseReadingAngle(processed, lineAngle);
    let best = await recognizeAt(processed, chosen.angle, 3, prepared);
    const nearlyZero = Math.min(((chosen.angle % 360) + 360) % 360, 360 - (((chosen.angle % 360) + 360) % 360)) < 0.5;
    if (isWeakScore(best.score) && !nearlyZero) {
      loadingText.textContent = "Trying another read…";
      const zero = await recognizeAt(processed, 0, 3, prepared);
      if (zero.score.total >= best.score.total) best = zero;
    }
    if (isWeakScore(best.score)) {
      loadingText.textContent = "Trying another read…";
      const sparse = await recognizeAt(processed, 0, 11, prepared);
      if (sparse.score.total >= best.score.total) best = sparse;
    }
    if (isWeakScore(best.score) && !nearlyZero) {
      const sparseTilt = await recognizeAt(processed, chosen.angle, 11, prepared);
      if (sparseTilt.score.total > best.score.total) best = sparseTilt;
    }
    if (isWeakScore(best.score)) {
      const block = await recognizeAt(processed, best.angle, 6, prepared);
      if (block.score.total >= best.score.total) best = block;
    }
    lastWords = best.words;
    lastOrientation = {
      angle: best.angle,
      lineAngle,
      psm: best.psm,
      srcW: frame.width,
      srcH: frame.height,
      rotW: best.rotW,
      rotH: best.rotH,
    };
    return best.words;
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
    sheetWord.value = word;
    sheetPhonetic.textContent = "";
    sheetBody.innerHTML = `<p class="pending"><span class="spinner"></span>Looking up definition…</p>`;
    show(sheet);
    requestAnimationFrame(() => sheet.classList.add("open"));
    loadDefinition(word);
  }

  function persistCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify([...lookupCache].slice(-CACHE_LIMIT)));
    } catch (err) {
      // ignore quota
    }
  }

  function cacheGet(word) {
    return lookupCache.get(word) || null;
  }

  function cacheSet(word, payload) {
    lookupCache.set(word, payload);
    persistCache();
  }

  function stripHtml(html) {
    const div = document.createElement("div");
    div.innerHTML = String(html || "");
    return (div.textContent || "").replace(/\s+/g, " ").trim();
  }

  function combineSignals(signal, ms) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    if (signal) {
      if (signal.aborted) ctrl.abort();
      else signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    }
    return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
  }

  async function fetchDictionaryApi(word, signal) {
    const wait = combineSignals(signal, 5000);
    try {
      const res = await fetch(DICTIONARY_URL + encodeURIComponent(word), { signal: wait.signal });
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
      data._source = "dictionary";
      data._queried = word;
      return data;
    } finally {
      wait.clear();
    }
  }

  async function fetchWiktionary(word, signal) {
    const wait = combineSignals(signal, 6000);
    try {
      const res = await fetch(WIKTIONARY_URL + encodeURIComponent(word), {
        signal: wait.signal,
        headers: { Accept: "application/json" },
      });
      if (res.status === 404) {
        const err = new Error("not found");
        err.code = "not_found";
        throw err;
      }
      if (!res.ok) throw new Error(`Wiktionary error ${res.status}`);
      const data = await res.json();
      const entries = data && Array.isArray(data.en) ? data.en : [];
      const meanings = [];
      for (const entry of entries) {
        const defs = (entry.definitions || [])
          .map((d) => stripHtml(d.definition))
          .filter((text) => text && text.length > 1)
          .slice(0, 3);
        if (!defs.length) continue;
        meanings.push({
          partOfSpeech: entry.partOfSpeech || "",
          definitions: defs.map((definition) => ({ definition })),
        });
        if (meanings.length >= 3) break;
      }
      if (!meanings.length) {
        const err = new Error("not found");
        err.code = "not_found";
        throw err;
      }
      const result = [{ word, phonetic: "", meanings }];
      result._source = "wiktionary";
      result._queried = word;
      return result;
    } finally {
      wait.clear();
    }
  }

  async function lookupOne(word, signal) {
    const cached = cacheGet(word);
    if (cached) return cached;
    try {
      const data = await fetchDictionaryApi(word, signal);
      cacheSet(word, data);
      return data;
    } catch (err) {
      if (err && err.name === "AbortError") throw err;
      if (err && err.code === "not_found") {
        try {
          const data = await fetchWiktionary(word, signal);
          cacheSet(word, data);
          return data;
        } catch (wikiErr) {
          if (wikiErr && wikiErr.name === "AbortError") throw wikiErr;
          throw err.code === "not_found" && wikiErr && wikiErr.code === "not_found" ? wikiErr : wikiErr || err;
        }
      }
      // Network or 5xx: still try Wiktionary.
      const data = await fetchWiktionary(word, signal);
      cacheSet(word, data);
      return data;
    }
  }

  async function fetchDefinition(word, signal) {
    const candidates = lemmaCandidates(word);
    if (!candidates.length) {
      const err = new Error("not found");
      err.code = "not_found";
      throw err;
    }
    let lastErr = null;
    for (const candidate of candidates) {
      try {
        return await lookupOne(candidate, signal);
      } catch (err) {
        if (err && err.name === "AbortError") throw err;
        lastErr = err;
      }
    }
    throw lastErr || new Error("not found");
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
        sheetBody.innerHTML = `<p class="empty">No definition found for “${escapeHtml(normalizeWord(word) || word)}.” You can edit the word above and try again.</p>`;
        return;
      }
      sheetBody.innerHTML = `<p class="empty">Couldn’t reach the dictionary. Check your connection and try again, or edit the word above.</p>`;
    }
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
      sheetBody.innerHTML = `<p class="empty">No definition found for “${escapeHtml(normalizeWord(word) || word)}.” You can edit the word above and try again.</p>`;
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

  function searchEditedWord() {
    const word = normalizeWord(sheetWord.value);
    if (!word) return;
    sheetWord.value = word;
    sheetPhonetic.textContent = "";
    sheetBody.innerHTML = `<p class="pending"><span class="spinner"></span>Looking up definition…</p>`;
    loadDefinition(word);
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
        showToast("No text found, try moving closer, better light.");
        hide(tapHint);
      } else if (!visible.length) {
        showToast("Only common words found, tap Show all.");
        hide(tapHint);
      } else {
        show(tapHint);
      }
      return words;
    } catch (err) {
      console.error(err);
      setLoading(false);
      showToast("Couldn’t read the text. Tap Retake to try again.");
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
      await captureVideoFrame();
      await runOcrFlow();
    } catch (err) {
      console.error(err);
      if (!loadingEl.hidden) setLoading(false);
      if (err && /empty|not ready/i.test(err.message || "")) {
        showToast(err.message);
      }
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

  async function onTapToFocus(ev) {
    if (!document.body.classList.contains("live")) return;
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    if (!track || !track.applyConstraints) return;
    const rect = preview.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = (ev.clientX - rect.left) / rect.width;
    const y = (ev.clientY - rect.top) / rect.height;
    if (x < 0 || y < 0 || x > 1 || y > 1) return;
    if (focusReticle) {
      focusReticle.style.left = `${ev.clientX}px`;
      focusReticle.style.top = `${ev.clientY}px`;
      focusReticle.classList.add("show");
      clearTimeout(reticleTimer);
      reticleTimer = setTimeout(() => focusReticle.classList.remove("show"), 600);
    }
    try {
      await track.applyConstraints({
        advanced: [{ pointsOfInterest: [{ x, y }] }],
      });
    } catch (err) {
      // iOS may ignore point-of-interest focus; tapping still gives a visual cue.
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
  sheetWord.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      searchEditedWord();
    }
  });
  sheetWord.addEventListener("change", searchEditedWord);
  $("stage").addEventListener("click", onTapToFocus);
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
    lemmaCandidates,
    async recognizeImageBlob(blob) {
      const file = blob instanceof File ? blob : new File([blob], "sample.png", { type: blob.type || "image/png" });
      await loadImageFile(file);
      return runOcrFlow();
    },
    async lookup(word) {
      return fetchDefinition(word);
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
