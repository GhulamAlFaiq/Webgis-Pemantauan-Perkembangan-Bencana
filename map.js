/* map.js */
document.addEventListener("DOMContentLoaded", function () {
  const INDONESIA_CENTER = [-2.5, 118.0];
  const DEFAULT_ZOOM = 5;

  function safeUpdateDashboardStats() {
    try {
      if (typeof window.updateDashboardStats === "function") {
        window.updateDashboardStats();
      }
    } catch (error) {
      console.error("Gagal memperbarui statistik dashboard:", error);
    }
  }
  window.safeUpdateDashboardStats = safeUpdateDashboardStats;

  const map = L.map("map", {
    center: INDONESIA_CENTER,
    zoom: DEFAULT_ZOOM,
    zoomControl: false,
  });

  window.mapRef = map;

  map.invalidateSize();
  setTimeout(() => map.invalidateSize(), 300);

  const osmBasemap = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    {
      attribution: "Tiles &copy; Esri &mdash; World Street Map",
      maxZoom: 19,
    }
  );
  osmBasemap.addTo(map);

  L.control.zoom({ position: "topleft" }).addTo(map);
  L.control.scale({ position: "bottomleft", imperial: false }).addTo(map);

  const sidebar = document.getElementById("sidebar");
  const sidebarToggle = document.getElementById("sidebarToggle");
  const sidebarCollapse = document.getElementById("sidebarCollapse");

  function collapseSidebar() {
    sidebar.classList.add("is-collapsed");
    sidebarToggle.classList.add("is-visible");
    sidebarToggle.setAttribute("aria-expanded", "false");
  }

  function expandSidebar() {
    sidebar.classList.remove("is-collapsed");
    sidebarToggle.classList.remove("is-visible");
    sidebarToggle.setAttribute("aria-expanded", "true");
    map.invalidateSize();
  }

  if (sidebarCollapse) sidebarCollapse.addEventListener("click", collapseSidebar);
  if (sidebarToggle) sidebarToggle.addEventListener("click", expandSidebar);

  const PETABENCANA_TYPES = ["flood", "wind", "landslide", "earthquake", "disaster"];

  function getActivePetaBencanaTypes() {
    return PETABENCANA_TYPES.filter((type) => {
      const checkbox = document.querySelector(`[data-layer="${type}"]`);
      return checkbox && checkbox.checked;
    });
  }

  let openMeteoClickEnabled = true;

  document.querySelectorAll("[data-layer]").forEach((checkbox) => {
    checkbox.addEventListener("change", (event) => {
      const layerKey = event.target.dataset.layer;

      switch (true) {
        case layerKey === "gempa": {
          if (typeof loadBmkgData !== "function" || typeof removeBmkgOverlay !== "function") return;
          if (event.target.checked) loadBmkgData(map);
          else removeBmkgOverlay(map);
          return;
        }

        case PETABENCANA_TYPES.includes(layerKey): {
          if (typeof filterPetaBencanaData === "function") {
            filterPetaBencanaData(getActivePetaBencanaTypes());
          }
          return;
        }

        case layerKey === "shelter": {
          if (typeof loadShelterData !== "function" || typeof removeShelterOverlay !== "function") return;
          if (event.target.checked) loadShelterData(map);
          else removeShelterOverlay(map);
          return;
        }

        case layerKey === "weather": {
          openMeteoClickEnabled = event.target.checked;
          return;
        }
      }
    });
  });

  const locateBtn = document.getElementById("locateBtn");
  if (locateBtn) {
    locateBtn.addEventListener("click", () => {
      if (!navigator.geolocation) {
        alert("Geolocation tidak didukung browser ini.");
        return;
      }

      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude } = position.coords;
          map.flyTo([latitude, longitude], 13);
          L.marker([latitude, longitude]).addTo(map).bindPopup("Lokasi Anda saat ini").openPopup();
        },
        () => alert("Tidak dapat mengambil lokasi Anda.")
      );
    });
  }

  try {
    if (typeof initReportFeature === "function") {
      initReportFeature(map);
    }
  } catch (error) {
    console.error("Gagal menginisialisasi fitur pelaporan warga:", error);
  }

  safeUpdateDashboardStats();

  const exportGeoJsonBtn = document.getElementById("exportGeoJsonBtn");
  if (exportGeoJsonBtn && typeof exportUserReportsGeoJSON === "function") {
    exportGeoJsonBtn.addEventListener("click", exportUserReportsGeoJSON);
  }

  window.addEventListener("resize", () => map.invalidateSize());

  (async function initializeDataSources() {
    try {
      if (typeof loadPetaBencanaData === "function") await loadPetaBencanaData(map);
    } catch (error) {
      console.error("PetaBencana Error:", error);
    } finally {
      safeUpdateDashboardStats();
    }

    try {
      if (typeof loadBmkgData === "function") await loadBmkgData(map);
    } catch (error) {
      console.error("BMKG Error:", error);
    }

    const shelterCheckbox = document.getElementById("chk-shelter");
    if (shelterCheckbox && shelterCheckbox.checked) {
      try {
        if (typeof loadShelterData === "function") await loadShelterData(map);
      } catch (error) {
        console.error("Shelter Error:", error);
      }
    }
  })();

  /* Listener Klik Peta Cuaca */
  map.on("click", async function (e) {
    // Abaikan jika sedang memilih lokasi bencana atau jika modal sedang terbuka
    if (typeof window.isReportLocationSelectionActive === "function" && window.isReportLocationSelectionActive()) {
      return;
    }

    if (document.querySelector(".modal-overlay.is-open")) {
      return;
    }

    if (!openMeteoClickEnabled) return;

    const { lat, lng } = e.latlng;
    await fetchWeatherOnClick(lat, lng, map, e.latlng);
  });

  async function fetchWeatherOnClick(lat, lng, mapInstance, latlng) {
    const popup = L.popup()
      .setLatLng(latlng)
      .setContent('<div style="font-size:12.5px;padding:2px 0;">Memuat data cuaca...</div>')
      .openOn(mapInstance);

    try {
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current_weather=true`
      );

      if (!response.ok) throw new Error("Gagal memuat cuaca");

      const payload = await response.json();
      const current = payload && payload.current_weather;

      if (!current) throw new Error("Data cuaca tidak lengkap");

      popup.setContent(`
        <div style="min-width:190px;font-family:inherit;">
          <div style="display:flex;align-items:center;gap:6px;font-weight:700;color:#00695c;margin-bottom:6px;">
            <i class="fa-solid fa-cloud-sun"></i> Cuaca Lokasi Ini
          </div>
          <div style="font-size:12.5px;margin-bottom:3px;">
            <i class="fa-solid fa-temperature-half"></i> Suhu: ${current.temperature}°C
          </div>
          <div style="font-size:12.5px;margin-bottom:3px;">
            <i class="fa-solid fa-wind"></i> Kecepatan Angin: ${current.windspeed} km/h
          </div>
          <span class="source-badge openmeteo">🌤️ Sumber: Open-Meteo API</span>
        </div>
      `);
    } catch (error) {
      popup.setContent('<div style="font-size:12.5px;color:#E63946;">Gagal memuat data cuaca.</div>');
    }
  }
});