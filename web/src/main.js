import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { TerraDraw, TerraDrawCircleMode, TerraDrawPolygonMode, TerraDrawRectangleMode } from "terra-draw";
import { TerraDrawMapLibreGLAdapter } from "terra-draw-maplibre-gl-adapter";
import { union } from "@turf/union";
import { difference } from "@turf/difference";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { featureCollection } from "@turf/helpers";
import Supercluster from "supercluster";
import { GOVMAP_TOKEN } from "./config.js";
import "./style.css";

// GovMap (+ proj4) is loaded lazily — only when a token is configured.
let _govmapSearch = null;
async function loadGovmapSearch() {
  if (!_govmapSearch) _govmapSearch = (await import("./govmap.js")).govmapSearch;
  return _govmapSearch;
}

const BASE = import.meta.env.BASE_URL;
// Free, no-key vector basemap (OpenFreeMap "positron"). MapLibre = the open
// MapboxGL engine, so the look matches commercial map apps. We patch the style
// labels to Hebrew below. Covers Israel + Judea & Samaria. Tiles load over net.
const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const MAX_BOUNDS = [[33.9, 29.3], [35.95, 33.4]]; // [[W,S],[E,N]]
const SHAPE_TO_MODE = { Circle: "circle", Polygon: "polygon", Rectangle: "rectangle" };
const EMPTY_FC = { type: "FeatureCollection", features: [] };

// Correct shaping/ordering for Hebrew (and Arabic) map labels.
maplibregl.setRTLTextPlugin("https://unpkg.com/@mapbox/mapbox-gl-rtl-text@0.2.3/mapbox-gl-rtl-text.min.js", null, true);

// ---------- labels & formatting ----------
const KIND_LABEL = { apartment_rent: "דירה", unit_rent: "יחידת דיור", room_in_shared: "חדר בשותפות" };
const AMENITY_LABEL = {
  furnished: "מרוהט", air_conditioning: "מיזוג", elevator: "מעלית", parking: "חניה",
  balcony: "מרפסת", safe_room_mamad: 'ממ"ד', storage: "מחסן", renovated: "משופץ",
  pets_allowed: "חיות מחמד", accessible: "נגיש",
};
const priceText = (p) => (!p || p.amount == null ? "מחיר לא צוין" : `${p.amount.toLocaleString("he-IL")} ₪`);
const placeText = (loc) => [loc.neighborhood, loc.city].filter(Boolean).join(", ") || loc.raw_location_text || "מיקום לא ידוע";
const roomsText = (prop) => (prop.rooms != null ? `${prop.rooms} חד'` : null);
const amenityTags = (a) => Object.entries(a).filter(([, v]) => v === true).map(([k]) => AMENITY_LABEL[k]).filter(Boolean);

function jitter(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return [((((h >> 10) % 1000) / 1000) - 0.5) * 0.006, ((h % 1000) / 1000 - 0.5) * 0.006];
}
const pointFeat = (id, lng, lat) => ({ type: "Feature", geometry: { type: "Point", coordinates: [lng, lat] }, properties: { id } });

// ---------- state ----------
let allListings = [];
const byId = new Map();
let mode = "add";          // 'add' | 'subtract'
let activeShape = null;    // 'Circle' | 'Polygon' | 'Rectangle' | 'Line'
const ops = [];            // [{ mode, geo }]
let selectionGeo = null;
let draw;
let map;
let activePopup = null;   // only one popup open at a time
let clusterIndex = null;  // supercluster index over the currently-visible listings

// ---------- selection geometry (turf) ----------
function recompute() {
  let geo = null;
  for (const op of ops) {
    try {
      if (op.mode === "add") geo = geo ? union(featureCollection([geo, op.geo])) : op.geo;
      else geo = geo ? difference(featureCollection([geo, op.geo])) : null;
    } catch (e) { console.warn("geometry op failed:", e.message); }
  }
  selectionGeo = geo;
  map.getSource("selection").setData(selectionGeo ? featureCollection([selectionGeo]) : EMPTY_FC);
  document.getElementById("undo").disabled = ops.length === 0;
  document.getElementById("clear").disabled = ops.length === 0;
}
function inSelection(lat, lng) {
  if (!selectionGeo) return true;
  try { return booleanPointInPolygon([lng, lat], selectionGeo); } catch { return false; }
}

// ---------- filters ----------
function readFilters() {
  const num = (id) => { const v = document.getElementById(id).value; return v === "" ? null : Number(v); };
  return {
    priceMin: num("price-min"), priceMax: num("price-max"),
    roomsMin: document.getElementById("rooms-min").value ? Number(document.getElementById("rooms-min").value) : null,
    kinds: [...document.querySelectorAll(".kind:checked")].map((c) => c.value),
    hideReview: document.getElementById("hide-review").checked,
  };
}
function passesFilters(l, f) {
  if (!f.kinds.includes(l.classification.listing_kind)) return false;
  if (f.hideReview && l.extraction.needs_review) return false;
  const amt = l.price?.amount;
  if (f.priceMin != null && (amt == null || amt < f.priceMin)) return false;
  if (f.priceMax != null && (amt == null || amt > f.priceMax)) return false;
  if (f.roomsMin != null && (l.property?.rooms == null || l.property.rooms < f.roomsMin)) return false;
  return true;
}

function apply() {
  const f = readFilters();
  let shown = 0, noGeo = 0;
  const visible = [], feats = [];
  for (const l of allListings) {
    if (!passesFilters(l, f)) continue;
    const hasGeo = l.location.lat != null && l.location.lng != null;
    if (hasGeo) {
      const [dy, dx] = jitter(l.id);
      const lng = l.location.lng + dx, lat = l.location.lat + dy;
      if (inSelection(lat, lng)) { feats.push(pointFeat(l.id, lng, lat)); shown++; visible.push(l); }
    } else if (!selectionGeo) { shown++; noGeo++; visible.push(l); }
  }
  clusterIndex = new Supercluster({ radius: 44, maxZoom: 14 }).load(feats);
  renderClusters();
  document.getElementById("count").textContent = `${shown} מודעות`;
  document.getElementById("nogeo").textContent = noGeo ? `${noGeo} ללא מיקום` : "";
  renderResults(visible);
}

// Recompute cluster/point features for the current view and push to the source.
function renderClusters() {
  if (!clusterIndex || !map.getSource("listings")) return;
  const b = map.getBounds();
  const features = clusterIndex.getClusters([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], Math.round(map.getZoom()));
  map.getSource("listings").setData({ type: "FeatureCollection", features });
}

// ---------- rendering ----------
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// Simple card for the sidebar list + cluster popup — core info only.
function cardHtml(l) {
  const meta = [roomsText(l.property), KIND_LABEL[l.classification.listing_kind]].filter(Boolean).join(" · ");
  return `<div class="row1"><span class="place">${placeText(l.location)}</span><span class="price">${priceText(l.price)}</span></div>
    <div class="meta">${meta}</div>`;
}

// Full detail view shown in the modal when a listing is clicked.
function detailHtml(l) {
  const p = l.property, pr = l.price, av = l.availability, ct = l.contact;
  const imgs = Array.isArray(l.source.images) ? l.source.images : [];
  const slider = imgs.length ? `
    <div class="slider">
      <div class="slider-track">
        ${imgs.map((u) => `<img src="${u}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.classList.add('img-broken')" />`).join("")}
      </div>
      ${imgs.length > 1 ? `
        <button class="slider-btn slider-prev" aria-label="הקודם">‹</button>
        <button class="slider-btn slider-next" aria-label="הבא">›</button>
        <div class="slider-count">1 / ${imgs.length}</div>` : ""}
    </div>` : "";
  const amen = amenityTags(l.amenities).map((t) => `<span class="tag">${t}</span>`).join("");
  const specs = [
    roomsText(p),
    p.size_sqm ? `${p.size_sqm} מ"ר` : null,
    p.floor != null ? `קומה ${p.floor}${p.total_floors != null ? ` מתוך ${p.total_floors}` : ""}` : null,
  ].filter(Boolean).join(" · ");
  const priceExtra = [
    pr.includes_arnona === true ? "כולל ארנונה" : pr.includes_arnona === false ? "לא כולל ארנונה" : null,
    pr.includes_vaad_bait === true ? "כולל ועד בית" : null,
  ].filter(Boolean).join(" · ");
  const avail = [
    av.available_from ? `כניסה: ${av.available_from}` : null,
    av.min_lease_months ? `מינ׳ ${av.min_lease_months} חודשים` : null,
    av.is_short_term ? "טווח קצר" : null,
  ].filter(Boolean).join(" · ");
  const wa = ct.whatsapp ? String(ct.whatsapp).replace(/\D/g, "").replace(/^0/, "972") : null;
  const contact = [
    ct.phone ? `<a href="tel:${ct.phone}">☎ ${ct.phone}</a>` : null,
    wa ? `<a href="https://wa.me/${wa}" target="_blank" rel="noopener">💬 וואטסאפ</a>` : null,
    ct.contact_name ? `<span>${escapeHtml(ct.contact_name)}</span>` : null,
  ].filter(Boolean).join(" · ");
  return `
    ${slider}
    <h2>${KIND_LABEL[l.classification.listing_kind] || "מודעה"} · ${placeText(l.location)}</h2>
    <div class="d-price">${priceText(pr)}${priceExtra ? ` <span class="d-sub">(${priceExtra})</span>` : ""}</div>
    ${specs ? `<div class="d-row">${specs}</div>` : ""}
    ${amen ? `<div class="tags d-tags">${amen}</div>` : ""}
    ${avail ? `<div class="d-row d-muted">${avail}</div>` : ""}
    <div class="d-contact">${contact || '<span class="d-muted">פנייה בתגובות / בפרטי</span>'}</div>
    ${l.source.raw_text ? `<div class="d-desc">${escapeHtml(l.source.raw_text)}</div>` : ""}
    <div class="d-foot">
      ${fbLink(l.source)}
      ${l.extraction.needs_review ? `<span class="d-review">⚠ דורש בדיקה</span>` : ""}
    </div>`;
}

// Link to the exact post when we have its permalink, else to the group.
function fbLink(src) {
  if (src.post_url) return `<a href="${src.post_url}" target="_blank" rel="noopener">לפוסט המקורי בפייסבוק ↗</a>`;
  if (src.source_id) return `<a href="https://www.facebook.com/groups/${src.source_id}" target="_blank" rel="noopener">לקבוצת המקור בפייסבוק ↗</a>`;
  return "";
}

function wireSlider(root) {
  const track = root.querySelector(".slider-track");
  if (!track) return;
  const count = root.querySelector(".slider-count");
  const n = track.children.length;
  const update = () => { if (count) count.textContent = `${Math.round(track.scrollLeft / track.clientWidth) + 1} / ${n}`; };
  track.addEventListener("scroll", update, { passive: true });
  root.querySelector(".slider-next")?.addEventListener("click", () => track.scrollBy({ left: track.clientWidth, behavior: "smooth" }));
  root.querySelector(".slider-prev")?.addEventListener("click", () => track.scrollBy({ left: -track.clientWidth, behavior: "smooth" }));
}

function openDetail(l) {
  const modal = document.getElementById("detail");
  modal.querySelector(".modal-body").innerHTML = detailHtml(l);
  modal.querySelector(".modal-card").scrollTop = 0;
  wireSlider(modal);
  modal.hidden = false;
}
function closeDetail() { document.getElementById("detail").hidden = true; }
// Open exactly one popup, replacing any previous one.
function openPopup(lngLat, content) {
  if (activePopup) activePopup.remove();
  activePopup = new maplibregl.Popup({ closeButton: true, maxWidth: "300px" }).setLngLat(lngLat);
  content instanceof Node ? activePopup.setDOMContent(content) : activePopup.setHTML(content);
  activePopup.addTo(map);
}

function focusListing(l) {
  if (l.location.lat != null) {
    const [dy, dx] = jitter(l.id);
    map.flyTo({ center: [l.location.lng + dx, l.location.lat + dy], zoom: Math.max(map.getZoom(), 14) });
  }
  openDetail(l);
}

// Card list shown when a cluster of nearby dots is clicked.
function clusterListEl(leaves) {
  const wrap = document.createElement("div");
  wrap.className = "cluster-list";
  const head = document.createElement("div");
  head.className = "cluster-head";
  head.textContent = `${leaves.length} מודעות באזור`;
  wrap.appendChild(head);
  for (const lf of leaves) {
    const l = byId.get(lf.properties.id);
    if (!l) continue;
    const c = document.createElement("div");
    c.className = "card" + (l.extraction.needs_review ? " review" : "");
    c.innerHTML = cardHtml(l);
    c.addEventListener("click", () => focusListing(l));
    wrap.appendChild(c);
  }
  return wrap;
}

function renderResults(list) {
  const box = document.getElementById("results");
  box.innerHTML = "";
  for (const l of list.slice(0, 200)) {
    const el = document.createElement("div");
    el.className = "card" + (l.extraction.needs_review ? " review" : "");
    el.innerHTML = cardHtml(l);
    el.addEventListener("click", () => focusListing(l));
    box.appendChild(el);
  }
}

// ---------- drawing (Terra Draw + Turf) ----------
function setActiveTool(shape) {
  if (activeShape === shape) { activeShape = null; draw.setMode("static"); }
  else { activeShape = shape; draw.setMode(SHAPE_TO_MODE[shape]); }
  document.querySelectorAll(".tool").forEach((b) => b.classList.toggle("active", b.dataset.shape === activeShape));
}

function setupDraw() {
  draw = new TerraDraw({
    adapter: new TerraDrawMapLibreGLAdapter({ map }),
    modes: [new TerraDrawCircleMode(), new TerraDrawPolygonMode(), new TerraDrawRectangleMode()],
  });
  draw.start();
  draw.on("finish", (id) => {
    setTimeout(() => {
      const feat = draw.getSnapshot().find((f) => f.id === id);
      draw.clear();
      if (activeShape) draw.setMode(SHAPE_TO_MODE[activeShape]); // re-arm for the next shape
      if (!feat) return;
      ops.push({ mode, geo: feat });
      recompute(); apply();
    }, 0);
  });
}

// ---------- load ----------
// Region-label overrides applied on top of the Hebrew labels.
const RELABEL_TO_JUDEA = [
  "השטחים הפלסטיניים", "השטחים הפלסטינים", "הגדה המערבית",
  "תחומי הרשות הפלסטינית", "West Bank", "Palestinian Territories",
];

async function hebrewStyle() {
  const style = await fetch(STYLE_URL).then((r) => r.json());
  const name = ["coalesce", ["get", "name:he"], ["get", "name:latin"], ["get", "name"]];
  // If the resolved name is one of the West Bank variants, show "יהודה ושומרון".
  const textField = ["match", name, RELABEL_TO_JUDEA, "יהודה ושומרון", name];
  for (const layer of style.layers) {
    if (layer.type === "symbol" && layer.layout && layer.layout["text-field"]) {
      layer.layout["text-field"] = textField;
    }
  }
  return style;
}

// ---------- location search ----------
const normSearch = (s) => (s || "")
  .replace(/[֑-ׇ]/g, "").replace(/["'`׳״]/g, "").replace(/[־\-–—_]/g, " ")
  .replace(/\s+/g, " ").trim().toLowerCase();

function buildPlaces(gaz) {
  const seen = new Set();
  const out = [];
  const add = (name, c, kind, city) => {
    const norm = normSearch(name);
    if (!norm || seen.has(norm)) return;
    seen.add(norm);
    out.push({ name, lat: c.lat, lng: c.lng, kind, city, norm, pop: c.pop || 0 });
  };
  for (const [name, c] of Object.entries(gaz.cities || {})) add(name, c, "עיר");
  for (const [name, h] of Object.entries(gaz.neighborhoods || {})) add(name, h, "שכונה", h.city);
  return out;
}

function setupSearch(places) {
  const input = document.getElementById("search-input");
  const list = document.getElementById("search-results");
  let matches = [];
  let active = -1;

  const close = () => { list.hidden = true; list.innerHTML = ""; active = -1; };

  const pick = (p) => {
    input.value = p.name;
    close();
    // street-level (GovMap, no kind) zooms closest; neighborhood/city less so
    const zoom = p.kind === "שכונה" ? 14 : p.kind ? 12 : 16;
    map.flyTo({ center: [p.lng, p.lat], zoom, duration: 800 });
  };

  const render = () => {
    list.innerHTML = "";
    matches.forEach((p, i) => {
      const li = document.createElement("li");
      if (i === active) li.className = "active";
      const tag = p.kind ? `${p.kind}${p.city ? " · " + p.city : ""}` : "כתובת";
      li.innerHTML = `<span>${p.name}</span><span class="kind">${tag}</span>`;
      li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(p); });
      list.appendChild(li);
    });
    list.hidden = matches.length === 0;
  };

  const search = (q) => {
    const nq = normSearch(q);
    if (!nq) return [];
    const scored = [];
    for (const p of places) {
      const idx = p.norm.indexOf(nq);
      if (idx < 0) continue;
      let tier;
      if (p.norm === nq) tier = 0;                         // exact
      else if (idx === 0 && p.norm[nq.length] === " ") tier = 1; // query is the whole first word ("תל" -> "תל אביב")
      else if (idx === 0) tier = 2;                        // prefix ("תל" -> "תלם")
      else tier = 3;                                       // substring
      scored.push({ p, tier, pop: p.pop, len: p.name.length });
    }
    scored.sort((a, b) => a.tier - b.tier || b.pop - a.pop || a.len - b.len);
    return scored.slice(0, 8).map((s) => s.p);
  };

  // When a GovMap token is set, search any Israeli address live (debounced);
  // otherwise fall back to the bundled offline gazetteer.
  let debounce;
  input.addEventListener("input", () => {
    const q = input.value;
    if (!GOVMAP_TOKEN) { matches = search(q); active = -1; render(); return; }
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      if (normSearch(q).length < 2) { matches = []; active = -1; render(); return; }
      try {
        const govmapSearch = await loadGovmapSearch();
        matches = await govmapSearch(GOVMAP_TOKEN, q);
      } catch (e) {
        console.warn("GovMap search failed, using local gazetteer:", e);
        matches = search(q);
      }
      active = -1; render();
    }, 250);
  });
  input.addEventListener("keydown", (e) => {
    if (list.hidden) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, matches.length - 1); render(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === "Enter") { e.preventDefault(); pick(matches[active >= 0 ? active : 0]); }
    else if (e.key === "Escape") { close(); }
  });
  document.addEventListener("click", (e) => { if (!document.getElementById("search").contains(e.target)) close(); });
}

async function init() {
  const [style, data, gaz] = await Promise.all([
    hebrewStyle(),
    fetch(`${BASE}listings.json`).then((r) => r.json()),
    fetch(`${BASE}il-places.json`).then((r) => r.json()).catch(() => ({ cities: {}, neighborhoods: {} })),
  ]);
  setupSearch(buildPlaces(gaz));

  map = new maplibregl.Map({
    container: "map", style, center: [35.0, 31.7], zoom: 7.4, minZoom: 7, maxZoom: 18,
    maxBounds: MAX_BOUNDS, attributionControl: false, // credit shown in the sidebar footer instead
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
  if (import.meta.env.DEV) {
    window.__map = map; window.__getSel = () => selectionGeo; window.__ops = ops;
    window.__addOp = (geo, m = "add") => { ops.push({ mode: m, geo }); recompute(); apply(); };
    window.__getDraw = () => draw;
    window.__testClusterPopup = () => {
      const cl = map.queryRenderedFeatures({ layers: ["clusters"] })[0];
      if (!cl) return "no cluster";
      openPopup(cl.geometry.coordinates, clusterListEl(clusterIndex.getLeaves(cl.properties.cluster_id, Infinity)));
      return "shown size " + cl.properties.point_count;
    };
  }

  allListings = data.listings || [];
  for (const l of allListings) byId.set(l.id, l);

  map.on("load", () => {
    map.addSource("selection", { type: "geojson", data: EMPTY_FC });
    map.addLayer({ id: "selection-fill", type: "fill", source: "selection", paint: { "fill-color": "#2563eb", "fill-opacity": 0.1 } });
    map.addLayer({ id: "selection-line", type: "line", source: "selection", paint: { "line-color": "#2563eb", "line-width": 2 } });

    map.addSource("listings", { type: "geojson", data: EMPTY_FC }); // clustering done by supercluster on the main thread

    // merged "cluster" dot (grows with how many listings it holds)
    map.addLayer({
      id: "clusters", type: "circle", source: "listings", filter: ["has", "point_count"],
      paint: {
        "circle-color": "#2563eb",
        "circle-radius": ["step", ["get", "point_count"], 14, 5, 18, 15, 23],
        "circle-stroke-color": "#ffffff", "circle-stroke-width": 2,
      },
    });
    map.addLayer({
      id: "cluster-count", type: "symbol", source: "listings", filter: ["has", "point_count"],
      layout: { "text-field": ["get", "point_count_abbreviated"], "text-font": ["Noto Sans Regular"], "text-size": 13 },
      paint: { "text-color": "#ffffff" },
    });
    // single listing dot
    map.addLayer({
      id: "unclustered-point", type: "circle", source: "listings", filter: ["!", ["has", "point_count"]],
      paint: { "circle-radius": 6, "circle-color": "#2563eb", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 },
    });

    // single dot -> full detail modal
    map.on("click", "unclustered-point", (e) => {
      const l = byId.get(e.features[0].properties.id);
      if (l) openDetail(l);
    });
    // cluster dot -> list of its listings as cards (getLeaves is synchronous)
    map.on("click", "clusters", (e) => {
      const f = e.features[0];
      const leaves = clusterIndex.getLeaves(f.properties.cluster_id, Infinity);
      openPopup(f.geometry.coordinates, clusterListEl(leaves));
    });
    for (const layer of ["clusters", "unclustered-point"]) {
      map.on("mouseenter", layer, () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", layer, () => { map.getCanvas().style.cursor = ""; });
    }
    map.on("moveend", renderClusters); // re-cluster for the new viewport

    setupDraw();

    // sidebar wiring
    document.querySelectorAll("#mode button").forEach((b) => b.addEventListener("click", () => {
      mode = b.dataset.mode;
      document.querySelectorAll("#mode button").forEach((x) => x.classList.toggle("active", x === b));
    }));
    document.querySelectorAll(".tool").forEach((b) => b.addEventListener("click", () => setActiveTool(b.dataset.shape)));
    document.getElementById("undo").addEventListener("click", () => { ops.pop(); recompute(); apply(); });
    document.getElementById("clear").addEventListener("click", () => { ops.length = 0; recompute(); apply(); });
    document.querySelectorAll(".filters input, .filters select").forEach((el) => {
      el.addEventListener("input", apply); el.addEventListener("change", apply);
    });

    // detail modal: close on X, backdrop click, or Esc
    document.querySelector("#detail .modal-close").addEventListener("click", closeDetail);
    document.querySelector("#detail .modal-backdrop").addEventListener("click", closeDetail);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

    apply();
  });
}

init().catch((err) => {
  console.error(err);
  document.getElementById("results").innerHTML = `<div class="muted">שגיאה בטעינת הנתונים: ${err.message}</div>`;
});
