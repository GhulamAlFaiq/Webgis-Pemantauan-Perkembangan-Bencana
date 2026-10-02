/* =========================================================
   WebGIS Pemantauan Bencana Jawa Tengah — Dashboard Stats & Export
   Reads from window.getPetaBencanaReports() (js/api.js) and
   window.getUserReports() (js/report.js); writes nothing back to them.
   ========================================================= */

(function () {
  // Approximate bounding box for Jawa Tengah: [west, south, east, north].
  // This is a bbox, not the exact province polygon — good enough for a
  // "does this point fall roughly inside our province" spatial filter.
  // Swap in a real Jawa Tengah GeoJSON polygon here for precise results.
  const JAVA_TENGAH_BBOX = [108.55, -8.3, 111.75, -5.4];

  const DISASTER_LABELS = {
    flood: "Banjir",
    wind: "Angin Kencang",
    landslide: "Tanah Longsor",
    earthquake: "Gempa Bumi",
    haze: "Kabut Asap",
    fire: "Kebakaran",
    volcano: "Gunung Berapi",
    other: "Lainnya",
  };

  /* ---------- Spatial helper (Turf.js) ---------- */
  function getCentralJavaPolygon() {
    return turf.bboxPolygon(JAVA_TENGAH_BBOX);
  }

  function isInsideCentralJava(lat, lng) {
    if (typeof lat !== "number" || typeof lng !== "number" || Number.isNaN(lat) || Number.isNaN(lng)) {
      return false;
    }
    try {
      const point = turf.point([lng, lat]);
      return turf.booleanPointInPolygon(point, getCentralJavaPolygon());
    } catch (error) {
      console.error("Gagal menjalankan analisis spasial Turf.js:", error);
      return false;
    }
  }

  /* ---------- Data collection (pulls from api.js + report.js) ---------- */
  function collectAllPoints() {
    const points = [];

    if (typeof window.getPetaBencanaReports === "function") {
      window.getPetaBencanaReports().forEach((entry) => {
        points.push({
          type: (entry.type || "other").toLowerCase(),
          lat: entry.latlng.lat,
          lng: entry.latlng.lng,
          source: "petabencana",
        });
      });
    }

    if (typeof window.getUserReports === "function") {
      window.getUserReports().forEach((report) => {
        points.push({
          type: (report.disasterType || "other").toLowerCase(),
          lat: report.lat,
          lng: report.lng,
          source: "user",
        });
      });
    }

    return points;
  }

  function titleCase(str) {
    return str
      .replace(/_/g, " ")
      .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  }

  function mostFrequentType(points) {
    if (points.length === 0) return "-";

    const counts = {};
    points.forEach((point) => {
      counts[point.type] = (counts[point.type] || 0) + 1;
    });

    const topType = Object.keys(counts).reduce((a, b) => (counts[a] >= counts[b] ? a : b));
    return DISASTER_LABELS[topType] || titleCase(topType);
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  /* ---------- Public entry point: refresh all sidebar stat cards ---------- */
  window.updateDashboardStats = function updateDashboardStats() {
    const allPoints = collectAllPoints();

    // Spatial aggregation via Turf: only count points that genuinely fall
    // inside the Central Java bbox, filtering out stray/invalid coordinates.
    const activePoints = allPoints.filter((point) => isInsideCentralJava(point.lat, point.lng));

    const userReportsCount =
      typeof window.getUserReports === "function" ? window.getUserReports().length : 0;

    setText("statTotalActive", activePoints.length);
    setText("statMostFrequent", mostFrequentType(activePoints));
    setText("statUserReports", userReportsCount);

    const now = new Date().toLocaleString("id-ID", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    setText("statLastUpdate", now);
  };

  /* =========================================================
     GIS Export: user reports as standard GeoJSON
     ========================================================= */

  function buildReportsGeoJSON(reports) {
    return {
      type: "FeatureCollection",
      features: reports.map((report) => ({
        type: "Feature",
        geometry: {
          type: "Point",
          coordinates: [report.lng, report.lat],
        },
        properties: {
          id: report.id,
          disaster_type: report.disasterType,
          description: report.description,
          reporter_name: report.reporterName,
          created_at: report.createdAt,
        },
      })),
    };
  }

  window.exportUserReportsGeoJSON = function exportUserReportsGeoJSON() {
    const reports = typeof window.getUserReports === "function" ? window.getUserReports() : [];
    const notify = typeof window.showToast === "function" ? window.showToast : (msg) => alert(msg);

    if (reports.length === 0) {
      notify("Belum ada laporan warga untuk diekspor.");
      return;
    }

    const geojson = buildReportsGeoJSON(reports);
    const blob = new Blob([JSON.stringify(geojson, null, 2)], { type: "application/geo+json" });
    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");
    link.href = url;
    link.download = "laporan_bencana_jateng.geojson";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    notify(`${reports.length} laporan berhasil diekspor sebagai GeoJSON.`);
  };
})();
