/* =========================================================
   WebGIS Pemantauan Bencana Indonesia — Multi-API Data Layer
   Sources: PetaBencana.id + BMKG TEWS + Overpass API (OSM)
   ========================================================= */

(function () {
  const API_URL = "https://data.petabencana.id/reports?admin=ID-JT&geoformat=geojson";
  const BMKG_FELT_QUAKE_URL = "https://data.bmkg.go.id/DataMKG/TEWS/gempadirasakan.json";

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
    return str
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

  /* ---------- PetaBencana.id Layer ---------- */
  let clusterGroup = null;
  let allMarkers = [];

  window.loadPetaBencanaData = async function loadPetaBencanaData(map) {
    setStatus("loading", "Memuat data bencana...");

    if (!clusterGroup) {
      clusterGroup = L.markerClusterGroup();
      clusterGroup.addTo(map);
    }
    clusterGroup.clearLayers();
    allMarkers = [];

    try {
      const response = await fetch(API_URL);
      if (!response.ok) throw new Error(`Status ${response.status}`);

      const payload = await response.json();
      const featureCollection = payload && payload.result ? payload.result : payload;
      const features = Array.isArray(featureCollection.features) ? featureCollection.features : [];

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
        allMarkers.push({ marker, type, createdAt: props.created_at || null });
      });

      clusterGroup.addLayers(allMarkers.map((entry) => entry.marker));
      const now = new Date().toLocaleString("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
      setStatus("ok", `Data termutakhir: ${now} · ${allMarkers.length} laporan`);
    } catch (error) {
      console.error("Gagal memuat PetaBencana:", error);
      setStatus("error", "Gagal memuat data bencana (PetaBencana.id)");
    }
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

  window.loadBmkgData = async function loadBmkgData(map) {
    if (!bmkgLayerGroup) bmkgLayerGroup = L.layerGroup();
    if (bmkgDataLoaded) { bmkgLayerGroup.addTo(map); return; }

    try {
      const response = await fetch(BMKG_FELT_QUAKE_URL);
      if (!response.ok) throw new Error(`Status ${response.status}`);

      const payload = await response.json();
      const quakes = payload && payload.Infogempa && Array.isArray(payload.Infogempa.gempa) ? payload.Infogempa.gempa : [];

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
  };

  window.removeBmkgOverlay = function removeBmkgOverlay(map) {
    if (bmkgLayerGroup) map.removeLayer(bmkgLayerGroup);
  };

 /* =========================================================
     Overpass API — Faskes Terdekat (POST Method + Multi Mirror)
     ========================================================= */

  const OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter",
  ];
  
  const SHELTER_BUFFER_RADIUS_M = 5000;
  const MAX_BUFFER_POINTS = 10;
  const SHELTER_AMENITY_REGEX = "hospital|clinic|shelter|doctors";
  const EARTHQUAKE_EXCLUDED_TYPES = ["gempa", "earthquake", "prep"];

  let shelterLayerGroup = null;

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

    return nonEarthquakePoints.slice(0, MAX_BUFFER_POINTS);
  }

  function buildBufferOverpassQuery(points) {
    const aroundQueries = points.map(
      (point) =>
        `nwr["amenity"~"${SHELTER_AMENITY_REGEX}"](around:${SHELTER_BUFFER_RADIUS_M},${point.lat},${point.lng});`
    );
    return `[out:json][timeout:25];(${aroundQueries.join("")});out center;`;
  }

  function buildViewportOverpassQuery(bounds) {
    const bbox = `${bounds.getSouth()},${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()}`;
    return `[out:json][timeout:25];nwr["amenity"~"${SHELTER_AMENITY_REGEX}"](${bbox});out center;`;
  }

  /* Pemanggilan API dengan POST Method dan Multi-Endpoint Fallback */
  async function fetchOverpass(query) {
    console.log("📡 Mengirim Overpass Query...");
    for (const endpoint of OVERPASS_ENDPOINTS) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: "data=" + encodeURIComponent(query),
        });

        if (!response.ok) {
          console.warn(`⚠️ Endpoint Overpass (${endpoint}) HTTP Status: ${response.status}`);
          continue;
        }

        const data = await response.json();
        console.log(`✅ Respon Overpass API (${endpoint}):`, data);
        return data;
      } catch (err) {
        console.warn(`⚠️ Gagal terhubung ke Overpass (${endpoint}):`, err);
      }
    }
    throw new Error("Semua endpoint Overpass API gagal merespons.");
  }

  function shelterIcon() {
    return L.divIcon({
      className: "pb-marker",
      html: `
        <span style="
          display:flex;align-items:center;justify-content:center;
          width:30px;height:30px;border-radius:50% 50% 50% 0;
          background:#2e7d32;transform:rotate(-45deg);
          box-shadow:0 2px 6px rgba(0,0,0,0.35);border:2px solid #fff;
        ">
          <i class="fa-solid fa-hospital" style="transform:rotate(45deg);color:#fff;font-size:13px;"></i>
        </span>
      `,
      iconSize: [30, 30],
      iconAnchor: [15, 30],
      popupAnchor: [0, -28],
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
    const name = (tags && tags.name && tags.name.trim()) || "Fasilitas Kesehatan";
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
      const lat = typeof el.lat === "number" ? el.lat : (el.center && typeof el.center.lat === "number" ? el.center.lat : null);
      const lon = typeof el.lon === "number" ? el.lon : (el.center && typeof el.center.lon === "number" ? el.center.lon : null);

      if (lat === null || lon === null) return;
      if (seenIds.has(el.id)) return;
      seenIds.add(el.id);

      let minDistance = Infinity;
      if (referencePoints && referencePoints.length > 0) {
        referencePoints.forEach((pt) => {
          const dist = getDistanceInKm(pt.lat, pt.lng || pt.lon, lat, lon);
          if (dist < minDistance) minDistance = dist;
        });
      }

      el._lat = lat;
      el._lon = lon;
      el._distance = minDistance;
      validElements.push(el);
    });

    if (referencePoints && referencePoints.length > 0) {
      validElements.sort((a, b) => a._distance - b._distance);
    }

    const top4Elements = validElements.slice(0, 4);

    let renderedCount = 0;
    top4Elements.forEach((el) => {
      const marker = L.marker([el._lat, el._lon], { icon: shelterIcon() });
      marker.bindPopup(buildShelterPopup(el.tags || {}, el._distance));
      shelterLayerGroup.addLayer(marker);
      renderedCount++;
    });

    console.log(`🏥 Berhasil merender ${renderedCount} titik faskes terdekat.`);
    return renderedCount;
  }

  async function loadShelterViewportFallback(map, notify) {
    try {
      const query = buildViewportOverpassQuery(map.getBounds());
      const payload = await fetchOverpass(query);
      const elements = Array.isArray(payload.elements) ? payload.elements : [];
      
      const center = map.getCenter();
      const referencePoints = [{ lat: center.lat, lng: center.lng }];
      
      const renderedCount = renderShelterElements(elements, referencePoints);

      if (renderedCount === 0 && notify) {
        notify("Tidak ditemukan fasilitas kesehatan pada tampilan peta saat ini.");
      }
    } catch (error) {
      console.error("Gagal memuat data faskes fallback Overpass:", error);
      setStatus("error", "Gagal memuat titik evakuasi/faskes (Overpass API)");
      if (notify) notify("Gagal memuat data faskes. Coba lagi nanti.");
    }
  }

  window.loadShelterData = async function loadShelterData(map) {
    if (!shelterLayerGroup) shelterLayerGroup = L.layerGroup();

    shelterLayerGroup.clearLayers();
    shelterLayerGroup.addTo(map);

    const notify = typeof window.showToast === "function" ? window.showToast : null;
    const points = getActiveNonEarthquakeDisasterPoints();

    if (points.length === 0) {
      if (notify) notify("Tidak ada bencana aktif — menampilkan faskes pada tampilan peta.");
      await loadShelterViewportFallback(map, notify);
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
      const elements = Array.isArray(payload.elements) ? payload.elements : [];
      const renderedCount = renderShelterElements(elements, points);

      if (renderedCount === 0) {
        await loadShelterViewportFallback(map, notify);
      }
    } catch (error) {
      console.error("Gagal memuat data faskes Overpass:", error);
      await loadShelterViewportFallback(map, notify);
    }
  };

  window.removeShelterOverlay = function removeShelterOverlay(map) {
    if (shelterLayerGroup) map.removeLayer(shelterLayerGroup);
  };
})();