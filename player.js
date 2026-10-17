const $ = (id) => document.getElementById(id);
const video = $("video");
const caption = $("caption");
const captionWrap = $("caption-wrap");
const translation = $("translation");
const cueList = $("cues");
const status = $("status");
const frame = $("frame");
const counter = $("counter");
const cueCount = $("cue-count");
const tl = {
  bar: $("timeline"), cues: $("tl-cues"), fill: $("tl-fill"), head: $("tl-head"),
  cur: $("time-cur"), dur: $("time-dur"),
};
const ui = {
  sample: $("sample"), prev: $("prev"), repeat: $("repeat"), play: $("play"), next: $("next"),
  loop: $("loop"), loopVideo: $("loop-video"), pauseEnd: $("pause-end"), hide: $("hide"), showTr: $("show-tr"), rate: $("rate"),
  slower: $("slower"), faster: $("faster"), rateReset: $("rate-reset"), rateHint: $("rate-hint"),
};

let cues = [];
let translations = []; // translations[i] = tradução da frase cues[i]
let current = -1;        // frase em que o player está (última que começou)
let lastTime = 0;        // tempo no frame anterior, para detectar o fim de uma frase
let skipPauseAt = -1;    // frase cujo fim já pausou; não pausar de novo ao retomar
let rate = 1;
let mediaKey = null;     // chave AES da versão pública (null localmente: mídia sem cifra)
let videoBlobUrl = null;

const fmt = (t) => {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
};

function cueAt(t) {
  let idx = -1;
  for (let i = 0; i < cues.length && cues[i].start <= t + 0.001; i++) idx = i;
  return idx;
}

// ---------- carregamento ----------

// Baixa um arquivo da mídia, decifrando-o na versão pública.
async function fetchMedia(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ao baixar ${url}`);
  const data = await res.arrayBuffer();
  return mediaKey ? decryptBytes(mediaKey, data) : data;
}

const fetchText = async (url) => (url ? new TextDecoder().decode(await fetchMedia(url)) : "");

async function loadSamples() {
  const manifest = await fetch("samples.json").then((r) => r.json());
  if (manifest.encryption) mediaKey = await unlock(manifest.encryption);
  const samples = manifest.samples;
  if (!samples.length) {
    status.textContent = "Nenhum vídeo encontrado em midia/sample<N>/legal.mp4";
    return;
  }
  ui.sample.innerHTML = samples
    .map((s) => `<option value="${s.id}">${s.name}</option>`)
    .join("");
  const wanted = Number(new URLSearchParams(location.search).get("sample"));
  const chosen = samples.find((s) => s.id === wanted) ?? samples[0];
  ui.sample.value = chosen.id;
  ui.sample.onchange = () => {
    const s = samples.find((x) => x.id === Number(ui.sample.value));
    history.replaceState(null, "", `?sample=${s.id}`);
    loadSample(s);
  };
  loadSample(chosen);
}

async function loadSample(sample) {
  video.pause();
  cues = [];
  status.textContent = "";
  if (videoBlobUrl) URL.revokeObjectURL(videoBlobUrl);
  videoBlobUrl = null;
  if (mediaKey) {
    videoBlobUrl = URL.createObjectURL(new Blob([await fetchMedia(sample.video)], { type: "video/mp4" }));
    video.src = videoBlobUrl;
  } else {
    video.src = sample.video;
  }
  cues = parseSrt(await fetchText(sample.subtitles));
  if (!cues.length) status.textContent = `Legenda vazia ou ausente para ${sample.name}`;
  translations = alignTranslations(parseSrt(await fetchText(sample.translation)));
  renderCueList();
  renderTimeline();
  setCurrent(-1);
  lastTime = 0;
  skipPauseAt = -1;
  updateButtons();
}

// Associa cada frase à frase traduzida com maior sobreposição de tempo
// (ou à de mesmo índice, se os tempos não baterem).
function alignTranslations(trCues) {
  return cues.map((cue, i) => {
    let best = null;
    let bestOverlap = 0;
    for (const tr of trCues) {
      const overlap = Math.min(cue.end, tr.end) - Math.max(cue.start, tr.start);
      if (overlap > bestOverlap) [best, bestOverlap] = [tr, overlap];
    }
    return (best ?? trCues[i])?.text ?? "";
  });
}

function renderCueList() {
  cueList.innerHTML = "";
  cues.forEach((cue, i) => {
    const li = document.createElement("li");
    li.innerHTML = `
      <span class="num">${String(i + 1).padStart(2, "0")}</span>
      <div><p class="text"></p><div class="tr-wrap"><p class="tr"></p></div></div>
      <span class="time">${fmt(cue.start)}</span>`;
    li.querySelector(".text").textContent = cue.text;
    li.querySelector(".tr").textContent = translations[i] ?? "";
    li.onclick = () => jumpTo(i);
    cueList.appendChild(li);
  });
  cueCount.textContent = cues.length ? `${cues.length} frase${cues.length > 1 ? "s" : ""}` : "";
}

// Marca na linha do tempo o trecho de cada frase (precisa da duração do vídeo).
function renderTimeline() {
  const d = video.duration;
  tl.cues.innerHTML = "";
  tl.dur.textContent = Number.isFinite(d) ? fmt(d) : "0:00";
  if (!Number.isFinite(d) || !d) return;
  tl.bar.setAttribute("aria-valuemax", Math.round(d));
  cues.forEach((cue, i) => {
    const seg = document.createElement("div");
    seg.className = "seg" + (i === current ? " active" : "");
    seg.style.left = `${(cue.start / d) * 100}%`;
    seg.style.width = `${((cue.end - cue.start) / d) * 100}%`;
    tl.cues.appendChild(seg);
  });
}

function updateProgress(t) {
  const d = video.duration;
  const pct = Number.isFinite(d) && d ? Math.min(100, (t / d) * 100) : 0;
  tl.fill.style.width = `${pct}%`;
  tl.head.style.left = `${pct}%`;
  tl.cur.textContent = fmt(t);
  tl.bar.setAttribute("aria-valuenow", Math.round(t));
  const cue = cues[current];
  const li = cueList.children[current];
  if (cue && li) {
    const p = Math.max(0, Math.min(1, (t - cue.start) / (cue.end - cue.start)));
    li.style.setProperty("--p", `${p * 100}%`);
  }
}

function seekToPointer(e) {
  const r = tl.bar.getBoundingClientRect();
  const d = video.duration;
  if (!Number.isFinite(d)) return;
  const t = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
  video.currentTime = t;
  lastTime = t;
  skipPauseAt = -1;
  setCurrent(cueAt(t));
  updateCaptionState(t);
  updateProgress(t);
}

// ---------- estado / render ----------

function setCurrent(i) {
  if (i === current) return;
  cueList.children[current]?.classList.remove("active");
  tl.cues.children[current]?.classList.remove("active");
  current = i;
  tl.cues.children[current]?.classList.add("active");
  counter.textContent = current >= 0 ? `Frase ${current + 1} de ${cues.length}` : "";
  const li = cueList.children[current];
  if (li) {
    li.classList.add("active");
    scrollListTo(li);
  }
  caption.textContent = cues[current]?.text ?? "";
  translation.textContent = translations[current] ?? "";
  caption.classList.remove("peek");
  updateButtons();
}

// Rola só a lista de frases (scrollIntoView rolaria a página inteira e tiraria o vídeo de vista).
function scrollListTo(li) {
  const top = li.offsetTop;
  const bottom = top + li.offsetHeight;
  if (top >= cueList.scrollTop && bottom <= cueList.scrollTop + cueList.clientHeight) return;
  cueList.scrollTo({ top: top - (cueList.clientHeight - li.offsetHeight) / 2, behavior: "smooth" });
}

function updateCaptionState(t) {
  const cue = cues[current];
  caption.classList.toggle("gap", !cue || t >= cue.end);
}

function updateButtons() {
  const has = cues.length > 0;
  ui.prev.disabled = !has || current <= 0;
  ui.next.disabled = !has || current >= cues.length - 1;
  ui.repeat.disabled = !has || current < 0;
}

// ---------- navegação ----------

function jumpTo(i) {
  if (!cues.length) return;
  i = Math.max(0, Math.min(cues.length - 1, i));
  video.currentTime = cues[i].start;
  lastTime = cues[i].start;
  skipPauseAt = -1;
  setCurrent(i);
  updateCaptionState(lastTime);
  play();
}

const prev = () => jumpTo(current - 1);
const next = () => jumpTo(current + 1);
const repeat = () => jumpTo(Math.max(current, 0));
const play = () => video.play().catch(() => {});
const togglePlay = () => (video.paused ? play() : video.pause());

// ---------- velocidade ----------
// Aceita qualquer valor positivo; se o navegador recusar (o Chrome aceita de 0.0625× a 16×),
// usa o limite mais próximo e avisa.

let hintTimer;
function setRate(r) {
  r = Math.round(Number(r) * 10000) / 10000;
  if (!Number.isFinite(r) || r <= 0) {
    ui.rate.value = rate;
    return;
  }
  try {
    video.defaultPlaybackRate = video.playbackRate = r;
  } catch {
    const clamped = Math.min(Math.max(r, 0.0625), 16);
    video.defaultPlaybackRate = video.playbackRate = clamped;
    ui.rateHint.textContent = `o navegador não aceita ${r}×; usando ${clamped}×`;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => (ui.rateHint.textContent = ""), 3000);
    r = clamped;
  }
  rate = r;
  ui.rate.value = r;
}

const rateStep = (r, up) => (up ? r < 1 : r <= 1) ? 0.05 : (up ? r < 4 : r <= 4) ? 0.25 : 1;
const faster = () => setRate(rate + rateStep(rate, true));
const slower = () => setRate(rate - rateStep(rate, false));

// Loop da frase tem prioridade: com o loop do vídeo ligado o vídeo voltaria ao início
// antes de o loop da frase conseguir repetir a última frase.
const updateVideoLoop = () => (video.loop = ui.loopVideo.checked && !ui.loop.checked);

// ---------- sincronização ----------
// Chamada a cada frame (rAF) e em timeupdate, que continua rodando com a aba em segundo plano.

function sync() {
  const t = video.currentTime;
  if (t < lastTime) skipPauseAt = -1; // voltou (loop do vídeo): pode pausar de novo no fim das frases

  // Detecta a frase cujo fim acabou de ser cruzado.
  const ended = cues.findIndex((c) => lastTime < c.end && c.end <= t);
  if (ended !== -1 && !video.seeking) {
    if (ui.loop.checked) {
      const wasEnded = video.ended; // última frase: o vídeo pode ter acabado antes de voltarmos
      video.currentTime = cues[ended].start;
      lastTime = cues[ended].start;
      setCurrent(ended);
      updateCaptionState(lastTime);
      if (wasEnded) play();
      return;
    }
    if (ui.pauseEnd.checked && skipPauseAt !== ended) {
      skipPauseAt = ended;
      video.pause();
      video.currentTime = cues[ended].end - 0.01;
      lastTime = video.currentTime;
      setCurrent(ended);
      updateCaptionState(cues[ended].end);
      return;
    }
  }

  lastTime = t;
  setCurrent(cueAt(t));
  updateCaptionState(t);
  updateProgress(t);
}

function tick() {
  sync();
  requestAnimationFrame(tick);
}

// ---------- eventos ----------

ui.prev.onclick = prev;
ui.next.onclick = next;
ui.repeat.onclick = repeat;
ui.play.onclick = togglePlay;
video.onclick = togglePlay;
ui.rate.onchange = () => setRate(ui.rate.value);
ui.rate.onkeydown = (e) => e.key === "Enter" && ui.rate.blur();
ui.faster.onclick = faster;
ui.slower.onclick = slower;
ui.rateReset.onclick = () => setRate(1);
ui.loop.onchange = updateVideoLoop;
ui.loopVideo.onchange = updateVideoLoop;
ui.hide.onchange = () => caption.classList.toggle("hidden", ui.hide.checked);
ui.showTr.onchange = () => captionWrap.classList.toggle("show-tr", ui.showTr.checked);
caption.onclick = () => ui.hide.checked && caption.classList.toggle("peek");

function setPlayingUi(playing) {
  frame.classList.toggle("is-paused", !playing);
  ui.play.classList.toggle("playing", playing);
  ui.play.setAttribute("aria-label", playing ? "Pause" : "Play");
}
video.onplay = () => setPlayingUi(true);
video.onpause = () => setPlayingUi(false);
video.onloadedmetadata = renderTimeline;

tl.bar.onpointerdown = (e) => {
  tl.bar.setPointerCapture(e.pointerId);
  tl.bar.classList.add("dragging");
  seekToPointer(e);
};
tl.bar.onpointermove = (e) => tl.bar.hasPointerCapture(e.pointerId) && seekToPointer(e);
tl.bar.onpointerup = tl.bar.onpointercancel = () => tl.bar.classList.remove("dragging");
video.onseeked = () => (lastTime = video.currentTime);
video.ontimeupdate = sync;

// Tira o foco de botões/checkboxes após o clique para o espaço não acioná-los de novo.
document.addEventListener("click", (e) => {
  if (e.target.closest("button, input[type=checkbox]")) document.activeElement.blur();
});

const toggle = (box) => {
  box.checked = !box.checked;
  box.dispatchEvent(new Event("change"));
};

document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.target.matches?.("select, input:not([type=checkbox])")) return;
  const actions = {
    " ": togglePlay,
    ArrowLeft: prev,
    ArrowRight: next,
    r: repeat,
    l: () => toggle(ui.loop),
    v: () => toggle(ui.loopVideo),
    "-": slower,
    "+": faster,
    "=": faster,
    0: () => setRate(1),
    p: () => toggle(ui.pauseEnd),
    h: () => toggle(ui.hide),
    t: () => toggle(ui.showTr),
  };
  const action = actions[e.key.length === 1 ? e.key.toLowerCase() : e.key];
  if (action) {
    e.preventDefault();
    action();
  }
});

loadSamples();
requestAnimationFrame(tick);
