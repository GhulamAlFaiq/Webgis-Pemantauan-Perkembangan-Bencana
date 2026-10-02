/* =========================================================
   WebGIS Pemantauan Bencana — Autentikasi (Login / Daftar)
   ========================================================= */

(function () {
  /* ---------- Supabase configuration ---------- */
  const SUPABASE_URL = "https://vxynzouszcgnvrjyzivy.supabase.co";
  const SUPABASE_KEY = "sb_publishable_EtvBeDvLiJmQt537qLQGOw_jv-xHiNA";
  const USERS_TABLE = "app_users";
  const USERS_ENDPOINT = `${SUPABASE_URL}/rest/v1/${USERS_TABLE}`;

  const USERNAME_PATTERN = /^[A-Za-z0-9_.-]{3,30}$/;
  const MIN_PASSWORD_LENGTH = 6;
  const ADMIN_SECRET_KEY = "ADMIN2026"; // Kode rahasia pendaftaran Admin

  /* ---------- DOM references ---------- */
  const openBtn = document.getElementById("authOpenBtn");
  const userBox = document.getElementById("authUser");
  const usernameEl = document.getElementById("authUsername");
  const logoutBtn = document.getElementById("logoutBtn");

  const modal = document.getElementById("authModal");
  const closeBtn = document.getElementById("authModalClose");
  const messageEl = document.getElementById("authMessage");
  const tabButtons = document.querySelectorAll("[data-auth-tab]");

  const loginForm = document.getElementById("loginForm");
  const signupForm = document.getElementById("signupForm");
  const loginSubmitBtn = document.getElementById("loginSubmitBtn");
  const signupSubmitBtn = document.getElementById("signupSubmitBtn");

  /* ---------- Small helpers ---------- */
  function notify(message) {
    if (typeof window.showToast === "function") window.showToast(message);
  }

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

  function storageGet(key) {
    try {
      return sessionStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }
  function storageSet(key, value) {
    try {
      sessionStorage.setItem(key, value);
    } catch (e) {
      console.error("sessionStorage tidak tersedia:", e);
    }
  }
  function storageRemove(key) {
    try {
      sessionStorage.removeItem(key);
    } catch (e) {
      /* ignore */
    }
  }

  async function hashPassword(username, password) {
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error("Browser tidak mendukung enkripsi. Buka situs lewat HTTPS atau localhost.");
    }
    const bytes = new TextEncoder().encode(`${username}:${password}`);
    const digest = await window.crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  /* ---------- Session + header UI ---------- */
  function getCurrentUser() {
    const username = storageGet("username");
    const role = storageGet("user_role");
    return username && role ? { username, role } : null;
  }

  function checkAuthGate() {
    const user = getCurrentUser();
    
    if (!user) {
      if (modal) {
        modal.classList.add("is-open");
        modal.setAttribute("aria-hidden", "false");
      }
      if (closeBtn) closeBtn.style.display = "none";
    } else {
      if (closeBtn) closeBtn.style.display = "flex";
      if (modal && modal.classList.contains("is-open")) {
        modal.classList.remove("is-open");
        modal.setAttribute("aria-hidden", "true");
      }
    }
  }

  function renderAuthState() {
    const user = getCurrentUser();
    if (openBtn) openBtn.hidden = !!user;
    if (userBox) userBox.hidden = !user;
    if (usernameEl) usernameEl.textContent = user ? user.username : "";
    if (userBox) userBox.title = user ? `Peran: ${user.role}` : "";

    checkAuthGate();
    if (typeof window.checkAdminStatus === "function") {
      window.checkAdminStatus();
    }
  }

  function emitAuthChange() {
    window.dispatchEvent(new CustomEvent("auth:change", { detail: getCurrentUser() }));
  }

  /* ---------- Modal controls ---------- */
  function showMessage(text, type) {
    if (!messageEl) return;
    if (!text) {
      messageEl.hidden = true;
      messageEl.textContent = "";
      return;
    }
    messageEl.textContent = text;
    messageEl.className = `auth-message auth-message--${type || "error"}`;
    messageEl.hidden = false;
  }

  function switchTab(tab) {
    const isLogin = tab !== "signup";
    tabButtons.forEach((btn) => {
      const active = btn.dataset.authTab === (isLogin ? "login" : "signup");
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    if (loginForm) loginForm.hidden = !isLogin;
    if (signupForm) signupForm.hidden = isLogin;
    showMessage("");

    const firstInput = (isLogin ? loginForm : signupForm).querySelector("input");
    if (firstInput) setTimeout(() => firstInput.focus(), 50);
  }

  function openAuthModal(tab) {
    if (!modal) return;
    modal.classList.add("is-open");
    modal.setAttribute("aria-hidden", "false");
    switchTab(tab || "login");
  }

  function closeAuthModal() {
    if (!modal) return;
    modal.classList.remove("is-open");
    modal.setAttribute("aria-hidden", "true");
    if (loginForm) loginForm.reset();
    if (signupForm) signupForm.reset();
    showMessage("");
  }

  /* ---------- Supabase: signup ---------- */
  async function usernameExists(username) {
    const url = `${USERS_ENDPOINT}?username=eq.${encodeURIComponent(username)}&select=username&limit=1`;
    const response = await fetch(url, { method: "GET", headers: supabaseHeaders() });
    if (!response.ok) return false;
    const rows = await response.json();
    return Array.isArray(rows) && rows.length > 0;
  }

  async function signUp(username, password, adminCode) {
    if (await usernameExists(username)) {
      throw new Error("Username sudah digunakan. Pilih username lain.");
    }

    const passwordHash = await hashPassword(username, password);
    const assignedRole = (adminCode && adminCode.trim() === ADMIN_SECRET_KEY) ? "admin" : "user";

    let response;
    try {
      response = await fetch(USERS_ENDPOINT, {
        method: "POST",
        headers: supabaseHeaders({ Prefer: "return=minimal" }),
        body: JSON.stringify({ 
          username, 
          password: passwordHash, 
          role: assignedRole 
        }),
      });
    } catch (networkError) {
      console.error("Gagal terhubung ke Supabase:", networkError);
      throw new Error("Tidak dapat terhubung ke server. Periksa koneksi internet Anda.");
    }

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      console.error(`Signup gagal — status ${response.status}:`, errorBody);

      if (response.status === 409) {
        throw new Error("Username sudah digunakan. Pilih username lain.");
      }
      throw new Error(`Pendaftaran gagal (status ${response.status}).`);
    }

    if (assignedRole === "admin") {
      notify("🎉 Pendaftaran berhasil! Akun Anda memiliki hak akses ADMIN.");
    }
  }

  /* ---------- Supabase: login ---------- */
  async function logIn(username, password) {
    const passwordHash = await hashPassword(username, password);
    const url =
      `${USERS_ENDPOINT}?username=eq.${encodeURIComponent(username)}` +
      `&password=eq.${encodeURIComponent(passwordHash)}&select=username,role&limit=1`;

    let response;
    try {
      response = await fetch(url, { method: "GET", headers: supabaseHeaders() });
    } catch (networkError) {
      console.error("Gagal terhubung ke Supabase:", networkError);
      throw new Error("Tidak dapat terhubung ke server. Periksa koneksi internet Anda.");
    }

    if (!response.ok) {
      throw new Error(`Login gagal (status ${response.status}).`);
    }

    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error("Username atau password salah.");
    }
    return rows[0];
  }

  /* ---------- Form handlers ---------- */
  function setBusy(button, busy) {
    if (button) button.disabled = busy;
  }

  async function handleSignupSubmit(event) {
    event.preventDefault();
    const username = document.getElementById("signupUsername").value.trim();
    const password = document.getElementById("signupPassword").value;
    const adminCodeInput = document.getElementById("signupAdminCode");
    const adminCode = adminCodeInput ? adminCodeInput.value : "";

    if (!USERNAME_PATTERN.test(username)) {
      showMessage("Username 3–30 karakter: huruf, angka, titik, garis bawah, atau strip.", "error");
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      showMessage(`Password minimal ${MIN_PASSWORD_LENGTH} karakter.`, "error");
      return;
    }

    setBusy(signupSubmitBtn, true);
    try {
      await signUp(username, password, adminCode);
      switchTab("login");
      document.getElementById("loginUsername").value = username;
      document.getElementById("loginPassword").focus();
      signupForm.reset();
      showMessage("Pendaftaran berhasil! Silakan login.", "success");
    } catch (error) {
      showMessage(error && error.message ? error.message : "Pendaftaran gagal. Coba lagi.", "error");
    } finally {
      setBusy(signupSubmitBtn, false);
    }
  }

  async function handleLoginSubmit(event) {
    event.preventDefault();
    const username = document.getElementById("loginUsername").value.trim();
    const password = document.getElementById("loginPassword").value;

    if (!username || !password) {
      showMessage("Username dan password wajib diisi.", "error");
      return;
    }

    setBusy(loginSubmitBtn, true);
    try {
      const user = await logIn(username, password);
      storageSet("user_role", user.role);
      storageSet("username", user.username);

      renderAuthState();
      closeAuthModal();
      notify(`Selamat datang, ${user.username}!`);
      emitAuthChange();
    } catch (error) {
      showMessage(error && error.message ? error.message : "Login gagal. Coba lagi.", "error");
    } finally {
      setBusy(loginSubmitBtn, false);
    }
  }

  function handleLogout() {
    storageRemove("user_role");
    storageRemove("username");
    renderAuthState();
    notify("Anda telah logout.");
    emitAuthChange();
  }

  /* ---------- Wiring ---------- */
  if (openBtn) openBtn.addEventListener("click", () => openAuthModal("login"));
  if (logoutBtn) logoutBtn.addEventListener("click", handleLogout);
  if (closeBtn) closeBtn.addEventListener("click", closeAuthModal);
  if (loginForm) loginForm.addEventListener("submit", handleLoginSubmit);
  if (signupForm) signupForm.addEventListener("submit", handleSignupSubmit);

  tabButtons.forEach((btn) => {
    btn.addEventListener("click", () => switchTab(btn.dataset.authTab));
  });

  if (modal) {
    modal.addEventListener("click", (event) => {
      if (event.target === modal && getCurrentUser()) closeAuthModal();
    });
  }

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modal && modal.classList.contains("is-open") && getCurrentUser()) {
      closeAuthModal();
    }
  });

  /* ---------- Public API ---------- */
  window.getCurrentUser = getCurrentUser;
  window.isAdmin = function isAdmin() {
    const user = getCurrentUser();
    return !!user && user.role === "admin";
  };

  renderAuthState();
})();