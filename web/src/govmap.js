// GovMap address search adapter.
// Loads the official GovMap SDK, initializes it with a domain-locked token in a
// hidden container (so it never disturbs the MapLibre map), runs geocode(), and
// converts the returned Israeli-grid (ITM, EPSG:2039) coordinates to WGS84.
//
// ⚠️ GovMap's exact geocode response shape is NOT documented. The parsing below
// tries the common field names and logs the raw response when it can't read one,
// so the mapping can be corrected quickly once a live token is available.
import proj4 from "proj4";

// Israel TM Grid (EPSG:2039) — the coordinate system GovMap returns.
const ITM =
  "+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 +k=1.0000067 " +
  "+x_0=219529.584 +y_0=626907.39 +ellps=GRS80 " +
  "+towgs84=-24.0024,-17.1032,-17.8444,-0.33077,-1.85269,1.66969,5.4262 +units=m +no_defs";

const itmToLngLat = (x, y) => proj4(ITM, "WGS84", [Number(x), Number(y)]); // -> [lng, lat]

const SDK_URL = "https://www.govmap.gov.il/govmap/api/govmap.api.js";
let readyPromise = null;

function loadSdk() {
  return new Promise((resolve, reject) => {
    if (window.govmap) return resolve(window.govmap);
    const s = document.createElement("script");
    s.src = SDK_URL;
    s.defer = true;
    s.onload = () => resolve(window.govmap);
    s.onerror = () => reject(new Error("failed to load GovMap SDK"));
    document.head.appendChild(s);
  });
}

/** Load + initialize the GovMap SDK once. */
export function govmapInit(token) {
  if (readyPromise) return readyPromise;
  readyPromise = loadSdk().then((govmap) => {
    let div = document.getElementById("govmap-hidden");
    if (!div) {
      div = document.createElement("div");
      div.id = "govmap-hidden";
      div.style.cssText = "position:absolute;left:-9999px;top:0;width:320px;height:320px";
      document.body.appendChild(div);
    }
    govmap.createMap("govmap-hidden", {
      token, layers: [], showXY: false, identifyOnClick: false,
      isEmbeddedToggle: false, background: "1", layersMode: 1, zoomButtons: false,
    });
    return govmap;
  });
  return readyPromise;
}

// Pull X/Y + a display label out of one result item, tolerating field-name variants.
function readItem(item, fallbackName) {
  const x = item.X ?? item.x ?? item.cx ?? item.CX ?? item?.geometry?.x ?? item?.location?.x;
  const y = item.Y ?? item.y ?? item.cy ?? item.CY ?? item?.geometry?.y ?? item?.location?.y;
  const name =
    item.ResultLabel ?? item.Value ?? item.value ?? item.Address ?? item.address ??
    item.text ?? item.label ?? item.Name ?? fallbackName;
  if (x == null || y == null) return null;
  const [lng, lat] = itmToLngLat(x, y);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { name: String(name), lat, lng };
}

/**
 * @returns {Promise<Array<{name:string,lat:number,lng:number}>>}
 */
export async function govmapSearch(token, query) {
  const govmap = await govmapInit(token);
  const type = govmap.geocodeType?.FullResult ?? "FullResult";
  const res = await govmap.geocode({ keyword: query, type });

  const list = res?.data ?? res?.Result ?? res?.results ?? res?.Results ?? (Array.isArray(res) ? res : []);
  const arr = Array.isArray(list) ? list : list ? [list] : [];
  const out = [];
  for (const item of arr) {
    const parsed = readItem(item, query);
    if (parsed) out.push(parsed);
  }
  if (!out.length && import.meta.env.DEV) {
    console.warn("GovMap geocode returned no parseable result — raw response:", res);
  }
  return out.slice(0, 8);
}
