/* =========================================================
   WebGIS Pemantauan Bencana — Admin Moderation & User Management Panel
   ========================================================= */

(function () {
  const SUPABASE_URL = "https://vxynzouszcgnvrjyzivy.supabase.co";
  const SUPABASE_KEY = "sb_publishable_EtvBeDvLiJmQt537qLQGOw_jv-xHiNA";
  const REPORTS_ENDPOINT = `${SUPABASE_URL}/rest/v1/reports`;
  const USERS_ENDPOINT = `${SUPABASE_URL}/rest/v1/app_users`;

  function supabaseHeaders() {
    return {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    };
  }

  // Cek status Admin
  window.checkAdminStatus = function checkAdminStatus() {
    const role = sessionStorage.getItem("user_role");
    const adminBtn = document.getElementById("adminPanelBtn");
    if (adminBtn) {
      adminBtn.style.display = role === "admin" ? "inline-flex" : "none";
    }
  };

  // Switch Tab Admin (Moderasi Laporan <-> Kelola Pengguna)
  window.switchAdminTab = function switchAdminTab(tabName) {
    const reportsTab = document.getElementById("tabPendingReports");
    const usersTab = document.getElementById("tabManageUsers");
    const reportsList = document.getElementById("adminPendingList");
    const usersList = document.getElementById("adminUsersList");

    if (!reportsTab || !usersTab || !reportsList || !usersList) return;

    if (tabName === "reports") {
      reportsTab.classList.add("is-active");
      usersTab.classList.remove("is-active");
      reportsList.style.display = "flex";
      usersList.style.display = "none";
      loadPendingReportsList();
    } else {
      usersTab.classList.add("is-active");
      reportsTab.classList.remove("is-active");
      reportsList.style.display = "none";
      usersList.style.display = "flex";
      loadUsersList();
    }
  };

  /* ---------- MODERASI LAPORAN ---------- */
  async function fetchPendingReports() {
    const response = await fetch(`${REPORTS_ENDPOINT}?status=eq.pending`, {
      method: "GET",
      headers: supabaseHeaders(),
    });
    if (!response.ok) return [];
    return await response.json();
  }

  /* admin.js — Perbaikan pada fungsi approveReport */
window.approveReport = async function approveReport(id) {
  try {
    const response = await fetch(`${REPORTS_ENDPOINT}?id=eq.${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify({ status: "approved" }),
    });

    if (!response.ok) throw new Error("Gagal menyetujui laporan");

    if (window.showToast) window.showToast("✅ Laporan berhasil disetujui & diterbitkan ke peta!");
    loadPendingReportsList();

    // 1. Refresh titik bencana di peta
    if (typeof window.refreshReportsFromServer === "function") {
      await window.refreshReportsFromServer();
    }

    // 2. OTOMATIS TARIK FASKES TERDEKAT (5 km) UNTUK TITIK BENCANA BARU
    if (typeof window.loadShelterData === "function" && window.mapRef) {
      await window.loadShelterData(window.mapRef);
    }
  } catch (err) {
    alert(err.message);
  }
};

  window.rejectReport = async function rejectReport(id) {
    if (!confirm("Apakah Anda yakin ingin menolak & menghapus laporan ini?")) return;

    try {
      const response = await fetch(`${REPORTS_ENDPOINT}?id=eq.${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: supabaseHeaders(),
        body: JSON.stringify({ status: "rejected" }),
      });

      if (!response.ok) throw new Error("Gagal menolak laporan");

      if (window.showToast) window.showToast("❌ Laporan ditolak");
      loadPendingReportsList();
    } catch (err) {
      alert(err.message);
    }
  };

  async function loadPendingReportsList() {
    const container = document.getElementById("adminPendingList");
    if (!container) return;

    container.innerHTML = '<div style="padding:15px;text-align:center;">Memuat laporan pending...</div>';
    const pendingList = await fetchPendingReports();

    if (pendingList.length === 0) {
      container.innerHTML = '<div style="padding:20px;text-align:center;color:#666;">🎉 Tidak ada laporan pending yang perlu diverifikasi.</div>';
      return;
    }

    container.innerHTML = pendingList
      .map((item) => {
        const photo = item.photo_url
          ? `<img src="${item.photo_url}" style="width:100%;max-height:160px;object-fit:cover;border-radius:8px;margin-top:8px;" onclick="window.open('${item.photo_url}', '_blank')">`
          : '<div style="font-size:11px;color:#888;margin-top:6px;">(Tanpa Lampiran Foto)</div>';

        return `
          <div class="admin-card">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <strong style="color:#d32f2f;">🚨 Laporan ${item.jenis || "Bencana"}</strong>
              <small style="color:#666;">${new Date(item.created_at).toLocaleString("id-ID")}</small>
            </div>
            <div style="font-size:13px;margin:6px 0;">${item.deskripsi || "Tanpa deskripsi"}</div>
            <div style="font-size:12px;color:#555;"><strong>Pelapor:</strong> ${item.nama || "Anonim"} (${item.lat.toFixed(4)}, ${item.lng.toFixed(4)})</div>
            ${photo}
            <div style="display:flex;gap:8px;margin-top:10px;">
              <button onclick="approveReport('${item.id}')" class="btn-approve">✅ Setujui (Terbitkan)</button>
              <button onclick="rejectReport('${item.id}')" class="btn-reject">❌ Tolak</button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  /* ---------- KELOLA PENGGUNA ---------- */
  async function fetchAllUsers() {
    const response = await fetch(`${USERS_ENDPOINT}?select=id,username,role`, {
      method: "GET",
      headers: supabaseHeaders(),
    });
    if (!response.ok) return [];
    return await response.json();
  }

  async function loadUsersList() {
    const container = document.getElementById("adminUsersList");
    if (!container) return;

    container.innerHTML = '<div style="padding:15px;text-align:center;">Memuat daftar pengguna...</div>';
    const users = await fetchAllUsers();

    if (users.length === 0) {
      container.innerHTML = '<div style="padding:15px;text-align:center;">Tidak ada pengguna terdaftar.</div>';
      return;
    }

    container.innerHTML = users
      .map((u) => {
        const isAdminRole = u.role === "admin";
        return `
          <div class="admin-card" style="display:flex;justify-content:space-between;align-items:center;">
            <div>
              <strong>👤 ${u.username}</strong>
              <span style="font-size:11px;padding:2px 8px;border-radius:10px;margin-left:6px;background:${isAdminRole ? '#e8f5e9' : '#f1f5f9'};color:${isAdminRole ? '#2e7d32' : '#475569'};font-weight:bold;">
                ${u.role.toUpperCase()}
              </span>
            </div>
            <div>
              ${
                isAdminRole
                  ? `<button onclick="toggleUserRole('${u.id}', 'user')" style="background:#f5a623;color:white;border:none;padding:5px 10px;border-radius:6px;font-size:11px;cursor:pointer;">Demote ke User</button>`
                  : `<button onclick="toggleUserRole('${u.id}', 'admin')" style="background:#2e7d32;color:white;border:none;padding:5px 10px;border-radius:6px;font-size:11px;cursor:pointer;">Jadikan Admin</button>`
              }
            </div>
          </div>
        `;
      })
      .join("");
  }

  window.toggleUserRole = async function toggleUserRole(userId, newRole) {
    try {
      const response = await fetch(`${USERS_ENDPOINT}?id=eq.${encodeURIComponent(userId)}`, {
        method: "PATCH",
        headers: supabaseHeaders(),
        body: JSON.stringify({ role: newRole }),
      });

      if (!response.ok) throw new Error("Gagal mengubah peran pengguna");

      if (window.showToast) window.showToast(`✅ Peran berhasil diubah menjadi ${newRole.toUpperCase()}`);
      loadUsersList();
    } catch (err) {
      alert(err.message);
    }
  };

  /* ---------- Event Listeners ---------- */
  document.addEventListener("DOMContentLoaded", () => {
    window.checkAdminStatus();

    const adminBtn = document.getElementById("adminPanelBtn");
    const adminModal = document.getElementById("adminModal");
    const adminCloseBtn = document.getElementById("adminModalClose");

    if (adminBtn && adminModal) {
      adminBtn.addEventListener("click", () => {
        adminModal.classList.add("is-open");
        window.switchAdminTab("reports");
      });
    }

    if (adminCloseBtn && adminModal) {
      adminCloseBtn.addEventListener("click", () => {
        adminModal.classList.remove("is-open");
      });
    }
  });
})();