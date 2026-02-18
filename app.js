/* Country RTT Map
 * - expects ./country_country_rtt.csv (ISO-3166-1 alpha-2 codes in src_country/dst_country)
 * - renders a Leaflet choropleth by destination country for selected source
 */

const CSV_PATH = './country_country_rtt.csv';
const GEOJSON_URL = 'https://raw.githubusercontent.com/datasets/geo-countries/master/data/countries.geojson';
const DEFAULT_METRIC = 'average_ms';
const METRIC_FIELDS = [DEFAULT_METRIC, 'mean_ms', 'p50_ms', 'p90_ms', 'p95_ms', 'min_ms', 'max_ms'];

let rttRows = [];                 // parsed CSV rows as objects
let bySrc = new Map();            // src -> Map(dst -> row)
let allSrcCountries = [];         // ISO2 codes
let allSrcCountrySet = new Set(); // for O(1) source existence checks
let metricValues = new Map();     // metric -> sorted finite values
let geoLayer = null;
let map = null;
let legendControl = null;
let refreshScheduled = false;
let refreshPending = false;
const renderState = {
  src: '',
  metric: DEFAULT_METRIC,
  scaleMin: 0,
  scaleMax: 1
};

// Global scale config (applies to any selected source)
const scaleCfg = {
  auto: true,
  minMs: 20,
  maxMs: 300,
  pLow: 5,
  pHigh: 95,
  transform: 'linear', // 'linear' | 'log'
  missingColor: '#dddddd'
};
const selectedSourceColor = '#2f6bff';
const selectedSourceBorderColor = '#163dba';

function isFiniteNumber(x) {
  return typeof x === 'number' && Number.isFinite(x);
}

function parseNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function getDropdownValue(selector) {
  const $el = $(selector);
  const apiVal = $el.dropdown('get value');
  if (apiVal !== undefined && apiVal !== null && String(apiVal).length) {
    return String(apiVal);
  }
  const raw = $el.val();
  return raw === undefined || raw === null ? '' : String(raw);
}

function getCurrentSrc() {
  const src = getDropdownValue('#srcSelect');
  return (src || allSrcCountries[0] || '').toUpperCase();
}

function getCurrentMetric() {
  return getDropdownValue('#metricSelect') || DEFAULT_METRIC;
}

function getFeatureIso2(feature) {
  const props = (feature && feature.properties) || {};
  const raw =
    props['ISO3166-1-Alpha-2'] ||
    props.ISO_A2 ||
    props.iso_a2 ||
    props.iso2 ||
    props.ISO2 ||
    '';
  return String(raw).trim().toUpperCase();
}

function getFeatureName(feature) {
  const props = (feature && feature.properties) || {};
  return (
    props.name ||
    props.ADMIN ||
    props.admin ||
    props.NAME ||
    ''
  );
}

function setMapLoading(isLoading) {
  const el = document.getElementById('mapLoading');
  if (!el) return;
  el.classList.toggle('active', !!isLoading);
}

function clamp01(t) {
  return Math.max(0, Math.min(1, t));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

function rgbToHex({r,g,b}) {
  const toHex = (n) => n.toString(16).padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// green -> red
function valueToColor(v, minV, maxV) {
  if (!isFiniteNumber(v)) return scaleCfg.missingColor;

  // optional log transform
  let vv = v, a = minV, b = maxV;
  if (scaleCfg.transform === 'log') {
    const eps = 1e-6;
    vv = Math.log10(Math.max(eps, v));
    a = Math.log10(Math.max(eps, minV));
    b = Math.log10(Math.max(eps, maxV));
  }

  const t = clamp01((vv - a) / (b - a || 1));
  const green = hexToRgb('#00b050');
  const red = hexToRgb('#ff0000');
  const rgb = {
    r: Math.round(lerp(green.r, red.r, t)),
    g: Math.round(lerp(green.g, red.g, t)),
    b: Math.round(lerp(green.b, red.b, t))
  };
  return rgbToHex(rgb);
}

function computeGlobalScale(metric) {
  const vals = metricValues.get(metric) || [];
  if (!vals.length) return {min: 0, max: 1};

  const q = (p) => {
    const idx = (p/100) * (vals.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return vals[lo];
    const t = idx - lo;
    return vals[lo] * (1 - t) + vals[hi] * t;
  };

  const min = q(scaleCfg.pLow);
  const max = q(scaleCfg.pHigh);
  // avoid min==max
  return {min, max: Math.max(max, min + 1e-6)};
}

function firstNonNegative(...values) {
  for (const v of values) {
    if (v !== null && v >= 0) return v;
  }
  return null;
}

function estimateInvalidCount(row, n) {
  const min = parseNum(row.min_ms);
  const p50 = parseNum(row.p50_ms);
  const p90 = parseNum(row.p90_ms);
  const p95 = parseNum(row.p95_ms);
  const max = parseNum(row.max_ms);

  if (max === -1) return n;
  if (min !== -1) return 0;

  // We only have percentile summaries, not raw samples.
  // Use percentile bands to estimate the invalid share.
  let invalidFrac = Math.max(1 / Math.max(1, n), 0.01);
  if (p50 !== null && p50 < 0) invalidFrac = Math.max(invalidFrac, 0.70);
  if (p90 !== null && p90 < 0) invalidFrac = Math.max(invalidFrac, 0.925);
  if (p95 !== null && p95 < 0) invalidFrac = Math.max(invalidFrac, 0.975);

  const invalidCount = Math.round(invalidFrac * n);
  return Math.min(n - 1, Math.max(1, invalidCount));
}

function computeAverageMs(row) {
  const existing = parseNum(row.average_ms);
  if (existing !== null) return existing;

  const nRaw = parseNum(row.n);
  const n = Number.isFinite(nRaw) ? Math.round(nRaw) : 0;
  const mean = parseNum(row.mean_ms);
  const min = parseNum(row.min_ms);
  const max = parseNum(row.max_ms);
  if (n <= 0 || mean === null) return -1;
  if (max === -1) return -1;
  if (min !== -1 && mean >= 0) return mean;

  const invalidCount = estimateInvalidCount(row, n);
  if (invalidCount >= n) return -1;

  const corrected = (mean * n + invalidCount) / (n - invalidCount);
  if (Number.isFinite(corrected) && corrected >= 0) return corrected;

  const fallback = firstNonNegative(
    parseNum(row.p50_ms),
    parseNum(row.p90_ms),
    parseNum(row.p95_ms),
    parseNum(row.max_ms)
  );
  return fallback === null ? -1 : fallback;
}

function enrichAverageMetric(rows) {
  for (const row of rows) {
    row.average_ms = computeAverageMs(row);
  }
}

function buildMetricValues(rows) {
  metricValues = new Map();
  for (const metric of METRIC_FIELDS) metricValues.set(metric, []);

  for (const row of rows) {
    for (const metric of METRIC_FIELDS) {
      const v = parseNum(row[metric]);
      if (v !== null && v >= 0) metricValues.get(metric).push(v);
    }
  }

  for (const metric of METRIC_FIELDS) {
    metricValues.get(metric).sort((a, b) => a - b);
  }
}

function buildRenderState() {
  renderState.src = getCurrentSrc();
  renderState.metric = getCurrentMetric();
  const { min, max } = scaleCfg.auto
    ? computeGlobalScale(renderState.metric)
    : { min: scaleCfg.minMs, max: scaleCfg.maxMs };
  renderState.scaleMin = min;
  renderState.scaleMax = max;
}

function buildIndex(rows) {
  bySrc = new Map();
  const srcSet = new Set();
  for (const r of rows) {
    const src = (r.src_country || '').trim().toUpperCase();
    const dst = (r.dst_country || '').trim().toUpperCase();
    if (!src || !dst) continue;
    srcSet.add(src);

    if (!bySrc.has(src)) bySrc.set(src, new Map());
    bySrc.get(src).set(dst, r);
  }
  allSrcCountries = Array.from(srcSet).sort();
  allSrcCountrySet = new Set(allSrcCountries);
}

function initDropdowns() {
  const $src = $('#srcSelect');
  $src.empty();
  for (const c of allSrcCountries) {
    $src.append(`<option value="${c}">${c}</option>`);
  }

  $('#srcSelect').dropdown({
    fullTextSearch: 'exact',
    onChange: refreshLayer
  });
  $('#metricSelect').dropdown({
    onChange: refreshLayer
  });

  // default pick first
  if (allSrcCountries.length) {
    $src.dropdown('set selected', allSrcCountries[0]);
  }
}

function setSourceFromIso2(iso2) {
  const src = String(iso2 || '').trim().toUpperCase();
  if (!src || !allSrcCountrySet.has(src)) return false;

  $('#srcSelect').dropdown('set selected', src);
  // Fallback in case plugin callbacks do not fire in a given runtime.
  if (getCurrentSrc() !== src) {
    $('#srcSelect').val(src).trigger('change');
  }
  return true;
}

function styleForFeature(feature) {
  const metric = renderState.metric;
  const src = renderState.src;
  const iso2 = getFeatureIso2(feature);
  const isSelectedSource = !!src && iso2 === src;

  const srcMap = bySrc.get(src);
  const row = srcMap ? srcMap.get(iso2) : null;
  const v = row ? parseNum(row[metric]) : null;
  const valid = v !== null && v >= 0;

  const min = renderState.scaleMin;
  const max = renderState.scaleMax;
  const fill = isSelectedSource
    ? selectedSourceColor
    : (valid ? valueToColor(v, min, max) : scaleCfg.missingColor);

  return {
    weight: isSelectedSource ? 2 : 1,
    opacity: isSelectedSource ? 1 : 0.9,
    color: isSelectedSource ? selectedSourceBorderColor : '#666',
    fillOpacity: isSelectedSource ? 0.95 : 0.85,
    fillColor: fill
  };
}

function tooltipHtml(feature) {
  const metric = renderState.metric || getCurrentMetric();
  const src = renderState.src || getCurrentSrc();
  const iso2 = getFeatureIso2(feature);
  const name = getFeatureName(feature) || iso2;

  const srcMap = bySrc.get(src);
  const row = srcMap ? srcMap.get(iso2) : null;
  const v = row ? parseNum(row[metric]) : null;

  const vTxt = (v !== null && v >= 0) ? `${v.toFixed(1)} ms` : 'n/a';
  return `<div style="font-weight:600;margin-bottom:2px;">${name} (${iso2})</div>
          <div>from <b>${src}</b>: <b>${metric}</b> = ${vTxt}</div>`;
}

function refreshLayer() {
  if (!geoLayer) return;
  refreshPending = true;
  if (refreshScheduled) return;

  refreshScheduled = true;
  setMapLoading(true);

  const runRefresh = () => {
    refreshPending = false;
    try {
      buildRenderState();
      geoLayer.setStyle(styleForFeature);
      updateLegend();
    } catch (err) {
      refreshScheduled = false;
      setMapLoading(false);
      console.error(err);
      return;
    }

    if (refreshPending) {
      window.requestAnimationFrame(runRefresh);
      return;
    }

    refreshScheduled = false;
    setMapLoading(false);
  };

  window.requestAnimationFrame(() => window.requestAnimationFrame(runRefresh));
}

function updateLegend() {
  if (!legendControl) return;
  const metric = renderState.metric || getCurrentMetric();
  const min = renderState.scaleMin;
  const max = renderState.scaleMax;
  const minTxt = scaleCfg.transform === 'log' ? `${min.toFixed(1)} (p${scaleCfg.pLow})` : `${min.toFixed(1)}`;
  const maxTxt = scaleCfg.transform === 'log' ? `${max.toFixed(1)} (p${scaleCfg.pHigh})` : `${max.toFixed(1)}`;

  legendControl.getContainer().innerHTML = `
    <div style="font-weight:700;">RTT (${metric})</div>
    <div class="bar"></div>
    <div class="row"><span>fast</span><span>slow</span></div>
    <div class="row"><span>${minTxt} ms</span><span>${maxTxt} ms</span></div>
    <div style="margin-top:6px;font-size:12px;color:rgba(0,0,0,.65);">
      ${scaleCfg.auto ? 'Auto global scale' : 'Manual scale'} • ${scaleCfg.transform}
    </div>
  `;
}

async function loadGeoJSON() {
  const res = await fetch(GEOJSON_URL);
  if (!res.ok) throw new Error('Failed to load GeoJSON');
  return await res.json();
}

async function loadCSV() {
  const res = await fetch(CSV_PATH);
  if (!res.ok) throw new Error('Failed to load CSV. Make sure you serve this folder via a local web server.');
  const text = await res.text();

  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false
  });

  if (parsed.errors && parsed.errors.length) {
    console.warn(parsed.errors);
  }
  enrichAverageMetric(parsed.data);
  return parsed.data;
}

function initMap() {
  map = L.map('map', { worldCopyJump: true }).setView([20, 0], 2);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 6,
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(map);

  legendControl = L.control({position: 'bottomright'});
  legendControl.onAdd = function() {
    const div = L.DomUtil.create('div', 'legend');
    return div;
  };
  legendControl.addTo(map);
}

function hookUI() {
  $('#srcSelect, #metricSelect').on('change', refreshLayer);
  $('#scaleTransform').dropdown();

  // modal + form widgets
  $('#configBtn').on('click', () => $('#scaleModal').modal('show'));

  $('#applyScaleBtn').on('click', () => {
    scaleCfg.auto = $('#autoScale').is(':checked');
    scaleCfg.minMs = Number($('#scaleMin').val());
    scaleCfg.maxMs = Number($('#scaleMax').val());
    scaleCfg.pLow = Number($('#pLow').val());
    scaleCfg.pHigh = Number($('#pHigh').val());
    scaleCfg.transform = $('#scaleTransform').val();
    scaleCfg.missingColor = ($('#missingColor').val() || '#dddddd').trim();

    $('#scaleModal').modal('hide');
    refreshLayer();
  });

  $('#autoScale').on('change', () => {
    const auto = $('#autoScale').is(':checked');
    $('#scaleMin, #scaleMax').prop('disabled', auto);
    $('#pLow, #pHigh').prop('disabled', !auto);
  }).trigger('change');

  $('.ui.checkbox').checkbox();
}

async function main() {
  setMapLoading(true);
  try {
    initMap();

    rttRows = await loadCSV();
    buildIndex(rttRows);
    buildMetricValues(rttRows);
    initDropdowns();
    hookUI();
    buildRenderState();

    const geojson = await loadGeoJSON();
    geoLayer = L.geoJSON(geojson, {
      style: styleForFeature,
      onEachFeature: (feature, layer) => {
        layer.bindTooltip(() => tooltipHtml(feature), { sticky: true, direction: 'auto' });
        layer.on('mouseover', () => layer.setStyle({weight: 2, color: '#111'}));
        layer.on('mouseout', () => geoLayer.resetStyle(layer));
        layer.on('click', () => setSourceFromIso2(getFeatureIso2(feature)));
      }
    }).addTo(map);

    updateLegend();
  } finally {
    setMapLoading(false);
  }
}

main().catch(err => {
  console.error(err);
  $('body').prepend(
    `<div class="ui negative message" style="margin:12px;">
       <div class="header">App failed to start</div>
       <p>${String(err.message || err)}</p>
       <p>Tip: run a local server (e.g. <code>python -m http.server</code>) and open <code>http://localhost:8000</code>.</p>
     </div>`
  );
});
