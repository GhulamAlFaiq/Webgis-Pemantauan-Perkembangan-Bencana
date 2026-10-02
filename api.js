/* =========================================================
   WebGIS Pemantauan Bencana Indonesia — Multi-API Data Layer
   Sources: PetaBencana.id + BMKG TEWS + Overpass API (OSM)

   Fungsi publik (tidak berubah):
     window.loadPetaBencanaData(map)
     window.filterPetaBencanaData(selectedTypes)
     window.getPetaBencanaReports()
     window.loadBmkgData(map)
     window.removeBmkgOverlay(map)
     window.loadShelterData(map)
     window.removeShelterOverlay(map)

   Perbaikan utama:
     - Timeout + retry untuk PetaBencana & BMKG
     - Cache localStorage: data lama tetap tampil jika API gagal
     - Overpass: mirror dicoba bertahap (hedged), bukan satu per satu
       menunggu timeout; mirror yang kalah dibatalkan
     - Overpass: POST, hasil di-cache, request kembar digabung,
       respons dipangkas (hanya name + amenity)
     - Overpass: titik berdekatan digabung, viewport terlalu luas
       diganti pencarian radius dari titik tengah
     - Request lama dibatalkan jika layer dinyalakan/dimatikan cepat
   ========================================================= */

(function () {
  /* Cegah eksekusi ganda jika api.js tidak sengaja dimuat dua kali */
  if (window.__webgisApiLoaded) {
    console.warn("api.js sudah dimuat sebelumnya, pemuatan kedua diabaikan.");
    return;
  }
  window.__webgisApiLoaded = true;

  const API_URL = "https://data.petabencana.id/reports?admin=ID-JT&geoformat=geojson";
  const BMKG_FELT_QUAKE_URL = "https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json";

  /* ---------- Network & Cache Config ---------- */
  const FETCH_TIMEOUT_MS = 10000;
  const FETCH_RETRIES = 1;
  const STALE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // data cache dipakai maks. 24 jam saat API gagal
  const OVERPASS_CACHE_TTL_MS = 15 * 60 * 1000; // hasil Overpass dianggap segar 15 menit
  const CACHE_PREFIX = "webgis:";

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function cacheGet(key, maxAgeMs) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const entry = JSON.parse(raw);
      if (!entry || typeof entry.t !== "number") return null;
      if (maxAgeMs && Date.now() - entry.t > maxAgeMs) return null;
      return entry;
    } catch (e) {
      return null;
    }
  }

  function cacheSet(key, data) {
    try {
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify({ t: Date.now(), data }));
    } catch (e) {
      /* quota penuh / storage dinonaktifkan: abaikan */
    }
  }

  function hashString(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  /* fetch JSON dengan timeout + retry */
  async function fetchJson(url, options) {
    const timeoutMs = (options && options.timeoutMs) || FETCH_TIMEOUT_MS;
    const retries = options && typeof options.retries === "number" ? options.retries : FETCH_RETRIES;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`Status ${response.status}`);
        return await response.json();
      } catch (err) {
        lastError = err;
        if (attempt < retries) await sleep(600 * (attempt + 1));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError;
  }

  /* Ambil dari jaringan; jika gagal, pakai cache terakhir yang masih layak */
  async function fetchWithStaleFallback(url, cacheKey) {
    try {
      const data = await fetchJson(url);
      cacheSet(cacheKey, data);
      return { data, stale: false };
    } catch (err) {
      const cached = cacheGet(cacheKey, STALE_MAX_AGE_MS);
      if (cached) {
        console.warn(`Jaringan gagal untuk ${cacheKey}, memakai data cache.`, err);
        return { data: cached.data, stale: true, cachedAt: cached.t };
      }
      throw err;
    }
  }

  /* ---------- Visual Config ---------- */
  const DISASTER_CONFIG = {
    flood: { label: "Banjir", icon: "fa-water", color: "#2A6F97" },
    wind: { label: "Angin Kencang", icon: "fa-wind", color: "#F4A100" },
    landslide: { label: "Tanah Longsor", icon: "fa-mountain", color: "#8B5E34" },
    earthquake: { label: "Gempa Bumi", icon: "fa-house-crack", color: "#E63946" },
    haze: { label: "Kabut Asap", icon: "fa-smog", color: "#6C757D" },
    fire: { label: "Kebakaran", icon: "fa-fire", color: "#D62828" },
    volcano: { label: "Gunung Berapi", icon: "fa-volcano", color: "#B5179E" },
  };

  const DEFAULT_CONFIG = { label: "Lainnya", icon: "fa-circle-exclamation", color: "#5A6472" };

  function getDisasterConfig(type) {
    if (!type) return DEFAULT_CONFIG;
    const key = String(type).toLowerCase().trim();
    return DISASTER_CONFIG[key] || { ...DEFAULT_CONFIG, label: titleCase(key) };
  }

  function titleCase(str) {
    return String(str)
      .replace(/_/g, " ")
      .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  }

  /* ---------- Marker Icon PetaBencana ---------- */
  function createDisasterIcon(disasterType) {
    const cfg = getDisasterConfig(disasterType);
    return L.divIcon({
      className: "pb-marker",
      html: `
        <span style="
          display:flex;align-items:center;justify-content:center;
          width:30px;height:30px;border-radius:50% 50% 50% 0;
          background:${cfg.color};transform:rotate(-45deg);
          box-shadow:0 2px 6px rgba(0,0,0,0.35);border:2px solid #fff;
        ">
          <i class="fa-solid ${cfg.icon}" style="transform:rotate(45deg);color:#fff;font-size:13px;"></i>
        </span>
      `,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
      popupAnchor: [0, -28],
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function formatDateTime(isoString) {
    if (!isoString) return "Waktu tidak diketahui";
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return "Waktu tidak diketahui";
    return (
      date.toLocaleString("id-ID", {
        day: "2-digit",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }) + " WIB"
    );
  }

  function getWaterLevel(reportData) {
    if (!reportData || typeof reportData !== "object") return null;
    const depth = reportData.flood_depth ?? reportData.water_level ?? reportData.depth;
    if (depth === undefined || depth === null || depth === "") return null;
    return `${depth} cm`;
  }

  function buildPopupContent(props) {
    const cfg = getDisasterConfig(props.disaster_type);
    const title =
      props.title && props.title.trim()
        ? props.title.trim()
        : props.text && props.text.trim()
        ? props.text.trim().slice(0, 60)
        : "Lokasi tidak diketahui";
    const description =
      props.text && props.text.trim() ? props.text.trim() : "Tidak ada deskripsi tambahan.";
    const waterLevel = getWaterLevel(props.report_data);
    const dateTime = formatDateTime(props.created_at);

    return `
      <div class="pb-popup" style="min-width:200px;font-family:inherit;">
        <div style="display:flex;align-items:center;gap:6px;font-weight:700;color:${cfg.color};margin-bottom:4px;">
          <i class="fa-solid ${cfg.icon}"></i> ${escapeHtml(cfg.label)}
        </div>
        <div style="font-weight:600;margin-bottom:4px;">${escapeHtml(title)}</div>
        <div style="font-size:12.5px;color:#5A6472;margin-bottom:6px;line-height:1.4;">
          ${escapeHtml(description)}
        </div>
        ${
          waterLevel
            ? `<div style="font-size:12.5px;margin-bottom:4px;"><i class="fa-solid fa-ruler-vertical"></i> Ketinggian air: ${escapeHtml(
                waterLevel
              )}</div>`
            : ""
        }
        <div style="font-size:11.5px;color:#5A6472;margin-bottom:2px;">
          <i class="fa-regular fa-clock"></i> ${dateTime}
        </div>
        <span class="source-badge petabencana">🌐 Sumber: PetaBencana.id</span>
      </div>
    `;
  }

  function setStatus(state, message) {
    const dot = document.querySelector(".status-dot");
    const label = document.getElementById("lastUpdated");
    if (label) label.textContent = message;
    if (!dot) return;

    if (state === "loading") dot.style.background = "#F4A100";
    else if (state === "error") dot.style.background = "#E63946";
    else dot.style.background = "#2A9D8F";
  }

  function formatShortNow(date) {
    return (date || new Date()).toLocaleString("id-ID", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  /* ---------- PetaBencana.id Layer ---------- */
  let clusterGroup = null;
  let allMarkers = [];
  let pbLoadingPromise = null;

  async function doLoadPetaBencana(map) {
    setStatus("loading", "Memuat data bencana...");

    if (!clusterGroup) {
      clusterGroup = L.markerClusterGroup();
      clusterGroup.addTo(map);
    }

    try {
      const result = await fetchWithStaleFallback(API_URL, "petabencana");
      const payload = result.data;
      const featureCollection = payload && payload.result ? payload.result : payload;
      const features =
        featureCollection && Array.isArray(featureCollection.features) ? featureCollection.features : [];

      const nextMarkers = [];
      features.forEach((feature) => {
        const geometry = feature.geometry;
        const props = feature.properties || {};

        if (!geometry || geometry.type !== "Point") return;
        const [lng, lat] = geometry.coordinates;
        if (!lat && !lng) return;

        const type = (props.disaster_type || "").toLowerCase().trim();
        const marker = L.marker([lat, lng], { icon: createDisasterIcon(type) });
        marker.bindPopup(buildPopupContent(props));
        marker.disasterType = type;
        nextMarkers.push({ marker, type, createdAt: props.created_at || null });
      });

      /* Ganti marker lama hanya setelah data baru siap (tidak berkedip) */
      clusterGroup.clearLayers();
      allMarkers = nextMarkers;
      clusterGroup.addLayers(allMarkers.map((entry) => entry.marker));

      if (result.stale) {
        setStatus(
          "loading",
          `Data tersimpan (${formatShortNow(new Date(result.cachedAt))}) · ${allMarkers.length} laporan · server tidak merespons`
        );
      } else {
        setStatus("ok", `Data termutakhir: ${formatShortNow()} · ${allMarkers.length} laporan`);
      }
    } catch (error) {
      console.error("Gagal memuat PetaBencana:", error);
      setStatus("error", "Gagal memuat data bencana (PetaBencana.id)");
    }
  }

  window.loadPetaBencanaData = function loadPetaBencanaData(map) {
    if (pbLoadingPromise) return pbLoadingPromise; // hindari request ganda
    pbLoadingPromise = doLoadPetaBencana(map).finally(() => {
      pbLoadingPromise = null;
    });
    return pbLoadingPromise;
  };

  window.filterPetaBencanaData = function filterPetaBencanaData(selectedTypes) {
    if (!clusterGroup) return;
    clusterGroup.clearLayers();
    const visibleMarkers = allMarkers
      .filter((entry) => selectedTypes.includes(entry.type))
      .map((entry) => entry.marker);
    clusterGroup.addLayers(visibleMarkers);
  };

  window.getPetaBencanaReports = function getPetaBencanaReports() {
    return allMarkers.map((entry) => ({
      type: entry.type,
      latlng: entry.marker.getLatLng(),
      createdAt: entry.createdAt || null,
    }));
  };

  /* ---------- BMKG TEWS Layer ---------- */
  let bmkgLayerGroup = null;
  let bmkgDataLoaded = false;
  let bmkgLoadingPromise = null;

  function quakeIcon(magnitude) {
    const mag = parseFloat(magnitude) || 0;
    const size = mag >= 5 ? 34 : mag >= 4 ? 28 : 22;
    return L.divIcon({
      className: "pb-marker",
      html: `
        <span style="
          display:flex;align-items:center;justify-content:center;
          width:${size}px;height:${size}px;border-radius:50%;
          background:rgba(230,57,70,0.88);border:2px solid #fff;
          box-shadow:0 2px 6px rgba(0,0,0,0.35);color:#fff;
          font-weight:700;font-size:11px;
        ">${mag.toFixed(1)}</span>
      `,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
      popupAnchor: [0, -size / 2],
    });
  }

  function buildQuakePopup(gempa) {
    return `
      <div style="min-width:190px;font-family:inherit;">
        <div style="font-weight:700;color:#E63946;margin-bottom:4px;">
          <i class="fa-solid fa-house-crack"></i> Gempa Dirasakan M${escapeHtml(gempa.Magnitude)}
        </div>
        <div style="font-size:12.5px;margin-bottom:4px;">${escapeHtml(gempa.Wilayah || "Wilayah tidak diketahui")}</div>
        <div style="font-size:12px;color:#5A6472;margin-bottom:2px;">Kedalaman: ${escapeHtml(gempa.Kedalaman || "-")}</div>
        <div style="font-size:12px;color:#5A6472;margin-bottom:2px;">Dirasakan: ${escapeHtml(gempa.Dirasakan || "-")}</div>
        <div style="font-size:11.5px;color:#5A6472;margin-bottom:2px;">
          <i class="fa-regular fa-clock"></i> ${escapeHtml(gempa.Tanggal || "")} ${escapeHtml(gempa.Jam || "")}
        </div>
        <span class="source-badge bmkg">🌐 Sumber: BMKG TEWS</span>
      </div>
    `;
  }

  async function doLoadBmkg(map) {
    if (!bmkgLayerGroup) bmkgLayerGroup = L.layerGroup();
    if (bmkgDataLoaded) {
      bmkgLayerGroup.addTo(map);
      return;
    }

    try {
      const result = await fetchWithStaleFallback(BMKG_FELT_QUAKE_URL, "bmkg");
      const payload = result.data;
      const quakes =
        payload && payload.Infogempa && Array.isArray(payload.Infogempa.gempa)
          ? payload.Infogempa.gempa
          : [];

      bmkgLayerGroup.clearLayers();
      quakes.forEach((gempa) => {
        if (!gempa.Coordinates) return;
        const [lat, lng] = gempa.Coordinates.split(",").map(Number);
        if (Number.isNaN(lat) || Number.isNaN(lng)) return;

        const marker = L.marker([lat, lng], { icon: quakeIcon(gempa.Magnitude) });
        marker.bindPopup(buildQuakePopup(gempa));
        bmkgLayerGroup.addLayer(marker);
      });

      bmkgDataLoaded = true;
      bmkgLayerGroup.addTo(map);
    } catch (error) {
      console.error("Gagal memuat data BMKG:", error);
      setStatus("error", "Gagal memuat titik gempa BMKG");
    }
  }

  window.loadBmkgData = function loadBmkgData(map) {
    if (bmkgLoadingPromise) return bmkgLoadingPromise;
    bmkgLoadingPromise = doLoadBmkg(map).finally(() => {
      bmkgLoadingPromise = null;
    });
    return bmkgLoadingPromise;
  };

  window.removeBmkgOverlay = function removeBmkgOverlay(map) {
    if (bmkgLayerGroup) map.removeLayer(bmkgLayerGroup);
  };

  /* =========================================================
     Overpass API — Faskes Terdekat (POST + Hedged Multi Mirror + Cache)
     ========================================================= */

  const OVERPASS_ENDPOINTS = [
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass-api.de/api/interpreter",
  ];

  const OVERPASS_REQUEST_TIMEOUT_MS = 15000; // batas tiap mirror
  const OVERPASS_STAGGER_MS = 2000; // mirror berikutnya dimulai jika yang sebelumnya belum menjawab
  const SHELTER_BUFFER_RADIUS_M = 5000;
  const MAX_BUFFER_POINTS = 10;
  const SHELTERS_PER_POINT = 4; // fasilitas terdekat yang ditampilkan untuk setiap titik bencana
  const MAX_VIEWPORT_SPAN_DEG = 0.5; // viewport lebih luas dari ini => pakai radius dari titik tengah
  const VIEWPORT_FALLBACK_RADIUS_M = 10000;
  const SHELTER_AMENITY_REGEX = "hospital|clinic|shelter|doctors";
  const EARTHQUAKE_EXCLUDED_TYPES = ["gempa", "earthquake", "prep"];

  let shelterLayerGroup = null;
  let shelterRequestId = 0; // penanda request terbaru, request lama dibuang
  const overpassInflight = new Map();

  /* Hitung Jarak Haversine (km) */
  function getDistanceInKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos((lat1 * Math.PI) / 180) *
        Math.cos((lat2 * Math.PI) / 180) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function getActiveNonEarthquakeDisasterPoints() {
    const points = [];

    if (typeof window.getPetaBencanaReports === "function") {
      window.getPetaBencanaReports().forEach((entry) => {
        if (!entry.latlng) return;
        points.push({
          lat: entry.latlng.lat,
          lng: entry.latlng.lng,
          type: (entry.type || "other").toLowerCase(),
          createdAt: entry.createdAt || null,
        });
      });
    }

    if (typeof window.getUserReports === "function") {
      window.getUserReports().forEach((report) => {
        if (typeof report.lat !== "number" || typeof report.lng !== "number") return;
        points.push({
          lat: report.lat,
          lng: report.lng,
          type: (report.disasterType || "other").toLowerCase(),
          createdAt: report.createdAt || null,
        });
      });
    }

    const nonEarthquakePoints = points.filter(
      (point) => !EARTHQUAKE_EXCLUDED_TYPES.includes(point.type)
    );

    nonEarthquakePoints.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : -Infinity;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : -Infinity;
      return bTime - aTime;
    });

    /* Gabungkan titik yang berdekatan (~1 km) agar query Overpass lebih ringan */
    const seen = new Set();
    const unique = [];
    nonEarthquakePoints.forEach((point) => {
      const key = `${point.lat.toFixed(2)},${point.lng.toFixed(2)}`;
      if (seen.has(key)) return;
      seen.add(key);
      unique.push(point);
    });

    return unique.slice(0, MAX_BUFFER_POINTS);
  }

  function buildBufferOverpassQuery(points) {
    const aroundQueries = points.map(
      (point) =>
        `nwr["amenity"~"${SHELTER_AMENITY_REGEX}"](around:${SHELTER_BUFFER_RADIUS_M},${point.lat.toFixed(4)},${point.lng.toFixed(4)});`
    );
    return `[out:json][timeout:20];(${aroundQueries.join("")});out tags center;`;
  }

  function buildViewportOverpassQuery(map) {
    const bounds = map.getBounds();
    const latSpan = bounds.getNorth() - bounds.getSouth();
    const lngSpan = bounds.getEast() - bounds.getWest();

    /* Peta terlalu luas (misalnya zoom satu provinsi): batasi ke radius dari titik tengah */
    if (latSpan > MAX_VIEWPORT_SPAN_DEG || lngSpan > MAX_VIEWPORT_SPAN_DEG) {
      const c = map.getCenter();
      return `[out:json][timeout:20];nwr["amenity"~"${SHELTER_AMENITY_REGEX}"](around:${VIEWPORT_FALLBACK_RADIUS_M},${c.lat.toFixed(3)},${c.lng.toFixed(3)});out tags center;`;
    }

    const bbox = [
      bounds.getSouth().toFixed(3),
      bounds.getWest().toFixed(3),
      bounds.getNorth().toFixed(3),
      bounds.getEast().toFixed(3),
    ].join(",");
    return `[out:json][timeout:20];nwr["amenity"~"${SHELTER_AMENITY_REGEX}"](${bbox});out tags center;`;
  }

  /* Pangkas respons: hanya data yang dipakai (hemat memori & ruang cache) */
  function slimElements(elements) {
    return elements.map((el) => ({
      type: el.type,
      id: el.id,
      lat: el.lat,
      lon: el.lon,
      center: el.center ? { lat: el.center.lat, lon: el.center.lon } : undefined,
      tags: {
        name: el.tags && el.tags.name,
        amenity: el.tags && el.tags.amenity,
      },
    }));
  }

  /* Hedged request: mulai dari mirror pertama; jika lambat atau gagal,
     mirror berikutnya ikut dimulai. Yang pertama berhasil menang,
     sisanya dibatalkan. */
  function raceOverpass(query) {
    return new Promise((resolve, reject) => {
      const controllers = [];
      const staggerTimers = [];
      let settled = false;
      let failures = 0;
      let nextIndex = 0;

      function finish(fn, value) {
        if (settled) return;
        settled = true;
        staggerTimers.forEach(clearTimeout);
        controllers.forEach((c) => c.abort());
        fn(value);
      }

      function launch() {
        if (settled || nextIndex >= OVERPASS_ENDPOINTS.length) return;
        const endpoint = OVERPASS_ENDPOINTS[nextIndex++];
        const controller = new AbortController();
        controllers.push(controller);

        const abortTimer = setTimeout(() => controller.abort(), OVERPASS_REQUEST_TIMEOUT_MS);
        let staggerTimer = null;
        if (nextIndex < OVERPASS_ENDPOINTS.length) {
          staggerTimer = setTimeout(launch, OVERPASS_STAGGER_MS);
          staggerTimers.push(staggerTimer);
        }

        console.log(`Mengirim Overpass Query ke: ${endpoint}`);

        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: "data=" + encodeURIComponent(query),
          signal: controller.signal,
        })
          .then((response) => {
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
          })
          .then((json) => {
            if (!json || !Array.isArray(json.elements)) throw new Error("Respons tidak valid");
            finish(resolve, { elements: slimElements(json.elements) });
          })
          .catch((err) => {
            if (settled) return;
            console.warn(`Gagal terhubung ke ${endpoint}:`, err.message);
            failures++;
            if (failures >= OVERPASS_ENDPOINTS.length) {
              finish(reject, new Error("Semua endpoint Overpass API gagal merespons."));
            } else if (staggerTimer) {
              /* Jangan menunggu jeda: langsung coba mirror berikutnya */
              clearTimeout(staggerTimer);
              launch();
            } else {
              launch();
            }
          })
          .finally(() => clearTimeout(abortTimer));
      }

      launch();
    });
  }

  /* Pemanggilan Overpass: cache segar -> request yang sedang jalan -> jaringan -> cache lama */
  function fetchOverpass(query) {
    const cacheKey = "ovp:" + hashString(query);

    const fresh = cacheGet(cacheKey, OVERPASS_CACHE_TTL_MS);
    if (fresh) {
      console.log("Overpass: memakai hasil cache.");
      return Promise.resolve(fresh.data);
    }

    if (overpassInflight.has(cacheKey)) return overpassInflight.get(cacheKey);

    const promise = raceOverpass(query)
      .then((data) => {
        cacheSet(cacheKey, data);
        return data;
      })
      .catch((err) => {
        const stale = cacheGet(cacheKey, STALE_MAX_AGE_MS);
        if (stale) {
          console.warn("Overpass gagal, memakai cache lama.", err);
          return stale.data;
        }
        throw err;
      })
      .finally(() => overpassInflight.delete(cacheKey));

    overpassInflight.set(cacheKey, promise);
    return promise;
  }

  function shelterIcon() {
    return L.divIcon({
      className: "pb-marker",
      html: `
        <span style="
          display:flex;align-items:center;justify-content:center;
          width:16px;height:16px;border-radius:50% 50% 50% 0;
          background:#2e7d32;transform:rotate(-45deg);
          box-shadow:0 1px 4px rgba(0,0,0,0.3);border:1.5px solid #fff;
        ">
          <i class="fa-solid fa-hospital" style="transform:rotate(45deg);color:#fff;font-size:8px;"></i>
        </span>
      `,
      iconSize: [16, 16],
      iconAnchor: [8, 16],
      popupAnchor: [0, -16],
    });
  }

  function shelterTypeLabel(amenity) {
    if (amenity === "hospital") return "Rumah Sakit";
    if (amenity === "clinic") return "Klinik / Puskesmas";
    if (amenity === "shelter") return "Tempat Perlindungan";
    if (amenity === "doctors") return "Praktik Dokter";
    return titleCase(amenity || "Fasilitas Kesehatan");
  }

  function buildShelterPopup(tags, distanceInKm) {
    const name = (tags && tags.name && String(tags.name).trim()) || "Fasilitas Kesehatan";
    const typeLabel = shelterTypeLabel(tags && tags.amenity);
    const distLabel =
      typeof distanceInKm === "number" && distanceInKm !== Infinity
        ? `<div style="font-size:12px;color:#2e7d32;font-weight:600;margin-bottom:4px;"><i class="fa-solid fa-route"></i> Jarak: ±${distanceInKm.toFixed(2)} km dari lokasi bencana</div>`
        : "";

    return `
      <div style="min-width:190px;font-family:inherit;">
        <div style="display:flex;align-items:center;gap:6px;font-weight:700;color:#2e7d32;margin-bottom:4px;">
          <i class="fa-solid fa-hospital"></i> ${escapeHtml(name)}
        </div>
        <div style="font-size:12.5px;color:#5A6472;margin-bottom:4px;">
          ${escapeHtml(typeLabel)}
        </div>
        ${distLabel}
        <span class="source-badge overpass">🏥 Sumber: OpenStreetMap (Overpass API)</span>
      </div>
    `;
  }

  function renderShelterElements(elements, referencePoints) {
    const seenIds = new Set();
    const validElements = [];

    elements.forEach((el) => {
      const lat =
        typeof el.lat === "number"
          ? el.lat
          : el.center && typeof el.center.lat === "number"
          ? el.center.lat
          : null;
      const lon =
        typeof el.lon === "number"
          ? el.lon
          : el.center && typeof el.center.lon === "number"
          ? el.center.lon
          : null;

      if (lat === null || lon === null) return;

      /* id OSM bisa sama antara node/way/relation, jadi kuncinya digabung dengan tipe */
      const uniqueKey = `${el.type}/${el.id}`;
      if (seenIds.has(uniqueKey)) return;
      seenIds.add(uniqueKey);

      validElements.push({ _key: uniqueKey, tags: el.tags || {}, _lat: lat, _lon: lon, _distance: Infinity });
    });

    const hasRefs = referencePoints && referencePoints.length > 0;
    let selected;

    if (!hasRefs) {
      selected = validElements.slice(0, SHELTERS_PER_POINT);
    } else {
      /* Pilih fasilitas terdekat PER titik, supaya setiap titik bencana kebagian */
      const chosen = new Map();
      referencePoints.forEach((pt) => {
        const ptLng = typeof pt.lng === "number" ? pt.lng : pt.lon;
        validElements
          .map((el) => ({ el, d: getDistanceInKm(pt.lat, ptLng, el._lat, el._lon) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, SHELTERS_PER_POINT)
          .forEach(({ el }) => chosen.set(el._key, el));
      });

      selected = Array.from(chosen.values());

      /* Jarak di popup = jarak ke titik bencana terdekat */
      selected.forEach((el) => {
        let minDistance = Infinity;
        referencePoints.forEach((pt) => {
          const ptLng = typeof pt.lng === "number" ? pt.lng : pt.lon;
          const dist = getDistanceInKm(pt.lat, ptLng, el._lat, el._lon);
          if (dist < minDistance) minDistance = dist;
        });
        el._distance = minDistance;
      });
      selected.sort((a, b) => a._distance - b._distance);
    }

    let renderedCount = 0;
    selected.forEach((el) => {
      const marker = L.marker([el._lat, el._lon], {
        icon: shelterIcon(),
        zIndexOffset: -1000,
      });
      marker.bindPopup(buildShelterPopup(el.tags, el._distance));
      shelterLayerGroup.addLayer(marker);
      renderedCount++;
    });

    console.log(`🏥 Berhasil merender ${renderedCount} titik faskes terdekat.`);
    return renderedCount;
  }

  async function loadShelterViewportFallback(map, notify, isStale) {
    try {
      const query = buildViewportOverpassQuery(map);
      const payload = await fetchOverpass(query);
      if (isStale()) return;

      const elements = Array.isArray(payload.elements) ? payload.elements : [];

      const center = map.getCenter();
      const referencePoints = [{ lat: center.lat, lng: center.lng }];

      const renderedCount = renderShelterElements(elements, referencePoints);

      if (renderedCount === 0 && notify) {
        notify("Tidak ditemukan fasilitas kesehatan pada tampilan peta saat ini.");
      }
    } catch (error) {
      if (isStale()) return;
      console.error("Gagal memuat data faskes fallback Overpass:", error);
      setStatus("error", "Gagal memuat titik evakuasi/faskes (Overpass API)");
      if (notify) notify("Gagal memuat data faskes. Coba lagi nanti.");
    }
  }

  window.loadShelterData = async function loadShelterData(map) {
    const requestId = ++shelterRequestId;
    const isStale = () => requestId !== shelterRequestId;

    if (!shelterLayerGroup) shelterLayerGroup = L.layerGroup();

    shelterLayerGroup.clearLayers();
    shelterLayerGroup.addTo(map);

    const notify = typeof window.showToast === "function" ? window.showToast : null;
    const points = getActiveNonEarthquakeDisasterPoints();

    if (points.length === 0) {
      if (notify) notify("Tidak ada bencana aktif — menampilkan faskes pada tampilan peta.");
      await loadShelterViewportFallback(map, notify, isStale);
      return;
    }

    points.forEach((point) => {
      L.circle([point.lat, point.lng], {
        radius: SHELTER_BUFFER_RADIUS_M,
        color: "#2e7d32",
        weight: 1,
        dashArray: "4, 4",
        fillOpacity: 0.08,
      }).addTo(shelterLayerGroup);
    });

    try {
      const query = buildBufferOverpassQuery(points);
      const payload = await fetchOverpass(query);
      if (isStale()) return;

      const elements = Array.isArray(payload.elements) ? payload.elements : [];
      const renderedCount = renderShelterElements(elements, points);

      if (renderedCount === 0) {
        await loadShelterViewportFallback(map, notify, isStale);
      }
    } catch (error) {
      if (isStale()) return;
      console.error("Gagal memuat data faskes Overpass:", error);
      await loadShelterViewportFallback(map, notify, isStale);
    }
  };

  window.removeShelterOverlay = function removeShelterOverlay(map) {
    shelterRequestId++; // batalkan request yang masih berjalan agar tidak muncul setelah layer dimatikan
    if (shelterLayerGroup) map.removeLayer(shelterLayerGroup);
  };
})();
