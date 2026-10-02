/* =========================================================
   WebGIS Pemantauan Bencana — Laporan Warga (Crowdsourcing)
   ========================================================= */

(function () {
  /* ---------- Supabase configuration ---------- */
  const SUPABASE_URL = "https://vxynzouszcgnvrjyzivy.supabase.co";
  const SUPABASE_KEY = "sb_publishable_EtvBeDvLiJmQt537qLQGOw_jv-xHiNA";
  const TABLE_NAME = "reports";
  const REPORTS_ENDPOINT = `${SUPABASE_URL}/rest/v1/${TABLE_NAME}`;

  const PHOTO_BUCKET = "disaster-photos";
  const MAX_PHOTO_BYTES = 4 * 1024 * 1024; // 4 MB
  const TTL_MS = 24 * 60 * 60 * 1000; // 24 jam
  const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

  const DISASTER_LABELS = {
    flood: "Banjir",
    landslide: "Tanah Longsor",
    wind: "Angin Kencang",
    earthquake: "Gempa Bumi",
    other: "Lainnya",
  };

  let mapRef = null;
  let userReportsLayer = null;
  let isSelectingLocation = false;

  let cachedReports = [];
  let markersById = {};

  function supabaseHeaders(extra) {
    return Object.assign(
      {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      extra || {}
    );
  }

  function rowToReport(row) {
    return {
      id: row.id,
      lat: typeof row.lat === "number" ? row.lat : parseFloat(row.lat),
      lng: typeof row.lng === "number" ? row.lng : parseFloat(row.lng),
      disasterType: row.jenis,
      description: row.deskripsi,
      reporterName: row.nama,
      createdAt: row.created_at || row.createdAt || null,
      expiresAt: row.expires_at,
      status: row.status,
      photoUrl: row.photo_url || null,
    };
  }

  function reportToPayload(report) {
    return {
      id: report.id,
      nama: report.reporterName,
      jenis: report.disasterType,
      deskripsi: report.description,
      lat: parseFloat(report.lat),
      lng: parseFloat(report.lng),
      expires_at: report.expiresAt,
      status: report.status || "pending",
      photo_url: report.photoUrl || null,
    };
  }

  function buildPhotoFilename(reportId, file) {
    const fromName = (file.name || "").split(".").pop().toLowerCase();
    const fromMime = (file.type || "").split("/")[1] || "";
    const rawExt = /^[a-z0-9]{2,5}$/.test(fromName) ? fromName : fromMime;
    const ext = (rawExt || "jpg").replace(/[^a-z0-9]/g, "").slice(0, 5) || "jpg";
    const rand = Math.random().toString(36).slice(2, 8);
    return `${reportId}_${rand}.${ext}`;
  }

  async function uploadPhoto(file, reportId) {
    const filename = buildPhotoFilename(reportId, file);
    const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${PHOTO_BUCKET}/${filename}`;
    let response;

    try {
      response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          Authorization: `Bearer ${SUPABASE_KEY}`,
          "Content-Type": file.type || "image/jpeg",
          "x-upsert": "true",
        },
        body: file,
      });
    } catch (networkError) {
      throw new Error("Tidak dapat mengunggah foto. Periksa koneksi internet Anda.");
    }

    if (!response.ok) {
      throw new Error(`Gagal mengunggah foto (status ${response.status}).`);
    }

    return `${SUPABASE_URL}/storage/v1/object/public/${PHOTO_BUCKET}/${filename}`;
  }

  function generateReportId() {
    return `rep_${Date.now()}`;
  }

  async function fetchActiveReports() {
    const response = await fetch(`${REPORTS_ENDPOINT}?status=eq.approved`, {
      method: "GET",
      headers: supabaseHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Supabase GET merespons dengan status ${response.status}`);
    }

    const rows = await response.json();
    const now = new Date();

    return rows
      .map(rowToReport)
      .filter((report) => report.expiresAt && new Date(report.expiresAt) > now);
  }

  async function insertReport(report) {
    const payload = reportToPayload(report);
    let response;

    try {
      response = await fetch(REPORTS_ENDPOINT, {
        method: "POST",
        headers: supabaseHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify(payload),
      });
    } catch (networkError) {
      throw new Error("Tidak dapat terhubung ke server. Periksa koneksi internet Anda.");
    }

    if (!response.ok) {
      throw new Error(`Gagal mengirim laporan ke server (status ${response.status}).`);
    }

    return report;
  }

  async function resolveReportOnSupabase(id) {
    const response = await fetch(`${REPORTS_ENDPOINT}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({ status: "resolved" }),
    });

    if (!response.ok) {
      throw new Error(`Supabase PATCH merespons dengan status ${response.status}`);
    }
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function formatDateTime(isoString) {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return "-";
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

  function formatRemainingTime(expiresAtIso) {
    if (!expiresAtIso) return "Waktu kedaluwarsa tidak diketahui";
    const diffMs = new Date(expiresAtIso).getTime() - Date.now();
    if (Number.isNaN(diffMs)) return "Waktu kedaluwarsa tidak diketahui";
    if (diffMs <= 0) return "Kedaluwarsa";

    const totalMinutes = Math.floor(diffMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours >= 1) return `Sisa waktu: ${hours} jam lagi`;
    return `Sisa waktu: ${Math.max(minutes, 1)} menit lagi`;
  }

  function createUserReportIcon() {
    return L.divIcon({
      className: "user-report-marker",
      html: `
        <span style="
          position:relative;display:flex;align-items:center;justify-content:center;
          width:32px;height:32px;border-radius:50% 50% 50% 0;
          background:#FF6B35;transform:rotate(-45deg);
          box-shadow:0 3px 8px rgba(0,0,0,0.4);border:2px solid #fff;
        ">
          <i class="fa-solid fa-user" style="transform:rotate(45deg);color:#fff;font-size:13px;"></i>
        </span>
      `,
      iconSize: [32, 32],
      iconAnchor: [16, 32],
      popupAnchor: [0, -30],
    });
  }

  /* ---------- Pop-up Laporan dengan Validasi Hak Akses ---------- */
  function buildReportPopup(report) {
    const label = DISASTER_LABELS[report.disasterType] || "Lainnya";
    const reportId = String(report.id).replace(/'/g, "");
    const photoHtml = report.photoUrl 
      ? `<div style="margin-top:8px;margin-bottom:6px;"><img src="${escapeHtml(report.photoUrl)}" style="width:100%;max-height:140px;object-fit:cover;border-radius:8px;cursor:pointer;" onclick="window.open('${escapeHtml(report.photoUrl)}', '_blank')"></div>` 
      : '';

    // Cek User yang sedang login
    const currentUser = typeof window.getCurrentUser === "function" ? window.getCurrentUser() : null;
    const isAdmin = currentUser && currentUser.role === "admin";
    const isOwner = currentUser && report.reporterName && 
      (currentUser.username.trim().toLowerCase() === String(report.reporterName).trim().toLowerCase());

    // Tombol Hapus hanya muncul untuk Admin atau Pemilik Laporan
    const deleteButtonHtml = (isAdmin || isOwner)
      ? `<button type="button" onclick="resolveReport('${reportId}')" class="btn-delete-report">
          ✅ Selesaikan / Hapus Laporan
         </button>`
      : '';

    return `
      <div style="min-width:215px;font-family:inherit;">
        <div style="display:flex;align-items:center;gap:6px;font-weight:700;color:#FF6B35;margin-bottom:4px;">
          <i class="fa-solid fa-user"></i> Laporan Warga · ${escapeHtml(label)}
        </div>
        ${photoHtml}
        <div style="font-size:12.5px;color:#16212b;margin-bottom:6px;line-height:1.4;">
          ${escapeHtml(report.description || "Tidak ada deskripsi tambahan.")}
        </div>
        <div style="font-size:12px;color:#5A6472;margin-bottom:2px;">
          <i class="fa-regular fa-user"></i> ${escapeHtml(report.reporterName || "Anonim")}
        </div>
        <div style="font-size:11.5px;color:#5A6472;margin-bottom:6px;">
          <i class="fa-regular fa-clock"></i> ${formatDateTime(report.createdAt)}
        </div>
        <div style="margin-bottom:8px;">
          <span class="ttl-badge">⏳ ${escapeHtml(formatRemainingTime(report.expiresAt))}</span>
          <span class="source-badge user-report">👤 Sumber: Crowdsourcing Warga</span>
        </div>
        ${deleteButtonHtml}
      </div>
    `;
  }

  function renderReportMarker(report) {
    if (!userReportsLayer || !report || report.id == null) return;
    if (Number.isNaN(report.lat) || Number.isNaN(report.lng)) return;

    const marker = L.marker([report.lat, report.lng], { icon: createUserReportIcon() });
    marker.bindPopup(buildReportPopup(report));
    marker.on("popupopen", () => marker.setPopupContent(buildReportPopup(report)));

    userReportsLayer.addLayer(marker);
    markersById[report.id] = marker;
  }

  function removeReportMarker(id) {
    const marker = markersById[id];
    if (marker && userReportsLayer) {
      userReportsLayer.removeLayer(marker);
    }
    delete markersById[id];
  }

  function activateLocationSelectionMode(map) {
    if (isSelectingLocation) return;
    isSelectingLocation = true;
    const targetMap = map || mapRef || window.mapRef;
    if (!targetMap) return;

    targetMap.getContainer().classList.add("crosshair-cursor-enabled");
    showToast("Klik lokasi kejadian pada peta... (Tekan ESC untuk batal)");
    targetMap.once("click", handleMapClick);
  }

  function deactivateLocationSelectionMode(map) {
    isSelectingLocation = false;
    const targetMap = map || mapRef || window.mapRef;
    if (!targetMap) return;

    targetMap.getContainer().classList.remove("crosshair-cursor-enabled");
    targetMap.off("click", handleMapClick);
  }

  function handleMapClick(e) {
    if (!e || !e.latlng) return;
    deactivateLocationSelectionMode(mapRef);
    openReportModal(e.latlng);
  }

  function openReportModal(latlng) {
    const modal = document.getElementById("reportModal");
    const latInput = document.getElementById("reportLat");
    const lngInput = document.getElementById("reportLng");

    if (!modal || !latInput || !lngInput) return;
    latInput.value = latlng.lat.toFixed(6);
    lngInput.value = latlng.lng.toFixed(6);

    // Otomatis isi Nama Pelapor jika user sedang login
    const currentUser = typeof window.getCurrentUser === "function" ? window.getCurrentUser() : null;
    const nameInput = document.getElementById("reportName");
    if (nameInput && currentUser) {
      nameInput.value = currentUser.username;
    }

    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
  }

  function closeReportModal() {
    const modal = document.getElementById("reportModal");
    const form = document.getElementById("reportForm");
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (form) form.reset();
  }

  let toastTimer = null;
  function showToast(message) {
    const toast = document.getElementById("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("is-visible");
    }, 3500);
  }

  function safeUpdateDashboardStats() {
    if (typeof window.updateDashboardStats !== "function") return;
    try {
      window.updateDashboardStats();
    } catch (error) {
      console.error("Gagal memperbarui statistik dashboard:", error);
    }
  }

  async function handleFormSubmit(event) {
    event.preventDefault();

    const latEl = document.getElementById("reportLat");
    const lngEl = document.getElementById("reportLng");
    const typeEl = document.getElementById("reportType");
    const descEl = document.getElementById("reportDescription");
    const nameEl = document.getElementById("reportName");
    const photoEl = document.getElementById("reportPhoto");

    const lat = parseFloat(latEl ? latEl.value : NaN);
    const lng = parseFloat(lngEl ? lngEl.value : NaN);

    if (Number.isNaN(lat) || Number.isNaN(lng)) {
      showToast("Lokasi belum valid. Silakan pilih titik pada peta terlebih dahulu.");
      return;
    }

    // Upload foto jika ada
    let photoUrl = null;
    if (photoEl && photoEl.files && photoEl.files[0]) {
      const file = photoEl.files[0];
      if (file.size > 4 * 1024 * 1024) {
        alert("Ukuran foto melebihi batas 4 MB!");
        return;
      }

      try {
        const fileName = `photo_${Date.now()}.${file.name.split('.').pop()}`;
        const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/disaster-photos/${fileName}`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': file.type
          },
          body: file
        });

        if (uploadRes.ok) {
          photoUrl = `${SUPABASE_URL}/storage/v1/object/public/disaster-photos/${fileName}`;
        }
      } catch (err) {
        console.error("Gagal upload foto:", err);
      }
    }

    const draftReport = {
      id: generateReportId(),
      lat,
      lng,
      disasterType: typeEl ? typeEl.value : "other",
      description: descEl ? descEl.value.trim() : "",
      reporterName: nameEl ? nameEl.value.trim() || "Anonim" : "Anonim",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + TTL_MS).toISOString(),
      status: "pending",
      photo_url: photoUrl
    };

    const submitBtn = document.getElementById("reportSubmitBtn");
    if (submitBtn) submitBtn.disabled = true;

    try {
      await insertReport(draftReport);
      closeReportModal();
      showToast("✅ Laporan berhasil dikirim! Menunggu verifikasi admin.");
    } catch (error) {
      console.error("Gagal mengirim laporan:", error);
      showToast(error.message || "Gagal mengirim laporan ke server.");
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    const form = document.getElementById("reportForm");
    const closeBtn = document.getElementById("reportModalClose");
    const cancelBtn = document.getElementById("reportCancelBtn");
    const modal = document.getElementById("reportModal");

    if (form) form.addEventListener("submit", handleFormSubmit);
    if (closeBtn) closeBtn.addEventListener("click", closeReportModal);
    if (cancelBtn) cancelBtn.addEventListener("click", closeReportModal);

    if (modal) {
      modal.addEventListener("click", (event) => {
        if (event.target === modal) closeReportModal();
      });
    }

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        if (isSelectingLocation) {
          deactivateLocationSelectionMode(mapRef);
          showToast("Sesi pemilihan lokasi dibatalkan.");
        } else if (modal && modal.classList.contains("is-open")) {
          closeReportModal();
        }
      }
    });
  });

  /* report.js — Perbaikan pada fungsi refreshReportsFromServer */
async function refreshReportsFromServer() {
  try {
    const reports = await fetchActiveReports();
    cachedReports = reports;

    if (userReportsLayer) userReportsLayer.clearLayers();
    markersById = {};
    reports.forEach(renderReportMarker);

    safeUpdateDashboardStats();

    // OTOMATIS LOAD FASKES SAAT DATA LAPORAN SUPABASE SELESAI DITERIMA
    const shelterCheckbox = document.getElementById("chk-shelter");
    if (shelterCheckbox && shelterCheckbox.checked && typeof window.loadShelterData === "function" && mapRef) {
      window.loadShelterData(mapRef);
    }
  } catch (error) {
    console.error("Gagal memuat laporan warga dari Supabase:", error);
  }
}

  /* ---------- Eksekusi Penghapusan Laporan (dengan Proteksi ganda) ---------- */
  window.resolveReport = async function resolveReport(id) {
    if (id == null) return;

    const targetReport = cachedReports.find((r) => String(r.id) === String(id));
    const currentUser = typeof window.getCurrentUser === "function" ? window.getCurrentUser() : null;
    const isAdmin = currentUser && currentUser.role === "admin";
    const isOwner = currentUser && targetReport && targetReport.reporterName && 
      (currentUser.username.trim().toLowerCase() === String(targetReport.reporterName).trim().toLowerCase());

    // Blokir jika bukan Admin dan bukan Pemilik Laporan
    if (!isAdmin && !isOwner) {
      showToast("⛔ Anda tidak memiliki izin untuk menghapus laporan ini.");
      return;
    }

    if (typeof window.confirm === "function") {
      if (!window.confirm("Tandai laporan ini sebagai selesai dan hapus dari peta?")) return;
    }

    try {
      await resolveReportOnSupabase(id);
      removeReportMarker(id);
      cachedReports = cachedReports.filter((report) => String(report.id) !== String(id));
      showToast("Laporan ditandai selesai dan dihapus dari peta.");
    } catch (error) {
      showToast("Gagal menghapus laporan. Coba lagi.");
    } finally {
      safeUpdateDashboardStats();
    }
  };

  window.initReportFeature = async function initReportFeature(map) {
    mapRef = map;
    window.mapRef = map;
    userReportsLayer = L.layerGroup().addTo(map);

    const reportBtn = document.getElementById("reportBtn");
    if (reportBtn) {
      reportBtn.addEventListener("click", () => activateLocationSelectionMode(mapRef));
    }

    await refreshReportsFromServer();
    setInterval(refreshReportsFromServer, REFRESH_INTERVAL_MS);
  };

  window.refreshReportsFromServer = refreshReportsFromServer;
  window.getUserReports = function getUserReports() { return cachedReports.slice(); };
  window.showToast = showToast;
  window.isReportLocationSelectionActive = function isReportLocationSelectionActive() { return isSelectingLocation; };
})();
