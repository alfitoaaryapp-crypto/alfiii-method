onst FAKE_SAMPLE_COUNT = 8573;
const FAKE_SAMPLE_SIZE = 8;
const FAKE_SAMPLE_BYTES = new Uint8Array([0x00, 0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00]);
const VIDEO_TIMESCALE = 90000;
const VIDEO_DURATION = 2269500;
const VIDEO_EDIT_MEDIA_TIME = 0;
const VIDEO_SAMPLE_DELTA = 1500;

const fileInput = document.getElementById('fileInput');
const patchBtn = document.getElementById('patchBtn');
const openTabBtn = document.getElementById('openTabBtn');
const statusText = document.getElementById('statusText');
const statusEl = document.getElementById('status');
const langBtns = document.querySelectorAll('.lang-btn');

// Toggle elements
const tutorialToggle = document.getElementById('tutorialToggle');
const tutorialContent = document.getElementById('tutorialContent');
const explanationToggle = document.getElementById('explanationToggle');
const explanationContent = document.getElementById('explanationContent');

const LANG_KEY = 'fpsajaLang';
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'meta', 'ilst']);

const COPY = {
  en: {
    ready: 'Ready',
    processing: 'Processing',
    done: 'Done',
    error: 'Error',
    selected: 'Ready: {name}',
    scanning: 'Rebuilding MP4 tables...',
    patched: 'Patched: {realSamples}+{fakeSamples} samples',
    downloaded: 'Downloaded!',
    failed: 'Error: {message}',
  },
  pt: {
    ready: 'Pronto',
    processing: 'Processando',
    done: 'Concluído',
    error: 'Erro',
    selected: 'Pronto: {name}',
    scanning: 'Reconstruindo tabelas MP4...',
    patched: 'Patch: {realSamples}+{fakeSamples} samples',
    downloaded: 'Baixado!',
    failed: 'Erro: {message}',
  },
};

let selectedFile = null;
let currentLang = 'en';
let currentStatus = { key: 'ready', state: 'idle' };

function t(key, values = {}) {
  const text = (COPY[currentLang]?.[key] || COPY.en[key] || key);
  return String(text).replace(/\{(\w+)\}/g, (_, k) => values[k] ?? '');
}

function setStatus(key, state = 'idle', values = {}) {
  currentStatus = { key, state };
  statusText.textContent = t(key, values);
  statusEl.dataset.state = state;
}

function setLanguage(lang) {
  currentLang = lang;
  langBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.lang === lang);
  });
  localStorage.setItem(LANG_KEY, lang);
  setStatus(currentStatus.key, currentStatus.state);
}

// ========== MP4 PATCH (FPSAJA Method) ==========
function getBoxType(data, offset) {
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

function setBoxType(data, offset, type) {
  for (let i = 0; i < 4; i++) data[offset + i] = type.charCodeAt(i);
}

function readBox(view, data, offset, end) {
  if (offset + 8 > end) throw new Error('MP4 invalid');
  const smallSize = view.getUint32(offset, false);
  const type = getBoxType(data, offset + 4);
  let size = smallSize,
    headerSize = 8;
  if (smallSize === 1) {
    if (offset + 16 > end) throw new Error('MP4 invalid');
    size = view.getUint32(offset + 8, false) * 4294967296 + view.getUint32(offset + 12, false);
    headerSize = 16;
  } else if (smallSize === 0) {
    size = end - offset;
  }
  if (size < headerSize || offset + size > end) throw new Error('MP4 invalid');
  return { type, offset, size, headerSize, contentStart: offset + headerSize, end: offset + size, data, view, children: [] };
}

function parseBoxes(data, view, start = 0, end = data.length) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    const box = readBox(view, data, offset, end);
    if (CONTAINER_BOXES.has(box.type)) {
      const childStart = box.contentStart + (box.type === 'meta' ? 4 : 0);
      if (childStart < box.end) box.children = parseBoxes(data, view, childStart, box.end);
    }
    boxes.push(box);
    offset = box.end;
  }
  return boxes;
}

function findChild(box, type) { return box.children.find(c => c.type === type) || null; }

function findDescendant(box, path) {
  let cur = box;
  for (const t of path) { cur = findChild(cur, t); if (!cur) return null; }
  return cur;
}

function findTopLevel(boxes, type) { return boxes.find(b => b.type === type) || null; }

function handlerTypeForTrak(trak) {
  const hdlr = findDescendant(trak, ['mdia', 'hdlr']);
  if (!hdlr || hdlr.offset + 20 > hdlr.end) return null;
  return getBoxType(hdlr.data, hdlr.offset + 16);
}

function parseStsz(stsz) {
  const sampleSize = stsz.view.getUint32(stsz.offset + 12, false);
  const count = stsz.view.getUint32(stsz.offset + 16, false);
  if (sampleSize) return new Array(count).fill(sampleSize);
  const tableStart = stsz.offset + 20;
  const sizes = [];
  for (let i = 0; i < count; i++) sizes.push(stsz.view.getUint32(tableStart + i * 4, false));
  return sizes;
}

function parseStco(stco) {
  const count = stco.view.getUint32(stco.offset + 12, false);
  const tableStart = stco.offset + 16;
  const offsets = [];
  for (let i = 0; i < count; i++) offsets.push(stco.view.getUint32(tableStart + i * 4, false));
  return offsets;
}

function parseStsc(stsc) {
  const count = stsc.view.getUint32(stsc.offset + 12, false);
  const tableStart = stsc.offset + 16;
  const rows = [];
  for (let i = 0; i < count; i++) {
    const off = tableStart + i * 12;
    rows.push([stsc.view.getUint32(off, false), stsc.view.getUint32(off + 4, false), stsc.view.getUint32(off + 8, false)]);
  }
  return rows;
}

function makeBox(type, payload) {
  const size = 8 + payload.length;
  const box = new Uint8Array(size);
  const view = new DataView(box.buffer);
  view.setUint32(0, size, false);
  setBoxType(box, 4, type);
  box.set(payload, 8);
  return box;
}

function concatBytes(parts) {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  parts.forEach(p => { out.set(p, off);
    off += p.length; });
  return out;
}

function boxBytes(box) { return box.data.slice(box.offset, box.end); }

function boxPayload(box) { return box.data.slice(box.contentStart, box.end); }

function buildMdhd(box) {
  const payload = boxPayload(box);
  const view = new DataView(payload.buffer);
  if (payload[0] !== 0) throw new Error('mdhd version not supported');
  view.setUint32(12, VIDEO_TIMESCALE, false);
  view.setUint32(16, VIDEO_DURATION, false);
  return makeBox('mdhd', payload);
}

function buildElst(box) {
  const payload = boxPayload(box);
  const view = new DataView(payload.buffer);
  if (payload[0] !== 0 || view.getUint32(4, false) < 1) throw new Error('elst invalid');
  view.setUint32(12, VIDEO_EDIT_MEDIA_TIME, false);
  return makeBox('elst', payload);
}

function buildStts(realSampleCount, fakeSampleCount) {
  const payload = new Uint8Array(4 + 4 + 8 + 8);
  const view = new DataView(payload.buffer);
  view.setUint32(4, 2, false);
  view.setUint32(8, realSampleCount, false);
  view.setUint32(12, VIDEO_SAMPLE_DELTA, false);
  view.setUint32(16, fakeSampleCount, false);
  view.setUint32(20, VIDEO_SAMPLE_DELTA, false);
  return makeBox('stts', payload);
}

function buildStsz(originalSizes, fakeSampleCount) {
  const total = originalSizes.length + fakeSampleCount;
  const payload = new Uint8Array(4 + 4 + 4 + total * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(8, total, false);
  let off = 12;
  originalSizes.forEach(s => { view.setUint32(off, s, false);
    off += 4; });
  for (let i = 0; i < fakeSampleCount; i++) { view.setUint32(off, FAKE_SAMPLE_SIZE, false);
    off += 4; }
  return makeBox('stsz', payload);
}

function buildStsc(originalRows, originalChunkCount) {
  const rows = originalRows.map(r => [...r]);
  const last = rows[rows.length - 1];
  if (!last || last[1] !== 1) rows.push([originalChunkCount + 1, 1, 1]);
  const payload = new Uint8Array(4 + 4 + rows.length * 12);
  const view = new DataView(payload.buffer);
  view.setUint32(4, rows.length, false);
  let off = 8;
  rows.forEach(r => { view.setUint32(off, r[0], false);
    view.setUint32(off + 4, r[1], false);
    view.setUint32(off + 8, r[2], false);
    off += 12; });
  return makeBox('stsc', payload);
}

function buildStco(originalOffsets, delta, fakeOffset = null, fakeSampleCount = 0) {
  const count = originalOffsets.length + (fakeOffset === null ? 0 : fakeSampleCount);
  const payload = new Uint8Array(4 + 4 + count * 4);
  const view = new DataView(payload.buffer);
  view.setUint32(4, count, false);
  let off = 8;
  originalOffsets.forEach(o => { view.setUint32(off, o + delta, false);
    off += 4; });
  if (fakeOffset !== null) {
    for (let i = 0; i < fakeSampleCount; i++) { view.setUint32(off, fakeOffset, false);
      off += 4; }
  }
  return makeBox('stco', payload);
}

function rebuildBox(box, replacements) {
  if (replacements.has(box)) return replacements.get(box);
  if (!box.children.length) return boxBytes(box);
  const parts = [box.data.slice(box.contentStart, box.contentStart)];
  box.children.forEach(c => parts.push(rebuildBox(c, replacements)));
  return makeBox(box.type, concatBytes(parts));
}

function collectTrackStcoBoxes(moov) {
  const stcos = [];
  moov.children.filter(c => c.type === 'trak').forEach(trak => {
    const stbl = findDescendant(trak, ['mdia', 'minf', 'stbl']);
    if (!stbl) return;
    const co64 = findChild(stbl, 'co64');
    if (co64) throw new Error('co64 not supported yet');
    const stco = findChild(stbl, 'stco');
    if (stco) stcos.push(stco);
  });
  return stcos;
}

function patchFPSAJAMethod(arrayBuffer) {
  const data = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);
  const topLevel = parseBoxes(data, view);
  const ftyp = findTopLevel(topLevel, 'ftyp');
  const moov = findTopLevel(topLevel, 'moov');
  const mdat = findTopLevel(topLevel, 'mdat');
  if (!ftyp || !moov || !mdat) throw new Error('Missing ftyp/moov/mdat');

  const videoTrak = moov.children.find(c => c.type === 'trak' && handlerTypeForTrak(c) === 'vide');
  if (!videoTrak) throw new Error('No video track');

  const stbl = findDescendant(videoTrak, ['mdia', 'minf', 'stbl']);
  const mdhd = findDescendant(videoTrak, ['mdia', 'mdhd']);
  const elst = findDescendant(videoTrak, ['edts', 'elst']);
  const stts = stbl && findChild(stbl, 'stts');
  const stsc = stbl && findChild(stbl, 'stsc');
  const stsz = stbl && findChild(stbl, 'stsz');
  const stco = stbl && findChild(stbl, 'stco');
  if (!stbl || !mdhd || !elst || !stts || !stsc || !stsz || !stco)
    throw new Error('Missing required tables');

  const originalSizes = parseStsz(stsz);
  const realSampleCount = originalSizes.length;
  const fakeSampleCount = realSampleCount * 9;

  const originalStscRows = parseStsc(stsc);
  const originalChunkOffsets = parseStco(stco);
  const stcoBoxes = collectTrackStcoBoxes(moov);
  const preservedTopLevel = topLevel.filter(b => !['ftyp', 'moov', 'mdat'].includes(b.type)).map(boxBytes);

  const fixedReplacements = new Map([
    [mdhd, buildMdhd(mdhd)],
    [elst, buildElst(elst)],
    [stts, buildStts(realSampleCount, fakeSampleCount)],
    [stsc, buildStsc(originalStscRows, originalChunkOffsets.length)],
    [stsz, buildStsz(originalSizes, fakeSampleCount)],
  ]);

  const placeholderReplacements = new Map(fixedReplacements);
  buildStcoReplacements(stcoBoxes, stco, 0, 0, fakeSampleCount).forEach((v, k) => placeholderReplacements.set(k, v));
  const moovPlaceholder = rebuildBox(moov, placeholderReplacements);
  const preservedBytes = concatBytes(preservedTopLevel);
  const oldMdatPayloadStart = mdat.contentStart;
  const oldMdatPayload = data.slice(mdat.contentStart, mdat.end);
  const newMdatPayloadStart = ftyp.size + moovPlaceholder.length + preservedBytes.length + 8;
  let delta = newMdatPayloadStart - oldMdatPayloadStart;
  let fakeOffset = newMdatPayloadStart + oldMdatPayload.length;

  let finalReplacements = new Map(fixedReplacements);
  buildStcoReplacements(stcoBoxes, stco, delta, fakeOffset, fakeSampleCount).forEach((v, k) => finalReplacements.set(k, v));
  let moovNew = rebuildBox(moov, finalReplacements);
  const recalculatedMdatPayloadStart = ftyp.size + moovNew.length + preservedBytes.length + 8;
  delta = recalculatedMdatPayloadStart - oldMdatPayloadStart;
  fakeOffset = recalculatedMdatPayloadStart + oldMdatPayload.length;

  finalReplacements = new Map(fixedReplacements);
  buildStcoReplacements(stcoBoxes, stco, delta, fakeOffset, fakeSampleCount).forEach((v, k) => finalReplacements.set(k, v));
  moovNew = rebuildBox(moov, finalReplacements);
  const mdatPayloadNew = concatBytes([oldMdatPayload, FAKE_SAMPLE_BYTES]);
  const mdatNew = makeBox('mdat', mdatPayloadNew);
  const output = concatBytes([boxBytes(ftyp), moovNew, preservedBytes, mdatNew]);

  return { output, realSamples: realSampleCount, fakeSamples: fakeSampleCount };
}

function buildStcoReplacements(stcoBoxes, videoStco, delta, fakeOffset, fakeSampleCount) {
  const map = new Map();
  stcoBoxes.forEach(stco => {
    map.set(stco, buildStco(parseStco(stco), delta, stco === videoStco ? fakeOffset : null, fakeSampleCount));
  });
  return map;
}

// ========== UI EVENTS ==========
fileInput.addEventListener('change', (e) => {
  selectedFile = e.target.files?.[0] || null;
  if (selectedFile) {
    patchBtn.disabled = false;
    setStatus('selected', 'idle', { name: selectedFile.name });
  } else {
    patchBtn.disabled = true;
    setStatus('ready', 'idle');
  }
});

openTabBtn.addEventListener('click', () => {
  // Versi website standalone (ganti chrome.tabs dengan window.open)
  window.open(window.location.href, '_blank');
});

patchBtn.addEventListener('click', async () => {
  if (!selectedFile) return;
  setStatus('scanning', 'processing');
  try {
    const ab = await selectedFile.arrayBuffer();
    const patch = patchFPSAJAMethod(ab);
    setStatus('patched', 'processing', { realSamples: patch.realSamples, fakeSamples: patch.fakeSamples });
    const blob = new Blob([patch.output], { type: selectedFile.type || 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    // Output filename: 60FpsAja
    const originalName = selectedFile.name.replace(/\.[^.]+$/, '');
    a.download = `${originalName}_60FpsAja.mp4`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    setStatus('downloaded', 'success');
  } catch (err) {
    setStatus('failed', 'error', { message: err.message || 'unknown error' });
  }
});

langBtns.forEach(btn => {
  btn.addEventListener('click', () => setLanguage(btn.dataset.lang));
});

// Tutorial toggle
tutorialToggle.addEventListener('click', () => {
  const isOpen = tutorialContent.classList.toggle('open');
  tutorialToggle.classList.toggle('open', isOpen);
});

// Explanation toggle (Penjelasan Patcher)
explanationToggle.addEventListener('click', () => {
  const isOpen = explanationContent.classList.toggle('open');
  explanationToggle.classList.toggle('open', isOpen);
});

// Load saved language
const savedLang = localStorage.getItem(LANG_KEY) || 'en';
setLanguage(savedLang);