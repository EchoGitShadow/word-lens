(() => {
  const CONFIDENCE_LONG = 40;
  const CONFIDENCE_SHORT = 48;
  const SHORT_WORD_MAX = 2;
  const DICTIONARY_URL = "https://api.dictionaryapi.dev/api/v2/entries/en/";
  const WIKTIONARY_URL = "https://en.wiktionary.org/api/rest_v1/page/definition/";
  const DATAMUSE_URL = "https://api.datamuse.com/words?sp=";
  const DICT_DIR = "./dict/";
  const POS_LABEL = { n: "noun", v: "verb", a: "adjective", r: "adverb", adj: "adjective", adv: "adverb" };
  const TESSERACT_VERSION = "5.1.1";
  const TESSERACT_CORE = "5.1.1";
  const ANALYZE_MAX = 400;
  const FLIP_MAX = 480;
  const FLIP_CONF_OK = 70;
  const FLIP_WORDS_OK = 4;
  const OCR_MIN_SIDE = 2000;
  const OCR_MAX_SIDE = 2200;
  const DISPLAY_MAX_SIDE = 3840;
  const CAPTURE_MAX_SIDE = 3840;
  const SHOW_ALL_KEY = "word-lens-show-all";
  const MODE_KEY = "word-lens-mode";
  const CACHE_KEY = "word-lens-def-cache-v2";
  const CACHE_LIMIT = 80;
  const TARGET_CAP_HEIGHT = 30;
  const CAP_HEIGHT_MAX = 60;
  const PRONUNCIATION_MS = 4000;
  const WIKTIONARY_API = "https://en.wiktionary.org/w/api.php";

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
  const sheetSpeak = $("sheet-speak");
  const sheetBody = $("sheet-body");
  const fileInput = $("file");
  const focusReticle = $("focus-reticle");
  const liveReticle = $("live-reticle");
  const livePill = $("live-pill");
  const liveWordEl = $("live-word");
  const liveDefEl = $("live-def");
  const modeToggle = $("mode-toggle");
  const modePhotoBtn = $("mode-photo");
  const modeLiveBtn = $("mode-live");
  const distanceHint = $("distance-hint");

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
  const letterCache = new Map();
  let pronunciation = { word: "", audioUrl: "", phonetic: "", abort: null, preloaded: null };
  let speakPlayer = null;
  const knownWords = new Set();
  let knownReady = Promise.resolve();
  let scanMode = "photo";
  let liveWorkerPromise = null;
  let liveTimer = null;
  let liveBusy = false;
  let liveStable = { word: "", count: 0 };
  let liveLineHeight = 0;
  let lastLiveResult = null;

  try {
    showAll = localStorage.getItem(SHOW_ALL_KEY) === "1";
  } catch (err) {
    showAll = false;
  }

  try {
    scanMode = localStorage.getItem(MODE_KEY) === "live" ? "live" : "photo";
  } catch (err) {
    scanMode = "photo";
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
    applyScanModeUi();
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

  function scoreCameraLabel(label) {
    const l = String(label || "").toLowerCase().trim();
    if (!l) return 0;
    if (/front|user|selfie|true.?depth|continuity/.test(l)) return -50;
    if (/ultra\s*wide/.test(l)) return -20;
    if (/tele(photo)?/.test(l)) return 5;
    if (/dual|triple|desk\s*view/.test(l)) return -10;
    if (l === "back camera") return 40;
    if (/\bback camera\b/.test(l) && !/dual|triple|ultra|tele/.test(l.replace("back camera", ""))) return 35;
    if (/back/.test(l) && /camera/.test(l) && !/dual|triple|ultra|front/.test(l)) return 20;
    return 0;
  }

  async function preferBackWideDevice() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return null;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videos = devices.filter((d) => d && d.kind === "videoinput" && d.deviceId);
      let best = null;
      let bestScore = 0;
      for (const device of videos) {
        const score = scoreCameraLabel(device.label);
        if (score > bestScore) {
          bestScore = score;
          best = device;
        }
      }
      return bestScore >= 20 ? best : null;
    } catch (err) {
      return null;
    }
  }

  function cameraConstraints(deviceId) {
    const video = {
      width: { ideal: 3840 },
      height: { ideal: 2160 },
    };
    if (deviceId) video.deviceId = { exact: deviceId };
    else video.facingMode = { ideal: "environment" };
    return { audio: false, video };
  }

  async function tightenCameraTrack(mediaStream) {
    const track = mediaStream.getVideoTracks()[0];
    if (!track || !track.applyConstraints) return;
    try {
      const caps = typeof track.getCapabilities === "function" ? track.getCapabilities() : {};
      const next = {
        width: { ideal: 3840 },
        height: { ideal: 2160 },
      };
      if (caps.width && caps.width.max) next.width.ideal = Math.min(caps.width.max, CAPTURE_MAX_SIDE);
      if (caps.height && caps.height.max) next.height.ideal = Math.min(caps.height.max, CAPTURE_MAX_SIDE);
      if (caps.focusMode && caps.focusMode.includes("continuous")) next.focusMode = "continuous";
      else if (caps.focusMode && caps.focusMode.includes("single-shot")) next.focusMode = "single-shot";
      await track.applyConstraints(next);
    } catch (err) {
      // Some browsers reject optional constraints; the initial stream is still usable.
    }
  }

  async function startCamera() {
    stopCamera();
    let preferred = null;
    try {
      preferred = await preferBackWideDevice();
    } catch (err) {
      preferred = null;
    }
    const openStream = async (deviceId) => {
      try {
        return await navigator.mediaDevices.getUserMedia(cameraConstraints(deviceId));
      } catch (err) {
        if (err && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
          if (deviceId) return navigator.mediaDevices.getUserMedia(cameraConstraints(null));
          return navigator.mediaDevices.getUserMedia({
            audio: false,
            video: { facingMode: "environment" },
          });
        }
        throw err;
      }
    };
    try {
      stream = await openStream(preferred && preferred.deviceId);
    } catch (err) {
      throw err;
    }
    // After the first permission grant, iOS fills in device labels. Switch
    // to the physical 1x wide camera if the virtual multi-cam was chosen.
    if (!preferred) {
      const found = await preferBackWideDevice();
      if (found && found.deviceId) {
        const currentId = stream.getVideoTracks()[0] && stream.getVideoTracks()[0].getSettings
          ? stream.getVideoTracks()[0].getSettings().deviceId
          : "";
        if (currentId !== found.deviceId) {
          try {
            const locked = await openStream(found.deviceId);
            for (const track of stream.getTracks()) track.stop();
            stream = locked;
          } catch (err) {
            // Keep the stream we already have.
          }
        }
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

  function drawBitmapToFrame(image) {
    const w = image.videoWidth || image.naturalWidth || image.width;
    const h = image.videoHeight || image.naturalHeight || image.height;
    if (!w || !h) throw new Error("Camera is not ready yet.");
    const scale = Math.min(1, CAPTURE_MAX_SIDE / Math.max(w, h));
    const dw = Math.max(1, Math.round(w * scale));
    const dh = Math.max(1, Math.round(h * scale));
    frame.width = dw;
    frame.height = dh;
    const ctx = frame.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, dw, dh);
  }

  function drawFrameFromVideo() {
    drawBitmapToFrame(preview);
  }

  async function captureStillFromTrack(track) {
    if (!track || typeof ImageCapture !== "function") return false;
    try {
      const ic = new ImageCapture(track);
      if (typeof ic.takePhoto === "function") {
        try {
          const blob = await ic.takePhoto();
          const bitmap = await createImageBitmap(blob);
          drawBitmapToFrame(bitmap);
          if (typeof bitmap.close === "function") bitmap.close();
          if (!frameLooksEmpty()) return true;
        } catch (err) {
          // takePhoto is often blocked while the live preview owns the track.
        }
      }
      if (typeof ic.grabFrame === "function") {
        const bitmap = await ic.grabFrame();
        drawBitmapToFrame(bitmap);
        if (typeof bitmap.close === "function") bitmap.close();
        return !frameLooksEmpty();
      }
    } catch (err) {
      // Safari and many iPhones do not support ImageCapture.
    }
    return false;
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
    const track = stream && stream.getVideoTracks()[0];
    if (await captureStillFromTrack(track)) return;
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
        const maxSide = CAPTURE_MAX_SIDE;
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

  function isKnownWord(word) {
    if (!word) return false;
    if (knownWords.has(word) || commonWords.has(word)) return true;
    const lemmas = lemmaCandidates(word);
    for (let i = 0; i < lemmas.length; i += 1) {
      const lemma = lemmas[i];
      if (knownWords.has(lemma) || commonWords.has(lemma)) return true;
    }
    return false;
  }

  function isKeepableToken(raw, confidence) {
    const word = normalizeWord(raw);
    if (!word) return false;
    if (!/^[a-z]+(?:['-][a-z]+)*$/.test(word)) return false;
    const conf = confidence ?? 0;
    const known = isKnownWord(word);
    if (word.length === 1) {
      if (word !== "a" && word !== "i") return false;
      return known ? conf >= 28 : conf >= CONFIDENCE_LONG;
    }
    if (known) return conf >= (word.length <= 3 ? 28 : 22);
    if (word.length <= 3) return conf >= 52;
    return conf >= 50;
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

  if (window.speechSynthesis && typeof window.speechSynthesis.getVoices === "function") {
    window.speechSynthesis.getVoices();
  }
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
    if (base.endsWith("iness") && base.length > 6) add(base.slice(0, -5) + "y");
    else if (base.endsWith("ness") && base.length > 5) add(base.slice(0, -4));
    if (base.endsWith("isms") && base.length > 6) add(base.slice(0, -1));
    if (base.endsWith("ism") && base.length > 5) add(base.slice(0, -3));
    if (base.endsWith("ities") && base.length > 6) add(base.slice(0, -3) + "y");
    else if (base.endsWith("ity") && base.length > 5) add(base.slice(0, -3));
    if (base.endsWith("ment") && base.length > 6) add(base.slice(0, -4));
    if (base.endsWith("ship") && base.length > 6) add(base.slice(0, -4));
    if (base.endsWith("hood") && base.length > 6) add(base.slice(0, -4));
    if (base.endsWith("ance") && base.length > 6) add(base.slice(0, -4));
    if (base.endsWith("ence") && base.length > 6) add(base.slice(0, -4));
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

  async function getLiveWorker() {
    if (!liveWorkerPromise) {
      liveWorkerPromise = createWorkerWithFallback(true).catch((err) => {
        liveWorkerPromise = null;
        throw err;
      });
    }
    return liveWorkerPromise;
  }

  async function createWorkerWithFallback(alwaysQuiet) {
    const cores = [
      `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_CORE}/tesseract-core-simd-lstm.wasm.js`,
      `https://cdn.jsdelivr.net/npm/tesseract.js-core@${TESSERACT_CORE}/tesseract-core-lstm.wasm.js`,
    ];
    let lastErr;
    for (const corePath of cores) {
      try {
        return await Tesseract.createWorker("eng", 1, {
          logger: (m) => {
            if (alwaysQuiet || quietOcr) return;
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

  function blurGrayLarge(gray, w, h) {
    const src = grayToCanvas(gray, w, h);
    const smallW = Math.max(16, Math.round(w / 24));
    const smallH = Math.max(16, Math.round(h / 24));
    const small = document.createElement("canvas");
    small.width = smallW;
    small.height = smallH;
    const sctx = small.getContext("2d");
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = "high";
    sctx.drawImage(src, 0, 0, smallW, smallH);
    const big = document.createElement("canvas");
    big.width = w;
    big.height = h;
    const bctx = big.getContext("2d", { willReadFrequently: true });
    bctx.imageSmoothingEnabled = true;
    bctx.imageSmoothingQuality = "high";
    bctx.drawImage(small, 0, 0, w, h);
    const data = bctx.getImageData(0, 0, w, h).data;
    const out = new Uint8Array(w * h);
    for (let p = 0, i = 0; p < out.length; p += 1, i += 4) out[p] = data[i];
    return out;
  }

  function flattenGray(gray, illumination) {
    const out = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i += 1) {
      const b = illumination[i] < 8 ? 8 : illumination[i];
      const v = (gray[i] * 230) / b;
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v | 0;
    }
    return out;
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
    const illumination = blurGrayLarge(chL, w, h);
    const illumHist = histogram(illumination);
    const illumSpread = percentileFromHist(illumHist, n, 0.9) - percentileFromHist(illumHist, n, 0.1);
    const flatten = illumSpread >= 40;
    let best = chL;
    let bestScore = -1;
    for (const channel of [chR, chG, chB, chL, chM]) {
      const prepared = flatten ? flattenGray(channel, illumination) : channel;
      const stretched = stretchChannel(prepared);
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

  function unsharpCanvas(source, amount) {
    const strength = amount == null ? 0.4 : amount;
    if (strength <= 0) return source;
    const w = source.width;
    const h = source.height;
    const ctx = source.getContext("2d", { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    const srcData = img.data;
    const blur = new Uint8Array(w * h);
    for (let y = 0; y < h; y += 1) {
      const y0 = y > 0 ? y - 1 : y;
      const y1 = y + 1 < h ? y + 1 : y;
      for (let x = 0; x < w; x += 1) {
        const x0 = x > 0 ? x - 1 : x;
        const x1 = x + 1 < w ? x + 1 : x;
        let sum = 0;
        let n = 0;
        for (let yy = y0; yy <= y1; yy += 1) {
          for (let xx = x0; xx <= x1; xx += 1) {
            sum += srcData[(yy * w + xx) * 4];
            n += 1;
          }
        }
        blur[y * w + x] = (sum / n) | 0;
      }
    }
    for (let px = 0, i = 0; px < blur.length; px += 1, i += 4) {
      const v = srcData[i] + strength * (srcData[i] - blur[px]);
      const c = v < 0 ? 0 : v > 255 ? 255 : v | 0;
      srcData[i] = c;
      srcData[i + 1] = c;
      srcData[i + 2] = c;
    }
    ctx.putImageData(img, 0, 0);
    return source;
  }

  function medianOdd(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    return sorted[sorted.length >> 1];
  }

  function estimateTextMetrics(source) {
    const maxSide = 1000;
    const inv = Math.min(1, maxSide / Math.max(source.width, source.height));
    const w = Math.max(1, Math.round(source.width * inv));
    const h = Math.max(1, Math.round(source.height * inv));
    const tmp = document.createElement("canvas");
    tmp.width = w;
    tmp.height = h;
    const ctx = tmp.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const gray = new Uint8Array(w * h);
    const hist = new Uint32Array(256);
    for (let i = 0, px = 0; i < data.length; i += 4, px += 1) {
      const v = data[i];
      gray[px] = v;
      hist[v] += 1;
    }
    const thresh = otsuThreshold(hist, w * h).thresh;
    const inkA = new Uint8Array(w * h);
    const inkB = new Uint8Array(w * h);
    let nA = 0;
    let nB = 0;
    for (let px = 0; px < gray.length; px += 1) {
      if (gray[px] < thresh) {
        inkA[px] = 1;
        nA += 1;
      } else {
        inkB[px] = 1;
        nB += 1;
      }
    }
    const total = w * h;
    const fracA = nA / total;
    const fracB = nB / total;
    const preferA = Math.abs(fracA - 0.06) <= Math.abs(fracB - 0.06) ? fracA < 0.45 : fracA < fracB;
    const ink = preferA ? inkA : inkB;
    const inkFrac = preferA ? fracA : fracB;

    const row = new Float64Array(h);
    for (let y = 0; y < h; y += 1) {
      let sum = 0;
      const off = y * w;
      for (let x = 0; x < w; x += 1) sum += ink[off + x];
      row[y] = sum;
    }
    const nonzero = [];
    for (let y = 0; y < h; y += 1) if (row[y] > 0) nonzero.push(row[y]);
    const cut = Math.max(2, (nonzero.length ? medianOdd(nonzero) : 0) * 0.18);

    const runs = [];
    let inRun = false;
    let start = 0;
    for (let y = 0; y < h; y += 1) {
      if (row[y] >= cut && !inRun) {
        inRun = true;
        start = y;
      } else if (row[y] < cut && inRun) {
        inRun = false;
        runs.push(y - start);
      }
    }
    if (inRun) runs.push(h - start);
    let lineHeights = runs.filter((v) => v >= 6 && v <= h * 0.22);
    if (lineHeights.length >= 4) {
      const sorted = lineHeights.slice().sort((a, b) => a - b);
      const q1 = sorted[Math.floor(sorted.length * 0.25)];
      const q3 = sorted[Math.floor(sorted.length * 0.75)] || q1;
      const iqr = Math.max(3, q3 - q1);
      const tight = lineHeights.filter((v) => v >= q1 - iqr && v <= q3 + iqr);
      if (tight.length >= 3) lineHeights = tight;
    } else if (lineHeights.length >= 2) {
      const med = medianOdd(lineHeights);
      lineHeights = lineHeights.filter((v) => v >= med * 0.55 && v <= med * 1.8);
    }

    if (!lineHeights.length) return { capHeight: 0, lineCount: 0, inkFrac };
    return { capHeight: medianOdd(lineHeights) / inv, lineCount: lineHeights.length, inkFrac };
  }

  function withPreparedScale(prepared, factor) {
    if (!factor || Math.abs(factor - 1) < 0.02) return prepared;
    const w = Math.max(1, Math.round(prepared.canvas.width * factor));
    const h = Math.max(1, Math.round(prepared.canvas.height * factor));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(prepared.canvas, 0, 0, w, h);
    return {
      canvas,
      scaleX: prepared.scaleX * (w / prepared.canvas.width),
      scaleY: prepared.scaleY * (h / prepared.canvas.height),
      offsetX: prepared.offsetX,
      offsetY: prepared.offsetY,
    };
  }

  function scaleFactorsForCap(prepared, capHeight, lineCount) {
    const factors = [1];
    // A many-line page is not a close-up; a wild cap estimate is usually merged lines.
    if ((lineCount || 0) >= 8) return factors;
    if (!capHeight || capHeight <= CAP_HEIGHT_MAX) return factors;
    const longSide = Math.max(prepared.canvas.width, prepared.canvas.height);
    let factor = TARGET_CAP_HEIGHT / capHeight;
    if (longSide * factor < 480) factor = 480 / longSide;
    if (capHeight * factor > 45) {
      factor = TARGET_CAP_HEIGHT / capHeight;
      if (longSide * factor < 320) factor = 320 / longSide;
    }
    if (factor > 0.98) return factors;
    if (factor < 0.12) factor = 0.12;
    factors.unshift(Math.round(factor * 1000) / 1000);
    return factors;
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

  function cropCanvas(source, rect) {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, rect.w);
    canvas.height = Math.max(1, rect.h);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
    return canvas;
  }

  function bandRects(width, height, bands, overlap) {
    const count = Math.max(2, bands);
    const frac = overlap == null ? 0.28 : overlap;
    const denom = count - (count - 1) * frac;
    const bh = Math.ceil(height / denom);
    const step = Math.max(1, Math.round(bh * (1 - frac)));
    const rects = [];
    let y = 0;
    for (let i = 0; i < count; i += 1) {
      const y0 = Math.min(y, Math.max(0, height - bh));
      const h = Math.min(height - y0, bh);
      rects.push({ x: 0, y: y0, w: width, h });
      y += step;
    }
    const last = rects[rects.length - 1];
    if (last && last.y + last.h < height) {
      last.h = height - last.y;
    }
    return rects;
  }

  function boxIoU(a, b) {
    const ax0 = a.cx - a.width / 2;
    const ay0 = a.cy - a.height / 2;
    const ax1 = a.cx + a.width / 2;
    const ay1 = a.cy + a.height / 2;
    const bx0 = b.cx - b.width / 2;
    const by0 = b.cy - b.height / 2;
    const bx1 = b.cx + b.width / 2;
    const by1 = b.cy + b.height / 2;
    const ix0 = Math.max(ax0, bx0);
    const iy0 = Math.max(ay0, by0);
    const ix1 = Math.min(ax1, bx1);
    const iy1 = Math.min(ay1, by1);
    const iw = Math.max(0, ix1 - ix0);
    const ih = Math.max(0, iy1 - iy0);
    const inter = iw * ih;
    const union = Math.max(1, a.width * a.height + b.width * b.height - inter);
    return inter / union;
  }

  function mergeWordLists(lists) {
    const all = lists.flat().sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    const kept = [];
    for (const word of all) {
      const hit = kept.find((other) => {
        if (boxIoU(word, other) >= 0.4) return true;
        if (word.word === other.word) {
          const dist = Math.hypot(word.cx - other.cx, word.cy - other.cy);
          return dist < Math.max(word.width, other.width, 8) * 0.7;
        }
        return false;
      });
      if (!hit) kept.push(word);
    }
    return kept;
  }

  function scoreWords(words) {
    const keepable = words.length;
    const avgConf = keepable
      ? words.reduce((sum, w) => sum + (w.confidence || 0), 0) / keepable
      : 0;
    const longWords = words.filter((w) => (w.word || "").length >= 5).length;
    return {
      keepable,
      longWords,
      avgConf,
      total: keepable * 8 + longWords * 6 + avgConf,
    };
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

  async function recognizeBand(processed, rect, prepared) {
    const slice = cropCanvas(processed, rect);
    let angle = findLineAngle(slice);
    if (Math.abs(angle) > 15) angle = 0;
    if (Math.abs(angle) < 1.5) angle = 0;
    const bandPrepared = {
      canvas: slice,
      scaleX: prepared.scaleX,
      scaleY: prepared.scaleY,
      offsetX: prepared.offsetX + rect.x / prepared.scaleX,
      offsetY: prepared.offsetY + rect.y / prepared.scaleY,
    };
    return recognizeAt(slice, angle, 6, bandPrepared);
  }

  async function recognizeInBands(processed, prepared) {
    const rects = bandRects(processed.width, processed.height, 3, 0.3);
    const groups = [];
    for (let i = 0; i < rects.length; i += 1) {
      loadingText.textContent = `Reading words… ${i + 1}/${rects.length}`;
      const result = await recognizeBand(processed, rects[i], prepared);
      groups.push(result.words);
    }
    const words = mergeWordLists(groups);
    const score = scoreWords(words);
    return { words, score, angle: 0, psm: 6, rotW: processed.width, rotH: processed.height, scale: 1, bands: rects.length };
  }

  async function recognizeFrame() {
    await commonReady;
    try {
      await Promise.race([knownReady, new Promise((resolve) => setTimeout(resolve, 1200))]);
    } catch (err) {
      // proceed with whatever of the word list has loaded
    }
    loadingText.textContent = "Enhancing photo…";
    const base = prepareOcrSource(frame);
    // Estimate lines and skew on the unflattened page. Shadow flattening
    // evens the paper so much that a global threshold can merge every line.
    const metrics = estimateTextMetrics(base.canvas);
    const cap = metrics.capHeight || 0;
    const densePage = (metrics.lineCount || 0) >= 8
      || (cap > 0 && cap <= CAP_HEIGHT_MAX
        && frame.height > frame.width * 1.15
        && Math.max(frame.width, frame.height) >= 1000);
    const factors = scaleFactorsForCap(base, metrics.capHeight, metrics.lineCount);
    const closeUp = !densePage && metrics.capHeight > CAP_HEIGHT_MAX;
    const prepared = withPreparedScale(base, factors[0]);
    const processed = unsharpCanvas(preprocessForOcr(prepared.canvas));
    loadingText.textContent = "Finding orientation…";
    const rawLineAngle = findLineAngle(prepared.canvas);
    const folded = ((rawLineAngle % 180) + 180) % 180;
    const nearCardinal90 = Math.abs(folded - 90) <= 18;
    const nearUpright = Math.min(folded, 180 - folded) < 3;
    // Ignore messy mid-range skew on curved book pages, but keep 90° turns.
    const lineAngle = densePage && !nearUpright && !nearCardinal90 ? 0 : rawLineAngle;
    let chosen;
    if (densePage && nearUpright && !nearCardinal90) {
      chosen = { angle: 0 };
    } else {
      loadingText.textContent = "Checking orientation…";
      chosen = await chooseReadingAngle(processed, lineAngle);
    }

    let best;
    if (densePage && !nearCardinal90) {
      loadingText.textContent = "Reading words…";
      best = await recognizeInBands(processed, prepared);
      best.scale = 1;
      if (isWeakScore(best.score)) {
        const full = await recognizeAt(processed, chosen.angle, 6, prepared);
        full.scale = 1;
        if (full.score.total > best.score.total) best = full;
      }
    } else {
      const firstPsm = closeUp ? 6 : 3;
      best = await recognizeAt(processed, chosen.angle, firstPsm, prepared);
      best.scale = factors[0];
      const nearlyZero = Math.min(((chosen.angle % 360) + 360) % 360, 360 - (((chosen.angle % 360) + 360) % 360)) < 0.5;
      if (isWeakScore(best.score) && !nearlyZero) {
        loadingText.textContent = "Trying another read…";
        const zero = await recognizeAt(processed, 0, firstPsm, prepared);
        if (zero.score.total >= best.score.total) {
          best = zero;
          best.scale = factors[0];
        }
      }
      if (isWeakScore(best.score)) {
        loadingText.textContent = "Trying another read…";
        const sparse = await recognizeAt(processed, 0, 11, prepared);
        if (sparse.score.total >= best.score.total) {
          best = sparse;
          best.scale = factors[0];
        }
      }
      if (isWeakScore(best.score) && !nearlyZero) {
        const sparseTilt = await recognizeAt(processed, chosen.angle, 11, prepared);
        if (sparseTilt.score.total > best.score.total) {
          best = sparseTilt;
          best.scale = factors[0];
        }
      }
      if (isWeakScore(best.score)) {
        const nextPsm = firstPsm === 6 ? 3 : 6;
        const block = await recognizeAt(processed, best.angle, nextPsm, prepared);
        if (block.score.total >= best.score.total) {
          best = block;
          best.scale = factors[0];
        }
      }
      if (isWeakScore(best.score) && factors.length > 1) {
        loadingText.textContent = "Trying another scale…";
        for (const factor of factors.slice(1)) {
          const prep = withPreparedScale(base, factor);
          const proc = unsharpCanvas(preprocessForOcr(prep.canvas));
          const psms = closeUp ? [6, 11, 3] : [3, 11, 6];
          for (const psm of psms) {
            const attempt = await recognizeAt(proc, chosen.angle, psm, prep);
            attempt.scale = factor;
            if (attempt.score.total > best.score.total) best = attempt;
            if (!isWeakScore(best.score)) break;
          }
          if (!isWeakScore(best.score)) break;
        }
      }
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
      capHeight: Math.round(metrics.capHeight || 0),
      scale: best.scale || factors[0],
      lineCount: metrics.lineCount || 0,
      bands: best.bands || 0,
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
    stopPronunciation();
    if (pronunciation.abort) {
      pronunciation.abort.abort();
      pronunciation.abort = null;
    }
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
    stopPronunciation();
    sheetWord.value = word;
    sheetPhonetic.textContent = "";
    sheetBody.innerHTML = `<p class="pending"><span class="spinner"></span>Looking up definition…</p>`;
    show(sheet);
    requestAnimationFrame(() => sheet.classList.add("open"));
    startPronunciationPrefetch(word);
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

  function notFoundError() {
    const err = new Error("not found");
    err.code = "not_found";
    return err;
  }

  function isUserAbort(err, signal) {
    return Boolean(err && err.name === "AbortError" && signal && signal.aborted);
  }

  function cleanDefinitionText(text) {
    return String(text || "")
      .replace(/\.mw-parser-output[\s\S]*$/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function stripHtml(html) {
    const div = document.createElement("div");
    div.innerHTML = String(html || "");
    return cleanDefinitionText(div.textContent || "");
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

  function tagEntries(entries, original, queried, source) {
    entries._source = source || entries._source || "";
    entries._queried = queried;
    entries._from = queried && queried !== original ? queried : "";
    return entries;
  }

  async function loadLetterDict(letter) {
    if (!letter) return {};
    if (letterCache.has(letter)) return letterCache.get(letter);
    const pending = fetch(DICT_DIR + encodeURIComponent(letter) + ".json")
      .then((res) => (res.ok ? res.json() : {}))
      .catch(() => ({}));
    letterCache.set(letter, pending);
    const data = await pending;
    letterCache.set(letter, data);
    return data;
  }

  function startKnownWordsLoad() {
    knownReady = Promise.all(
      "abcdefghijklmnopqrstuvwxyz".split("").map(async (letter) => {
        const data = await loadLetterDict(letter);
        for (const key of Object.keys(data || {})) knownWords.add(key);
      })
    ).catch(() => {});
  }

  function localToEntries(word, rec) {
    if (!rec || !rec.length) return null;
    const meanings = [];
    for (const item of rec) {
      const pos = POS_LABEL[item[0]] || item[0] || "";
      const definition = cleanDefinitionText(item[1]);
      if (!definition) continue;
      const existing = meanings.find((m) => m.partOfSpeech === pos);
      if (existing) {
        if (existing.definitions.length < 3) existing.definitions.push({ definition });
      } else {
        meanings.push({ partOfSpeech: pos, definitions: [{ definition }] });
      }
    }
    if (!meanings.length) return null;
    return [{ word, phonetic: "", meanings }];
  }

  async function lookupLocal(word) {
    if (!word) return null;
    const data = await loadLetterDict(word[0]);
    return localToEntries(word, data[word]);
  }

  async function fetchDictionaryApi(word, signal) {
    const wait = combineSignals(signal, 6000);
    try {
      const res = await fetch(DICTIONARY_URL + encodeURIComponent(word), { signal: wait.signal });
      if (res.status === 404) throw notFoundError();
      if (!res.ok) throw new Error(`Dictionary error ${res.status}`);
      const data = await res.json();
      if (!Array.isArray(data) || !data.length) throw notFoundError();
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
      const res = await fetch(WIKTIONARY_URL + encodeURIComponent(word), { signal: wait.signal });
      if (res.status === 404) throw notFoundError();
      if (!res.ok) throw new Error(`Wiktionary error ${res.status}`);
      const data = await res.json();
      const entries = data && Array.isArray(data.en) ? data.en : [];
      const meanings = [];
      for (const entry of entries) {
        const defs = (entry.definitions || [])
          .map((d) => stripHtml(d.definition))
          .filter((text) => text && text.length > 1 && !text.startsWith(".mw-parser-output"))
          .slice(0, 3);
        if (!defs.length) continue;
        meanings.push({
          partOfSpeech: entry.partOfSpeech || "",
          definitions: defs.map((definition) => ({ definition })),
        });
        if (meanings.length >= 3) break;
      }
      if (!meanings.length) throw notFoundError();
      const result = [{ word, phonetic: "", meanings }];
      result._source = "wiktionary";
      result._queried = word;
      return result;
    } finally {
      wait.clear();
    }
  }

  async function fetchDatamuse(word, signal) {
    const wait = combineSignals(signal, 6000);
    try {
      const url = DATAMUSE_URL + encodeURIComponent(word) + "&md=d&max=8";
      const res = await fetch(url, { signal: wait.signal });
      if (!res.ok) throw new Error(`Datamuse error ${res.status}`);
      const data = await res.json();
      const hit = Array.isArray(data)
        ? data.find((item) => item && item.word === word && Array.isArray(item.defs) && item.defs.length)
        : null;
      if (!hit) throw notFoundError();
      const meanings = [];
      for (const raw of hit.defs) {
        const split = String(raw).split("\t");
        const code = (split[0] || "").trim();
        const definition = cleanDefinitionText(split.slice(1).join("\t") || raw);
        if (!definition) continue;
        const pos = POS_LABEL[code] || code;
        const existing = meanings.find((m) => m.partOfSpeech === pos);
        if (existing) {
          if (existing.definitions.length < 3) existing.definitions.push({ definition });
        } else {
          meanings.push({ partOfSpeech: pos, definitions: [{ definition }] });
        }
        if (meanings.length >= 3) break;
      }
      if (!meanings.length) throw notFoundError();
      const result = [{ word, phonetic: "", meanings }];
      result._source = "datamuse";
      result._queried = word;
      return result;
    } finally {
      wait.clear();
    }
  }

  async function lookupApis(word, signal) {
    const tasks = [fetchWiktionary(word, signal), fetchDatamuse(word, signal), fetchDictionaryApi(word, signal)];
    const settled = await Promise.all(
      tasks.map((promise) =>
        promise.then((value) => ({ value }), (err) => {
          if (isUserAbort(err, signal)) throw err;
          return { err };
        })
      )
    );
    for (const item of settled) {
      if (item && item.value) return item.value;
    }
    throw notFoundError();
  }

  async function fetchDefinition(word, signal) {
    const original = normalizeWord(word);
    const cached = cacheGet(original);
    if (cached) return cached;
    const candidates = lemmaCandidates(original);
    if (!candidates.length) throw notFoundError();

    for (const candidate of candidates) {
      const local = await lookupLocal(candidate);
      if (local) {
        tagEntries(local, original, candidate, "offline");
        cacheSet(original, local);
        return local;
      }
    }

    let lastErr = null;
    for (const candidate of candidates) {
      try {
        const data = await lookupApis(candidate, signal);
        tagEntries(data, original, candidate, data._source);
        cacheSet(original, data);
        return data;
      } catch (err) {
        if (isUserAbort(err, signal)) throw err;
        lastErr = err;
      }
    }
    throw lastErr || notFoundError();
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
        if (!sheetPhonetic.textContent) sheetPhonetic.textContent = pronunciation.phonetic || "";
        sheetBody.innerHTML = `<p class="empty">No definition found for “${escapeHtml(normalizeWord(word) || word)}.” You can edit the word above and try again.</p>`;
        return;
      }
      sheetBody.innerHTML = `<p class="empty">Couldn’t reach the dictionary. Check your connection and try again, or edit the word above.</p>`;
    }
  }

  function currentSheetWord() {
    return normalizeWord(sheetWord.value);
  }

  function stopPronunciation() {
    try {
      if (window.speechSynthesis) window.speechSynthesis.cancel();
    } catch (err) {
      // ignore
    }
    if (speakPlayer) {
      try {
        speakPlayer.pause();
        speakPlayer.removeAttribute("src");
        speakPlayer.load();
      } catch (err) {
        // ignore
      }
      speakPlayer = null;
    }
    if (sheetSpeak) sheetSpeak.classList.remove("playing");
  }

  function canPlayUrl(url) {
    if (!url) return false;
    const probe = speakPlayer || pronunciation.preloaded || new Audio();
    const lower = String(url).toLowerCase();
    if (/\.ogg|\.oga(\?|$)/.test(lower)) {
      const can = probe.canPlayType('audio/ogg; codecs="vorbis"') || probe.canPlayType("audio/ogg");
      return can === "probably" || can === "maybe";
    }
    if (/\.opus(\?|$)/.test(lower)) {
      const can = probe.canPlayType("audio/opus") || probe.canPlayType('audio/ogg; codecs="opus"');
      return can === "probably" || can === "maybe";
    }
    return true;
  }

  function scoreAudioUrl(url) {
    if (!url || !canPlayUrl(url)) return -100;
    const u = String(url).toLowerCase();
    let score = 1;
    if (/\.mp3(\?|$)/.test(u) || /\.m4a(\?|$)/.test(u) || /\.wav(\?|$)/.test(u) || /\.aac(\?|$)/.test(u)) score += 4;
    if (/\.ogg|\.oga|\.opus/.test(u)) score += 1;
    if (/-us\b|_us_|en-us|en_us/.test(u)) score += 2;
    else if (/-uk\b|-gb\b|en-uk|en-gb/.test(u)) score += 1;
    return score;
  }

  function pickPhoneticAndAudio(entries) {
    const result = { phonetic: firstPhonetic(entries || []), audioUrl: "" };
    const urls = [];
    for (const entry of entries || []) {
      for (const item of entry.phonetics || []) {
        if (!item) continue;
        if (!result.phonetic && item.text) result.phonetic = item.text;
        if (item.audio) urls.push(item.audio);
      }
    }
    urls.sort((a, b) => scoreAudioUrl(b) - scoreAudioUrl(a));
    result.audioUrl = urls.find((url) => scoreAudioUrl(url) > 0) || "";
    return result;
  }

  function pickEnVoice() {
    if (!window.speechSynthesis) return null;
    const voices = window.speechSynthesis.getVoices() || [];
    const en = voices.filter((v) => /^en(-|_|$)/i.test(v.lang) || /english/i.test(v.name));
    const us = en.filter((v) => /en-US/i.test(v.lang) || /United States|Samantha|Google US/i.test(v.name));
    return us[0] || en[0] || null;
  }

  function speakWithSynthesis(word) {
    if (!window.speechSynthesis || !word) return false;
    try {
      if (window.speechSynthesis.paused) window.speechSynthesis.resume();
    } catch (err) {
      // ignore
    }
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = "en-US";
    utter.rate = 0.88;
    utter.pitch = 1;
    const voice = pickEnVoice();
    if (voice) utter.voice = voice;
    utter.onstart = () => {
      if (sheetSpeak) sheetSpeak.classList.add("playing");
    };
    const done = () => {
      if (sheetSpeak) sheetSpeak.classList.remove("playing");
    };
    utter.onend = done;
    utter.onerror = done;
    window.speechSynthesis.speak(utter);
    return true;
  }

  function playRecordedAudio(url, fallbackWord) {
    stopPronunciation();
    const audio = new Audio();
    speakPlayer = audio;
    audio.preload = "auto";
    const fail = () => {
      if (speakPlayer === audio) {
        speakPlayer = null;
        speakWithSynthesis(fallbackWord);
      }
    };
    audio.onended = () => {
      if (speakPlayer === audio) {
        speakPlayer = null;
        if (sheetSpeak) sheetSpeak.classList.remove("playing");
      }
    };
    audio.onerror = fail;
    audio.onplaying = () => {
      if (sheetSpeak) sheetSpeak.classList.add("playing");
    };
    audio.src = url;
    const play = audio.play();
    if (play && typeof play.then === "function") play.catch(fail);
  }

  function preloadAudio(url) {
    if (!url) return;
    try {
      const audio = new Audio();
      audio.preload = "auto";
      audio.src = url;
      pronunciation.preloaded = audio;
    } catch (err) {
      // ignore
    }
  }

  function applyPronunciationInfo(word, info) {
    if (!info || pronunciation.word !== word) return;
    if (info.audioUrl && canPlayUrl(info.audioUrl)) {
      if (!pronunciation.audioUrl || scoreAudioUrl(info.audioUrl) > scoreAudioUrl(pronunciation.audioUrl)) {
        pronunciation.audioUrl = info.audioUrl;
        preloadAudio(pronunciation.audioUrl);
      }
    }
    if (info.phonetic) {
      pronunciation.phonetic = pronunciation.phonetic || info.phonetic;
      if (sheetPhonetic && !sheetPhonetic.textContent) sheetPhonetic.textContent = info.phonetic;
    }
  }

  function isPronunciationFile(title, word) {
    const name = String(title || "").replace(/^File:/i, "");
    if (!/\.(ogg|oga|mp3|wav|opus|m4a)$/i.test(name)) return false;
    if (/logo|icon|book|flag|image|\.svg/i.test(name)) return false;
    const stem = word.replace(/'/g, "").toLowerCase();
    const lower = name.toLowerCase();
    if (lower.includes(stem)) return true;
    return /^(en[-_ ]?(us|uk|gb|au)[-_ ])/i.test(name);
  }

  async function fetchWiktionaryAudio(word, signal) {
    const wait = combineSignals(signal, PRONUNCIATION_MS);
    try {
      const listUrl =
        WIKTIONARY_API +
        "?action=query&format=json&origin=*&prop=images&redirects=1&imlimit=40&titles=" +
        encodeURIComponent(word);
      const res = await fetch(listUrl, { signal: wait.signal });
      if (!res.ok) return null;
      const data = await res.json();
      const pages = (data && data.query && data.query.pages) || {};
      const titles = [];
      for (const page of Object.values(pages)) {
        for (const img of page.images || []) {
          if (isPronunciationFile(img.title, word)) titles.push(img.title);
        }
      }
      if (!titles.length) return null;
      titles.sort((a, b) => scoreAudioUrl(b) - scoreAudioUrl(a));
      const infoUrl =
        WIKTIONARY_API +
        "?action=query&format=json&origin=*&prop=imageinfo&iiprop=url&titles=" +
        titles.slice(0, 6).map(encodeURIComponent).join("|");
      const infoRes = await fetch(infoUrl, { signal: wait.signal });
      if (!infoRes.ok) return null;
      const infoData = await infoRes.json();
      const infoPages = (infoData && infoData.query && infoData.query.pages) || {};
      const urls = [];
      for (const page of Object.values(infoPages)) {
        const url = page.imageinfo && page.imageinfo[0] && page.imageinfo[0].url;
        if (url) urls.push(url);
      }
      urls.sort((a, b) => scoreAudioUrl(b) - scoreAudioUrl(a));
      const audioUrl = urls.find((url) => scoreAudioUrl(url) > 0) || "";
      return audioUrl ? { phonetic: "", audioUrl } : null;
    } catch (err) {
      if (isUserAbort(err, signal)) throw err;
      return null;
    } finally {
      wait.clear();
    }
  }

  async function fetchDictionaryPronunciation(word, signal) {
    const wait = combineSignals(signal, PRONUNCIATION_MS);
    try {
      const res = await fetch(DICTIONARY_URL + encodeURIComponent(word), { signal: wait.signal });
      if (!res.ok) return null;
      const data = await res.json();
      if (!Array.isArray(data) || !data.length) return null;
      return pickPhoneticAndAudio(data);
    } catch (err) {
      if (isUserAbort(err, signal)) throw err;
      return null;
    } finally {
      wait.clear();
    }
  }

  async function fetchPronunciation(word, signal) {
    const tasks = [fetchDictionaryPronunciation(word, signal), fetchWiktionaryAudio(word, signal)];
    const settled = await Promise.all(
      tasks.map((promise) =>
        promise.then(
          (value) => value,
          (err) => {
            if (isUserAbort(err, signal)) throw err;
            return null;
          }
        )
      )
    );
    const info = { phonetic: "", audioUrl: "" };
    for (const item of settled) {
      if (!item) continue;
      if (item.phonetic && !info.phonetic) info.phonetic = item.phonetic;
      if (item.audioUrl && scoreAudioUrl(item.audioUrl) > scoreAudioUrl(info.audioUrl)) {
        info.audioUrl = item.audioUrl;
      }
    }
    return info;
  }

  function startPronunciationPrefetch(word) {
    const normalized = normalizeWord(word);
    if (pronunciation.abort) {
      pronunciation.abort.abort();
      pronunciation.abort = null;
    }
    pronunciation = { word: normalized, audioUrl: "", phonetic: "", abort: null, preloaded: null };
    if (!normalized) return;
    const ac = new AbortController();
    pronunciation.abort = ac;
    fetchPronunciation(normalized, ac.signal)
      .then((info) => applyPronunciationInfo(normalized, info))
      .catch((err) => {
        if (err && err.name === "AbortError") return;
      });
  }

  function onSpeakClick() {
    const word = currentSheetWord();
    if (!word) return;
    if (pronunciation.word !== word) {
      startPronunciationPrefetch(word);
      speakWithSynthesis(word);
      return;
    }
    if (pronunciation.audioUrl && canPlayUrl(pronunciation.audioUrl)) {
      playRecordedAudio(pronunciation.audioUrl, word);
      return;
    }
    speakWithSynthesis(word);
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
    const info = pickPhoneticAndAudio(entries);
    const spoken = normalizeWord(word);
    sheetPhonetic.textContent = info.phonetic || pronunciation.phonetic || "";
    if (spoken === pronunciation.word) applyPronunciationInfo(spoken, info);
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

    const fromWord = entries._from;
    const fromLine = fromWord
      ? `<p class="from-lemma">from ${escapeHtml(fromWord)}</p>`
      : "";

    sheetBody.innerHTML = fromLine + meanings
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
    stopPronunciation();
    sheetWord.value = word;
    sheetPhonetic.textContent = "";
    sheetBody.innerHTML = `<p class="pending"><span class="spinner"></span>Looking up definition…</p>`;
    startPronunciationPrefetch(word);
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


  function persistScanMode() {
    try {
      localStorage.setItem(MODE_KEY, scanMode);
    } catch (err) {
      // ignore
    }
  }

  function setScanMode(mode) {
    scanMode = mode === "live" ? "live" : "photo";
    persistScanMode();
    applyScanModeUi();
  }

  function sheetIsOpen() {
    return sheet && !sheet.hidden && sheet.classList.contains("open");
  }

  function clearLivePill() {
    liveStable = { word: "", count: 0 };
    if (liveWordEl) liveWordEl.textContent = "";
    if (liveDefEl) liveDefEl.textContent = "";
    if (livePill) hide(livePill);
  }

  function applyScanModeUi() {
    const previewing = document.body.classList.contains("live");
    const scanning = previewing && scanMode === "live";
    if (modePhotoBtn) modePhotoBtn.setAttribute("aria-pressed", scanMode === "photo" ? "true" : "false");
    if (modeLiveBtn) modeLiveBtn.setAttribute("aria-pressed", scanMode === "live" ? "true" : "false");
    if (modeToggle) {
      if (previewing) show(modeToggle);
      else hide(modeToggle);
    }
    if (distanceHint) {
      if (previewing) show(distanceHint);
      else hide(distanceHint);
    }
    if (scanning) {
      hide(shutter);
      hide(steadyHint);
      hide(tapHint);
      if (liveReticle) show(liveReticle);
      startLiveLoop();
    } else {
      if (liveReticle) hide(liveReticle);
      clearLivePill();
      stopLiveLoop();
      if (previewing) {
        show(shutter);
        show(steadyHint);
      } else {
        hide(steadyHint);
      }
    }
  }

  function stopLiveLoop() {
    if (liveTimer) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }
  }

  function startLiveLoop() {
    stopLiveLoop();
    getLiveWorker().catch(() => {});
    const tick = async () => {
      try {
        await liveTick();
      } catch (err) {
        // Keep the loop alive if a single frame fails.
      }
      if (scanMode === "live" && document.body.classList.contains("live")) {
        liveTimer = setTimeout(tick, 500);
      }
    };
    liveTimer = setTimeout(tick, 180);
  }

  function scaleCanvasTo(source, factor) {
    const w = Math.max(1, Math.round(source.width * factor));
    const h = Math.max(1, Math.round(source.height * factor));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, w, h);
    return canvas;
  }

  function isLiveKeepable(text, confidence) {
    if (isKeepableToken(text, confidence)) return true;
    const cleaned = normalizeWord(text);
    // Long proper names often sit outside the 80k dictionary.
    return cleaned.length >= 8 && confidence >= 32 && /[a-z]{8,}/i.test(cleaned);
  }

  function liveWordsFromData(data) {
    return (data.words || [])
      .filter((w) => isLiveKeepable(w.text, w.confidence ?? 0))
      .map((w) => ({
        word: normalizeWord(w.text),
        confidence: w.confidence || 0,
        x0: w.bbox.x0,
        y0: w.bbox.y0,
        x1: w.bbox.x1,
        y1: w.bbox.y1,
        cx: (w.bbox.x0 + w.bbox.x1) / 2,
        cy: (w.bbox.y0 + w.bbox.y1) / 2,
        width: Math.max(1, w.bbox.x1 - w.bbox.x0),
        height: Math.max(1, w.bbox.y1 - w.bbox.y0),
      }));
  }

  function joinSplitLiveWords(words) {
    if (words.length < 2) return words;
    const sorted = words.slice().sort((a, b) => a.cy - b.cy || a.x0 - b.x0);
    const joined = [];
    let cur = { ...sorted[0] };
    for (let i = 1; i < sorted.length; i += 1) {
      const next = sorted[i];
      const sameLine = Math.abs(cur.cy - next.cy) <= Math.max(cur.height, next.height) * 0.35;
      const gap = next.x0 - cur.x1;
      const tight = gap >= -3 && gap <= Math.max(3, Math.max(cur.height, next.height) * 0.12);
      const left = cur.word || "";
      const right = next.word || "";
      const piece = (left.length <= 4 || right.length <= 4) && !(isKnownWord(left) && isKnownWord(right));
      if (sameLine && tight && piece && (left + right).length >= 6 && (left + right).length <= 18) {
        cur = {
          word: normalizeWord(left + right),
          confidence: Math.min(cur.confidence || 0, next.confidence || 0),
          x0: Math.min(cur.x0, next.x0),
          y0: Math.min(cur.y0, next.y0),
          x1: Math.max(cur.x1, next.x1),
          y1: Math.max(cur.y1, next.y1),
          cx: (Math.min(cur.x0, next.x0) + Math.max(cur.x1, next.x1)) / 2,
          cy: (Math.min(cur.y0, next.y0) + Math.max(cur.y1, next.y1)) / 2,
          width: Math.max(1, Math.max(cur.x1, next.x1) - Math.min(cur.x0, next.x0)),
          height: Math.max(1, Math.max(cur.y1, next.y1) - Math.min(cur.y0, next.y0)),
        };
      } else {
        joined.push(cur);
        cur = { ...next };
      }
    }
    joined.push(cur);
    return mergeWordLists([words, joined]);
  }

  function pickLiveWord(words, cx, cy) {
    if (!words.length) return null;
    const inside = words.filter((w) => cx >= w.x0 && cx <= w.x1 && cy >= w.y0 && cy <= w.y1);
    const pool = inside.length ? inside : words;
    let best = pool[0];
    let bestScore = Infinity;
    for (const word of pool) {
      const dist = Math.hypot(word.cx - cx, word.cy - cy);
      const area = Math.max(1, word.width * word.height);
      const shortPenalty = !inside.length && (word.word || "").length <= 3 ? (word.height || 12) * 0.85 : 0;
      // When the reticle sits in more than one box, keep the tightest word.
      const score = inside.length ? area + dist * 0.25 : dist + shortPenalty;
      if (score < bestScore || (score === bestScore && (word.confidence || 0) > (best.confidence || 0))) {
        best = word;
        bestScore = score;
      }
    }
    return best;
  }

  async function recognizeLiveCanvas(source, localX, localY) {
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    await Promise.race([knownReady, new Promise((resolve) => setTimeout(resolve, 400))]).catch(() => {});
    const metrics = estimateTextMetrics(source);
    let work = source;
    if (metrics.capHeight > 0) {
      const factor = Math.max(0.5, Math.min(3.2, TARGET_CAP_HEIGHT / metrics.capHeight));
      if (Math.abs(factor - 1) > 0.12) work = scaleCanvasTo(source, factor);
    } else if (Math.max(source.width, source.height) < 520) {
      work = scaleCanvasTo(source, 520 / Math.max(source.width, source.height));
    }
    const processed = unsharpCanvas(preprocessForOcr(work));
    const worker = await getLiveWorker();
    const first = await worker.recognize(processed, { tessedit_pageseg_mode: "7" });
    let words = liveWordsFromData(first.data || first);
    const second = await worker.recognize(processed, { tessedit_pageseg_mode: "6" });
    const more = liveWordsFromData(second.data || second);
    words = mergeWordLists([words, more]);
    words = joinSplitLiveWords(words);
    const sx = processed.width / source.width;
    const sy = processed.height / source.height;
    const aimX = localX == null ? processed.width / 2 : localX * sx;
    const aimY = localY == null ? processed.height / 2 : localY * sy;
    const picked = pickLiveWord(words, aimX, aimY);
    const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - started;
    const scaleY = source.height / processed.height;
    const lineHeights = words.map((w) => w.height * scaleY).filter((h) => h >= 8 && h <= source.height * 0.7).sort((a, b) => a - b);
    if (lineHeights.length) {
      const mid = lineHeights[Math.floor(lineHeights.length / 2)];
      liveLineHeight = mid;
    } else if (picked && picked.height) {
      const guessH = picked.height * scaleY;
      if (guessH >= 8 && guessH <= source.height * 0.7) liveLineHeight = guessH;
    }
    return {
      word: picked ? picked.word : "",
      picked,
      words,
      latency: Math.round(elapsed),
      capHeight: Math.round(metrics.capHeight || 0),
    };
  }

  function grabCenteredPatch(image, cx, cy, vw, vh) {
    const guess = liveLineHeight ? liveLineHeight * 3.0 : Math.min(vh * 0.09, 140);
    const ch = Math.max(56, Math.min(Math.round(vh * 0.18), Math.round(guess)));
    const cw = Math.max(120, Math.round(Math.min(vw * 0.62, Math.max(vw * 0.4, ch * 6))));
    const x = Math.max(0, Math.min(vw - cw, Math.round(cx - cw / 2)));
    const y = Math.max(0, Math.min(vh - ch, Math.round(cy - ch / 2)));
    const canvas = document.createElement("canvas");
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, x, y, cw, ch, 0, 0, cw, ch);
    return { canvas, localX: cx - x, localY: cy - y };
  }

  async function recognizeLiveFrame() {
    const vw = preview.videoWidth;
    const vh = preview.videoHeight;
    if (!vw || !vh) return null;
    const patch = grabCenteredPatch(preview, vw / 2, vh / 2, vw, vh);
    return recognizeLiveCanvas(patch.canvas, patch.localX, patch.localY);
  }

  async function showLiveDefinition(word) {
    if (!word || !liveDefEl) return;
    try {
      const data = await fetchDefinition(word);
      if (liveStable.word !== word) return;
      const first = Array.isArray(data) ? data[0] : data;
      const meaning = ((first && first.meanings) || [])[0] || {};
      const def = ((((meaning.definitions || [])[0] || {}).definition) || "").trim();
      liveDefEl.textContent = def.length > 110 ? def.slice(0, 107).trim() + "…" : def;
    } catch (err) {
      if (liveStable.word === word && liveDefEl) liveDefEl.textContent = "";
    }
  }

  function updateLivePill(word) {
    if (!word) {
      clearLivePill();
      return;
    }
    if (liveStable.word === word) liveStable.count += 1;
    else liveStable = { word, count: 1 };
    if (liveStable.count < 2) return;
    if (liveWordEl) liveWordEl.textContent = word;
    if (livePill) show(livePill);
    if (liveStable.count === 2) showLiveDefinition(word);
  }

  async function liveTick() {
    if (liveBusy) return;
    if (scanMode !== "live") return;
    if (!document.body.classList.contains("live")) return;
    if (document.hidden) return;
    if (sheetIsOpen()) return;
    if (!preview.videoWidth) return;
    liveBusy = true;
    try {
      const result = await recognizeLiveFrame();
      lastLiveResult = result;
      if (result && result.word) updateLivePill(result.word);
      else if (liveStable.count && liveStable.word) {
        // Keep the last stable pill briefly; do not flicker off on one empty frame.
        liveStable.count = Math.max(2, liveStable.count - 1);
      } else {
        clearLivePill();
      }
    } finally {
      liveBusy = false;
    }
  }

  function onLivePillClick(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const word = (liveWordEl && liveWordEl.textContent) || liveStable.word;
    if (word) openSheet(word);
  }

  async function recognizeLiveRegionFromImage(image, cx, cy) {
    const vw = image.naturalWidth || image.videoWidth || image.width;
    const vh = image.naturalHeight || image.videoHeight || image.height;
    const px = cx <= 1 ? cx * vw : cx;
    const py = cy <= 1 ? cy * vh : cy;
    const patch = grabCenteredPatch(image, px, py, vw, vh);
    return recognizeLiveCanvas(patch.canvas, patch.localX, patch.localY);
  }

  $("open-camera").addEventListener("click", openLiveCamera);
  $("choose-photo").addEventListener("click", onChoosePhoto);
  shutter.addEventListener("click", onShutter);
  retake.addEventListener("click", onRetake);
  toggleCommon.addEventListener("click", () => setShowAll(!showAll));
  if (modePhotoBtn) modePhotoBtn.addEventListener("click", () => setScanMode("photo"));
  if (modeLiveBtn) modeLiveBtn.addEventListener("click", () => setScanMode("live"));
  if (livePill) livePill.addEventListener("click", onLivePillClick);
  fileInput.addEventListener("change", onFileChange);
  $("sheet-close").addEventListener("click", () => closeSheet());
  sheetSpeak.addEventListener("click", onSpeakClick);
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
  startKnownWordsLoad();

  window.__wordLensTest = {
    isKnownWord,
    setScanMode,
    getScanMode() {
      return scanMode;
    },
    async recognizeLiveRegion(blob, cx, cy) {
      const url = URL.createObjectURL(blob);
      try {
        const img = await new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = () => reject(new Error("Couldn’t read that image."));
          image.src = url;
        });
        return recognizeLiveRegionFromImage(img, cx, cy);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    getLastLiveResult() {
      return lastLiveResult;
    },
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
