const WORKER_API = "";

// Ссылки, которые уже отдали ошибку, второй раз не дёргаем — иначе каждая
// перерисовка карточки идёт на S3 и засоряет лог.
const _deadPhotos = new Set();

function markPhotoDead(src) {
  const m = /[?&]url=([^&]+)/.exec(src || "");
  if (m) _deadPhotos.add(decodeURIComponent(m[1]));
}

function proxyPhoto(url, accountId) {
  if (!url) return "";
  if (_deadPhotos.has(url)) return "";
  if (url.includes("amazonaws.com") || url.includes("lovelaz.") || url.includes("loveplanet.")) {
    return `/api/proxy-image?url=${encodeURIComponent(url)}&account_id=${accountId || ""}`;
  }
  return url;
}

document.addEventListener("error", (e) => {
  const img = e.target;
  if (img && img.tagName === "IMG" && (img.src || "").includes("/api/proxy-image")) {
    markPhotoDead(img.src);
  }
}, true);

// ── Авторизация ───────────────────────────────────────────

const AUTH_TOKEN_KEY = "claw_auth_token";

function getAuthToken() {
  try { return localStorage.getItem(AUTH_TOKEN_KEY); } catch { return null; }
}

function setAuthToken(token) {
  try { localStorage.setItem(AUTH_TOKEN_KEY, token); } catch {}
}

function clearAuthToken() {
  try { localStorage.removeItem(AUTH_TOKEN_KEY); } catch {}
}

// Подклеиваем токен авторизации ко всем запросам на /api/
const _origFetch = window.fetch;

window.fetch = function(url, options = {}) {
  const urlStr =
    typeof url === "string"
      ? url
      : (url?.url || "");

  const token = getAuthToken();

  if (urlStr.startsWith("/api/") || urlStr.includes("/api/")) {
    options = {
      ...options,
      headers: {
        ...(options.headers || {}),
        "ngrok-skip-browser-warning": "true",
        ...(token ? { "Authorization": `Bearer ${token}` } : {}),
      },
    };
  }

  return _origFetch(url, options);
};

const authOverlay   = document.getElementById("authOverlay");
const authTabLogin  = document.getElementById("authTabLogin");
const authTabRegister = document.getElementById("authTabRegister");
const loginForm     = document.getElementById("loginForm");
const registerForm  = document.getElementById("registerForm");
const loginError    = document.getElementById("loginError");
const registerError = document.getElementById("registerError");
const userCardEmail = document.getElementById("userCardEmail");

const notificationsBell = document.getElementById("notificationsBell");
const notificationsCount = document.getElementById("notificationsCount");
const notificationsModal = document.getElementById("notificationsModal");
const notificationsModalClose = document.getElementById("notificationsModalClose");
const notificationsList = document.getElementById("notificationsList");

const teamInviteBtn = document.getElementById("teamInviteBtn");
const teamInviteEmail = document.getElementById("teamInviteEmail");
const teamInviteRole = document.getElementById("teamInviteRole");
const teamInviteResult = document.getElementById("teamInviteResult");

const teamMembersList = document.getElementById("teamMembersList");


function hideAuthOverlay() {
  if (authOverlay) authOverlay.style.display = "none";
  const mainApp = document.getElementById("mainApp");
  if (mainApp) mainApp.style.display = "";
}

authTabLogin?.addEventListener("click", () => {
  authTabLogin.classList.add("active");
  authTabRegister.classList.remove("active");
  loginForm.style.display = "flex";
  loginForm.style.flexDirection = "column";
  registerForm.style.display = "none";
});

authTabRegister?.addEventListener("click", () => {
  authTabRegister.classList.add("active");
  authTabLogin.classList.remove("active");
  registerForm.style.display = "flex";
  registerForm.style.flexDirection = "column";
  loginForm.style.display = "none";
});

loginForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError.textContent = "";
  const email = document.getElementById("loginEmail").value.trim();
  const password = document.getElementById("loginPassword").value;
  const access_code = document.getElementById("loginAccessCode").value.trim();
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, access_code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Ошибка входа");
    setAuthToken(data.token);
    if (userCardEmail) userCardEmail.textContent = data.email;
    {
      const fallback = (data.email || "").split("@")[0] || "Аккаунт";
      const shown = data.username || fallback;
      const letter = shown.charAt(0).toUpperCase();
      const nameEl = document.querySelector(".userCard b");
      if (nameEl) nameEl.textContent = shown;
      const avatarEl = document.querySelector(".userAvatar");
      if (avatarEl) avatarEl.textContent = letter;
      const tName = document.getElementById("topUserName");
      if (tName) tName.textContent = shown;
      const tAv = document.getElementById("topAvatar");
      if (tAv) tAv.textContent = letter;
    }
    hideAuthOverlay();
    startApp();
  } catch (err) {
    loginError.textContent = err.message || "Не удалось войти";
  }
});

registerForm?.addEventListener("submit", async (e) => {
  e.preventDefault();
  registerError.textContent = "";
  const username = document.getElementById("registerUsername").value.trim();
  const email = document.getElementById("registerEmail").value.trim();
  const password = document.getElementById("registerPassword").value;
  const access_code = document.getElementById("registerAccessCode").value.trim();
  try {
    const res = await fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, email, password, access_code }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Ошибка регистрации");
    setAuthToken(data.token);
    if (userCardEmail) userCardEmail.textContent = data.email;
    if (username) {
      const letter = username.charAt(0).toUpperCase();
      const nameEl = document.querySelector(".userCard b");
      if (nameEl) nameEl.textContent = username;
      const avatarEl = document.querySelector(".userAvatar");
      if (avatarEl) avatarEl.textContent = letter;
      const tName = document.getElementById("topUserName");
      if (tName) tName.textContent = username;
      const tAv = document.getElementById("topAvatar");
      if (tAv) tAv.textContent = letter;
    }
    hideAuthOverlay();
    startApp();
  } catch (err) {
    registerError.textContent = err.message || "Не удалось зарегистрироваться";
  }
});

async function checkAuthAndStart() {
  const token = getAuthToken();
  
  // Показываем экран загрузки пока проверяем токен
  const loadingScreen = document.getElementById("authLoadingScreen");
  const authBox = document.querySelector(".authBox");
  if (authBox) authBox.style.display = "none";
  if (authOverlay) authOverlay.style.display = "flex";

  if (!token) {
    if (loadingScreen) loadingScreen.style.display = "none";
    if (authBox) authBox.style.display = "";
    return;
  }

  try {
    const res = await fetch("/api/auth/me");
    if (!res.ok) throw new Error("invalid session");
    const data = await res.json();
    if (userCardEmail) userCardEmail.textContent = data.email;
    {
      const fallback = (data.email || "").split("@")[0] || "Аккаунт";
      const shown = data.username || fallback;
      const letter = shown.charAt(0).toUpperCase();
      const nameEl = document.querySelector(".userCard b");
      if (nameEl) nameEl.textContent = shown;
      const avatarEl = document.querySelector(".userAvatar");
      if (avatarEl) avatarEl.textContent = letter;
      const tName = document.getElementById("topUserName");
      if (tName) tName.textContent = shown;
      const tAv = document.getElementById("topAvatar");
      if (tAv) tAv.textContent = letter;
    }
    hideAuthOverlay();
    startApp();
  } catch {
    clearAuthToken();
    if (loadingScreen) loadingScreen.style.display = "none";
    if (authBox) authBox.style.display = "";
  }
}

// ── Модалка удаления вкладки ───────────────────────────────

const deleteTabModal = document.getElementById("deleteTabModal");
const deleteTabName = document.getElementById("deleteTabName");
const deleteTabCancelBtn = document.getElementById("deleteTabCancelBtn");
const deleteTabConfirmBtn = document.getElementById("deleteTabConfirmBtn");
const deleteTabModalClose = document.getElementById("deleteTabModalClose");

let tabPendingDelete = null;

function openDeleteTabModal(tab) {
  tabPendingDelete = tab;
  if (deleteTabName) deleteTabName.textContent = tab.name;
  deleteTabModal?.classList.add("open");
}

function closeDeleteTabModal() {
  tabPendingDelete = null;
  deleteTabModal?.classList.remove("open");
}

deleteTabCancelBtn?.addEventListener("click", closeDeleteTabModal);
deleteTabModalClose?.addEventListener("click", closeDeleteTabModal);
deleteTabModal?.addEventListener("click", (e) => {
  if (e.target === deleteTabModal) closeDeleteTabModal();
});

deleteTabConfirmBtn?.addEventListener("click", async () => {
  if (!tabPendingDelete) return;
  const tab = tabPendingDelete;
  try {
    await fetch(WORKER_API + `/api/tabs/${encodeURIComponent(tab.id)}`, { method: "DELETE" });
    if (activeTabId === tab.id) {
      activeTabId = null;
      document.querySelector('.platformBtn[data-platform="Mamba"]')?.classList.add("active");
      activePlatform = "Mamba";
    }
    closeDeleteTabModal();
    await loadOperatorTabs();
    renderSquareGridFromCache();
  } catch (err) {
    alert("Не удалось удалить вкладку: " + err.message);
  }
});

// ── Модалка профиля ───────────────────────────────────────

const userCardBtn   = document.getElementById("userCardBtn");
const profileModal  = document.getElementById("profileModal");
const profileModalClose = document.getElementById("profileModalClose");
const profileEmail  = document.getElementById("profileEmail");
const profileCurrentPassword = document.getElementById("profileCurrentPassword");
const profileNewPassword     = document.getElementById("profileNewPassword");
const profileChangePasswordBtn = document.getElementById("profileChangePasswordBtn");
const profileChangeResult = document.getElementById("profileChangeResult");
const profileLogoutBtn = document.getElementById("profileLogoutBtn");

userCardBtn?.addEventListener("click", () => {
  if (profileEmail) profileEmail.value = userCardEmail?.textContent || "";
  const usernameInput = document.getElementById("profileUsername");
  if (usernameInput) {
    const currentName = document.querySelector(".userCard b")?.textContent || "";
    usernameInput.value = currentName;
  }
  if (profileChangeResult) { profileChangeResult.textContent = ""; profileChangeResult.className = "result"; }
  if (profileCurrentPassword) profileCurrentPassword.value = "";
  if (profileNewPassword) profileNewPassword.value = "";
  profileModal?.classList.add("open");
});

profileModalClose?.addEventListener("click", () => {
  profileModal?.classList.remove("open");
});

profileModal?.addEventListener("click", (e) => {
  if (e.target === profileModal) profileModal.classList.remove("open");
});


document.getElementById("profileChangeUsernameBtn")?.addEventListener("click", async () => {
  const usernameInput = document.getElementById("profileUsername");
  const resultEl = document.getElementById("profileUsernameResult");
  const newName = usernameInput?.value.trim();
  if (!newName) { 
    if (resultEl) { resultEl.textContent = "Введи имя."; resultEl.className = "result bad"; }
    return;
  }
  try {
    const res = await fetch("/api/auth/update-profile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: newName }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Ошибка");
    // Обновляем имя везде
    const nameEl = document.querySelector(".userCard b");
    if (nameEl) nameEl.textContent = newName;
    // Обновляем аватар-букву
    const avatarEl = document.querySelector(".userAvatar");
    if (avatarEl) avatarEl.textContent = newName.charAt(0).toUpperCase();
    const tName = document.getElementById("topUserName");
    if (tName) tName.textContent = newName;
    const tAv = document.getElementById("topAvatar");
    if (tAv) tAv.textContent = newName.charAt(0).toUpperCase();
    if (resultEl) { resultEl.textContent = "Имя сохранено."; resultEl.className = "result good"; }
  } catch (err) {
    if (resultEl) { resultEl.textContent = err.message || "Ошибка."; resultEl.className = "result bad"; }
  }
});

profileChangePasswordBtn?.addEventListener("click", async () => {
  const current_password = profileCurrentPassword.value;
  const new_password = profileNewPassword.value;
  if (!current_password || !new_password) {
    profileChangeResult.textContent = "Заполни оба поля пароля.";
    profileChangeResult.className = "result bad";
    return;
  }
  try {
    const res = await fetch("/api/auth/change-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ current_password, new_password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Не удалось сменить пароль");
    profileChangeResult.textContent = "Пароль успешно изменён.";
    profileChangeResult.className = "result good";
    profileCurrentPassword.value = "";
    profileNewPassword.value = "";
  } catch (err) {
    profileChangeResult.textContent = err.message || "Ошибка смены пароля";
    profileChangeResult.className = "result bad";
  }
});

profileLogoutBtn?.addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", { method: "POST" });
  } catch {}
  clearAuthToken();
  profileModal?.classList.remove("open");
  appStarted = false;
  location.reload();
});

const runningSplits = new Set();
window._splitLogs = {};

window._splitLogBuffer = {};

function pushLog(accountId, message) {
  if (!window._splitLogs[accountId]) return;
  const ts = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const line = `[${ts}] ${message}`;
  window._splitLogs[accountId].push(line);
  if (!window._splitLogBuffer[accountId]) window._splitLogBuffer[accountId] = [];
  window._splitLogBuffer[accountId].push(line);
}

setInterval(async () => {
  for (const accountId of Object.keys(window._splitLogBuffer)) {
    const messages = window._splitLogBuffer[accountId];
    if (!messages || !messages.length) continue;
    window._splitLogBuffer[accountId] = [];
    try {
      await fetch(WORKER_API + "/api/split-log/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId, messages }),
      });
    } catch (e) {
      console.warn("[pushLog] flush error:", e);
    }
  }
}, 5000);
const liveStats = {}; // { [accountId]: { liked, replied, contacts } }

function bumpLiveStat(accountId, field, amount = 1) {
  if (!liveStats[accountId]) {
    liveStats[accountId] = { liked: 0, replied: 0, contacts: 0 };
  }
  liveStats[accountId][field] = (liveStats[accountId][field] || 0) + amount;

  // Мгновенно обновляем DOM карточки
  const cardEl = document.querySelector(`.sqCard[data-account-id="${accountId}"]`);
  if (!cardEl) return;
  const likesVal    = cardEl.querySelector(".sqLikesVal");
  const msgsVal     = cardEl.querySelector(".sqMsgsVal");
  const contactsVal = cardEl.querySelector(".sqContactsVal");
  if (likesVal)    likesVal.textContent    = liveStats[accountId].liked;
  if (msgsVal)     msgsVal.textContent     = liveStats[accountId].replied;
  if (contactsVal) contactsVal.textContent = liveStats[accountId].contacts;
}

let reservedIds = new Set();
const form            = document.getElementById("connectForm");
const resultBox       = document.getElementById("resultBox");
const connectSlots    = document.getElementById("connectSlots");
const slotTemplate    = document.getElementById("connectSlotTemplate");
const addSlotBtn      = document.getElementById("addSlotBtn");

function addConnectSlot() {
  const node = slotTemplate.content.cloneNode(true);
  const slotEl = node.querySelector(".connectSlot");

  slotEl.querySelector(".slotRemoveBtn").addEventListener("click", () => {
    // не даём удалить последний оставшийся слот
    if (connectSlots.querySelectorAll(".connectSlot").length > 1) {
      slotEl.remove();
    }
  });

  connectSlots.appendChild(node);

  try {
    const isTwinby  = typeof activePlatform !== "undefined" && activePlatform === "Twinby";
    const isVzn     = typeof activePlatform !== "undefined" && activePlatform === "Vznakomstve";
    const isIntCity = typeof activePlatform !== "undefined" && activePlatform === "intCity";
    const isAtolin  = typeof activePlatform !== "undefined" && activePlatform === "Atolin";
    const isBadanga = typeof activePlatform !== "undefined" && (activePlatform === "Badanga" || activePlatform === "Pure" || activePlatform === "Soderzhanka" || activePlatform === "LovePlanet");
    slotEl.querySelector(".slotBadangaFields").style.display   = isBadanga ? "" : "none";
    slotEl.querySelector(".slotStandardFields").style.display  = (isTwinby || isVzn || isIntCity || isAtolin || isBadanga) ? "none" : "";
    slotEl.querySelector(".slotTwinbyFields").style.display    = isTwinby ? "" : "none";
    slotEl.querySelector(".slotVznFields").style.display       = isVzn ? "" : "none";
    slotEl.querySelector(".slotIntCityFields").style.display   = isIntCity ? "" : "none";
    slotEl.querySelector(".slotAtolinFields").style.display    = isAtolin ? "" : "none";
  } catch(e) {}
}

addSlotBtn?.addEventListener("click", addConnectSlot);

// Проверка прокси прямо в слоте подключения Atolin
connectSlots.addEventListener("click", async (e) => {
  const btn = e.target.closest(".slotAtolinProxyCheck");
  if (!btn) return;
  const slot = btn.closest(".connectSlot");
  const statusEl = slot.querySelector(".slotAtolinProxyStatus");
  const raw = slot.querySelector(".slotAtolinProxy").value.trim();
  const scheme = slot.querySelector(".slotAtolinProxyScheme").value;

  const parts = raw.split(":");
  if (parts.length < 2) {
    statusEl.textContent = "✗ Формат: host:port:логин:пароль";
    statusEl.style.color = "#fb7185";
    return;
  }

  btn.disabled = true;
  statusEl.textContent = "Проверяю...";
  statusEl.style.color = "var(--text2)";
  try {
    const res = await fetch(WORKER_API + "/api/proxy/check", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
      body: JSON.stringify({
        protocol: scheme === "socks5h" ? "socks5" : scheme,
        host: parts[0],
        port: parts[1],
        login: parts[2] || "",
        password: parts.slice(3).join(":") || "",
      }),
    });
    const data = await res.json();
    if (data.ok) {
      statusEl.textContent = "✓ Прокси живой, IP: " + (data.ip || "—");
      statusEl.style.color = "#10f5a8";
    } else {
      statusEl.textContent = "✗ " + (data.error || "не отвечает");
      statusEl.style.color = "#fb7185";
    }
  } catch {
    statusEl.textContent = "✗ Нет связи с сервером";
    statusEl.style.color = "#fb7185";
  }
  btn.disabled = false;
});

// один слот по умолчанию при загрузке
addConnectSlot();

// ── Мульти-добавление анкет ──────────────────────────────

const accountsList    = document.getElementById("accountsList");   // сетка на главной
const accountsListFull= document.getElementById("accountsListFull");
const template        = document.getElementById("accountTemplate");
const sqTemplate      = document.getElementById("squareCardTemplate");
const navButtons      = document.querySelectorAll(".navBtn");
const pages           = document.querySelectorAll(".page");
const connectBtn      = document.getElementById("connectBtn");

const connectToggle = document.getElementById("connectToggle");
const connectBody   = document.getElementById("connectBody");
const connectArrow  = document.querySelector(".connectArrow");

// Скрываем панель подключения при старте — показывается только через правую кнопку мыши
const connectForm = document.getElementById("connectForm");
if (connectForm) connectForm.style.display = "none";

if (connectToggle && connectBody) {
  connectToggle.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const isOpen = connectBody.style.display === "flex";
    if (isOpen) {
      connectBody.style.display = "none";
      if (connectArrow) connectArrow.classList.remove("open");
    } else {
      connectBody.style.display = "flex";
      connectBody.style.flexDirection = "column";
      if (connectArrow) connectArrow.classList.add("open");
    }
  });
}


let activePlatform = "Mamba";
let activeTabId = null; // если не null — мы во вкладке оператора, а не на платформе
let operatorTabs = [];

document.querySelectorAll(".platformBtn[data-platform]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".platformBtn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activePlatform = btn.dataset.platform;
    activeTabId = null;
    try { localStorage.setItem("claw_active_platform", activePlatform); } catch {}
    loadCanvasTransform();
    { const w = document.getElementById("canvasWrapper"); if (w) w.style.transform = ""; }
    if (window._clawApplyTransform) window._clawApplyTransform();
    // Переключаем поля в слотах
    document.querySelectorAll(".connectSlot").forEach(slot => {
      const isTwinby   = activePlatform === "Twinby";
      const isVzn      = activePlatform === "Vznakomstve";
      const isIntCity  = activePlatform === "intCity";
      const isOperator = activePlatform === "Operator";
      const isAtolin   = activePlatform === "Atolin";
const isBadanga  = activePlatform === "Badanga" || activePlatform === "Pure" || activePlatform === "Soderzhanka" || activePlatform === "LovePlanet";
      slot.querySelector(".slotBadangaFields").style.display   = isBadanga ? "" : "none";
      slot.querySelector(".slotStandardFields").style.display  = (isTwinby || isVzn || isIntCity || isOperator || isAtolin || isBadanga) ? "none" : "";
      slot.querySelector(".slotTwinbyFields").style.display    = isTwinby ? "" : "none";
      slot.querySelector(".slotVznFields").style.display       = isVzn ? "" : "none";
      slot.querySelector(".slotIntCityFields").style.display   = isIntCity ? "" : "none";
      slot.querySelector(".slotAtolinFields").style.display    = isAtolin ? "" : "none";
      slot.querySelector(".slotOperatorFields").style.display  = isOperator ? "" : "none";
    });
    const connectPanel = document.getElementById("connectForm");
    if (connectPanel) connectPanel.style.display = "none";
    renderOperatorTabs();
    if (cachedAccounts.length > 0) {
      renderSquareGridFromCache();
    } else {
      loadAccounts();
    }
    renderAICardsOnCanvas();
    renderTimerCardsOnCanvas();
    renderProxyCardsOnCanvas();
    renderLogCardsOnCanvas();
    renderBroadcastCardsOnCanvas();
  });
});
async function loadOperatorTabs() {
  try {
    const res = await fetch(WORKER_API + "/api/tabs");
    const data = await res.json();
    operatorTabs = data.tabs || [];
  } catch (err) {
    console.error("loadOperatorTabs error:", err);
    operatorTabs = [];
  }
  renderOperatorTabs();
}

function renderOperatorTabs() {
  const container = document.getElementById("operatorTabsContainer");
  const divider = document.getElementById("tabsDivider");
  if (!container) return;

  container.innerHTML = "";

  const visibleTabs = operatorTabs.filter(t => (t.platform || "Mamba") === activePlatform);

  if (divider) divider.style.display = visibleTabs.length ? "block" : "none";

  visibleTabs.forEach(tab => {
    const btn = document.createElement("button");
    btn.className = "platformBtn operatorTabBtn";
    btn.dataset.tabId = tab.id;
    if (activeTabId === tab.id) btn.classList.add("active");
    btn.innerHTML = `${escapeHtml(tab.name)}<span class="tabDeleteX">✕</span>`;

    btn.addEventListener("click", (e) => {
      if (e.target.classList.contains("tabDeleteX")) return;
      document.querySelectorAll(".platformBtn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeTabId = tab.id;
      loadCanvasTransform();
      if (window._clawApplyTransform) window._clawApplyTransform();
      renderSquareGridFromCache();
    });

    btn.querySelector(".tabDeleteX").addEventListener("click", (e) => {
      e.stopPropagation();
      openDeleteTabModal(tab);
    });

    // Drag-and-drop: кидаем карточку на эту кнопку — присваиваем метку
    btn.addEventListener("dragover", (e) => {
      e.preventDefault();
      btn.classList.add("dragOver");
    });
    btn.addEventListener("dragleave", () => {
      btn.classList.remove("dragOver");
    });
    btn.addEventListener("drop", async (e) => {
      e.preventDefault();
      btn.classList.remove("dragOver");
      const accountId = e.dataTransfer.getData("text/account-id");
      if (!accountId) return;
      try {
        await fetch(WORKER_API + "/api/tabs/assign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ account_id: accountId, tab_id: tab.id }),
        });
        await loadOperatorTabs();
        renderSquareGridFromCache();
      } catch (err) {
        alert("Не удалось добавить анкету во вкладку: " + err.message);
      }
    });

    container.appendChild(btn);
  });

  const addBtn = document.getElementById("addTabBtn");
  if (addBtn && addBtn.tagName === "BUTTON") {
    addBtn.onclick = startAddTabInline;
  }
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str || "";
  return div.innerHTML;
}

function startAddTabInline() {
  const addBtn = document.getElementById("addTabBtn");
  if (!addBtn || addBtn.tagName !== "BUTTON") return;

  const input = document.createElement("input");
  input.type = "text";
  input.id = "addTabBtn";
  input.placeholder = "Название вкладки";
  input.maxLength = 30;
  input.style.cssText = "width:150px;padding:7px 10px;border-radius:var(--r);border:1px solid var(--accent2);background:rgba(5,8,16,0.7);color:var(--text);font:500 12px 'Space Grotesk',sans-serif;outline:none;";

  addBtn.replaceWith(input);
  input.focus();

  let done = false;

  function restoreButton() {
    const current = document.getElementById("addTabBtn");
    if (current && current.tagName === "INPUT") {
      const btn = document.createElement("button");
      btn.className = "platformBtn";
      btn.id = "addTabBtn";
      btn.title = "Добавить вкладку";
      btn.style.cssText = "width:36px;padding:7px 0;text-align:center;";
      btn.textContent = "+";
      btn.onclick = startAddTabInline;
      current.replaceWith(btn);
    }
  }

  async function finish(shouldCreate) {
    if (done) return;
    done = true;
    const name = input.value.trim();

    if (shouldCreate && name) {
      try {
        await fetch(WORKER_API + "/api/tabs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, platform: activePlatform }),
        });
        restoreButton();
        await loadOperatorTabs(); // перерисует ряд вкладок (кнопка "+" уже восстановлена выше)
        return;
      } catch (err) {
        alert("Не удалось создать вкладку: " + err.message);
      }
    }

    restoreButton();
  }

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); finish(true); }
    if (e.key === "Escape") { e.preventDefault(); finish(false); }
  });
}

const STORAGE_KEY = "claw_active_page";

const pageInfo = {
  home:      { title: "CLAW-AI MANAGER",  subtitle: "Панель подключения анкет, AI-менеджера и задач." },
  ai:        { title: "AI-Менеджер",      subtitle: "Настрой промт для каждой анкеты — запуск прямо с карточки на главной." },
  plan:      { title: "Планирование",     subtitle: "Задачи команды: кто что делает и в каком статусе." },
  tasks:     { title: "Задачи",           subtitle: "Лог выполненных задач." },
  schedule:  { title: "График",           subtitle: "График смен команды на месяц." },
  analytics: { title: "Аналитика",        subtitle: "Отчёты, статистика и данные по подключённым анкетам." },
  tables:    { title: "Таблица ключей",   subtitle: "API-ключи Groq и Gemini — управление и привязка к анкетам." },
  contacts:  { title: "Контакты",          subtitle: "Все запарсенные email адреса с intimcity." },
  mails:     { title: "Почты",             subtitle: "Реестр почт: кому выдана, под какую платформу, в каком состоянии." },
  team:      { title: "Команда",           subtitle: "База TG-контактов и назначения по людям и датам." },
  myTasks:   { title: "МОИ TG",            subtitle: "Контакты, назначенные тебе, по датам." },
  cabinet:   { title: "Кабинет",           subtitle: "Пользователи системы: доступы и удаление." },
  training:  { title: "Видео обучение",    subtitle: "Материалы для команды: видео и фото с пояснениями." },
  settings:  { title: "Настройки",         subtitle: "Авторизация, профиль администратора и системные настойки." },
};

// ── Helpers ───────────────────────────────────────────────

function setResult(text, type = "") {
  resultBox.textContent = text;
  resultBox.className = `result ${type}`.trim();
}

function setBoxResult(box, text, type = "") {
  box.textContent = text;
  box.className = `result ${type}`.trim();
}

function formatDate(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch { return iso; }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 600_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    clearTimeout(timer);
    return res;
  } catch (err) {
    clearTimeout(timer);

    if (err.name === "AbortError") {
      throw new Error("Сервер слишком долго не отвечал.");
    }

    throw err;
  }
}
// ── Статистика из лога задач ──────────────────────────────


function startLiveActionPolling(accountId, cardEl) {
  let lastId = 0;
  let initialized = false;

  const intervalId = setInterval(async () => {
    if (!runningSplits.has(accountId) && !cardEl?.classList.contains("sqActive")) {
      clearInterval(intervalId);
      return;
    }
    try {
      const url = initialized
        ? WORKER_API + `/api/split-log/${encodeURIComponent(accountId)}?after_id=${lastId}`
        : WORKER_API + `/api/split-log/${encodeURIComponent(accountId)}`;

      const res = await fetch(url);
      const data = await res.json();
      const logs = data.logs || [];

      if (!initialized) {
        // первый запрос — просто запоминаем текущий последний id, без бампа (не пересчитываем старое)
        lastId = data.last_id || 0;
        initialized = true;
        return;
      }

      for (const row of logs) {
        const msg = row.message || "";
        if (msg.includes("✓ Лайк поставлен")) {
          bumpLiveStat(accountId, "liked", 1);
        } else if (msg.includes("✓ ответ отправлен")) {
          bumpLiveStat(accountId, "replied", 1);
          if (msg.includes("контакт передан")) {
            bumpLiveStat(accountId, "contacts", 1);
          }
        }
      }

      if (logs.length) {
        lastId = logs[logs.length - 1].id;
      }

      const likesVal    = cardEl?.querySelector(".sqLikesVal");
      const msgsVal     = cardEl?.querySelector(".sqMsgsVal");
      const contactsVal = cardEl?.querySelector(".sqContactsVal");
      const s = liveStats[accountId];
      if (s) {
        if (likesVal)    likesVal.textContent    = s.liked;
        if (msgsVal)     msgsVal.textContent     = s.replied;
        if (contactsVal) contactsVal.textContent = s.contacts;
      }
    } catch (err) {
      console.error("live action polling error:", err);
    }
  }, 15000);

  return intervalId;
}

// ── Квадратная карточка ───────────────────────────────────

function createSquareCard(account, stats) {
  const node = sqTemplate.content.cloneNode(true);
  const cardEl = node.querySelector(".sqCard");

  cardEl.setAttribute("data-account-id", account.id);
  cardEl.setAttribute("draggable", "true");
  cardEl.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/account-id", account.id);
    e.dataTransfer.effectAllowed = "copy";
    cardEl.classList.add("dragging");
  });
  cardEl.addEventListener("dragend", () => {
    cardEl.classList.remove("dragging");
  });

  const img      = node.querySelector(".sqImg");

  const fallback = node.querySelector(".sqFallback");
  const name     = node.querySelector(".sqName");
  name?.addEventListener("dblclick", async () => {
    const current = name.textContent;
    const input = document.createElement("input");
    input.value = current;
    input.style.cssText = "font:inherit;width:100%;background:transparent;border:none;border-bottom:1px solid var(--cyan);color:inherit;outline:none;padding:0;";
    name.textContent = "";
    name.appendChild(input);
    input.focus();
    input.select();
    const save = async () => {
      const val = input.value.trim() || current;
      name.textContent = val;
      try {
        await fetch(WORKER_API + `/api/accounts/${account.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: val }),
        });
      } catch {}
    };
    input.addEventListener("blur", save);
    input.addEventListener("keydown", e => {
      if (e.key === "Enter") input.blur();
      if (e.key === "Escape") { name.textContent = current; }
    });
  });
  const likesVal = node.querySelector(".sqLikesVal");
  const msgsVal  = node.querySelector(".sqMsgsVal");
  const likesBtn = node.querySelector(".sqLikesBtn") || { disabled: false };
  const groqBtn  = node.querySelector(".sqGroqBtn") || { disabled: false };
  const delBtn   = node.querySelector(".sqDeleteBtn");

  if (account.photo_url && account.photo_url !== account.profile_url) {
    img.style.display = "none";
    img.onload  = () => { img.style.display = "block"; fallback.style.display = "none"; };
    img.onerror = () => { img.style.display = "none";  fallback.style.display = "flex"; };
    img.src = proxyPhoto(account.photo_url, account.id);
  } else {
    img.style.display = "none";
    fallback.style.display = "flex";
  }

  name.textContent     = account.name || "Анкета";
  likesVal.textContent     = stats.liked;
  msgsVal.textContent      = stats.replied;

  // ── Стрелка сворачивания AI-карточки ──
  const collapseKey = `claw_ai_collapsed_${account.id}`;
  let isCollapsed = false;
  try { isCollapsed = localStorage.getItem(collapseKey) === "1"; } catch {}

  const collapseBtn = document.createElement("button");
  collapseBtn.className = "sqCollapseBtn";
  collapseBtn.title = "Скрыть/показать AI-карточку";
  collapseBtn.textContent = isCollapsed ? "‹" : "›";
  collapseBtn.dataset.accountId = account.id;
  collapseBtn.dataset.collapsed = isCollapsed ? "1" : "0";

  collapseBtn.onclick = (e) => {
    e.stopPropagation();
    const group = cardEl.closest(".sqGroup");
    if (!group) return;
    const connector = group.querySelector(".sqConnector");
    const aCard = group.querySelector(".sqAnalyticsCard");
    if (!connector || !aCard) return;

    const nowCollapsed = collapseBtn.dataset.collapsed !== "1";
    connector.style.display = nowCollapsed ? "none" : "flex";
    aCard.style.display     = nowCollapsed ? "none" : "flex";
    collapseBtn.dataset.collapsed = nowCollapsed ? "1" : "0";
    collapseBtn.textContent = nowCollapsed ? "‹" : "›";

    try { localStorage.setItem(collapseKey, nowCollapsed ? "1" : "0"); } catch {}
  };

  cardEl.appendChild(collapseBtn);
  const contactsVal = node.querySelector(".sqContactsVal");
  if (contactsVal) contactsVal.textContent = stats.contacts;

  const sqResultEl = node.querySelector(".sqResult");

const likesInput = node.querySelector(".sqLikesInput") || { disabled: false, value: "10" };
const splitBtn   = node.querySelector(".sqSplitBtn");
const splitInput = node.querySelector(".sqSplitInput");

// ── Галочки «лайкать» / «отвечать» и лимит лайков ──
const doLikesEl = node.querySelector(".sqDoLikes");
const doChatsEl = node.querySelector(".sqDoChats");
const _opts = (window._runOpts || {})[account.id] || {};
if (doLikesEl) doLikesEl.checked = _opts.do_likes !== false;
if (doChatsEl) doChatsEl.checked = _opts.do_chats !== false;
if (splitInput && _opts.limit_likes) splitInput.value = _opts.limit_likes;

async function saveRunOpts(patch) {
  try {
    const r = await fetch(`/api/accounts/${encodeURIComponent(account.id)}/run-opts`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!r.ok) throw new Error(await r.text());
    window._runOpts = window._runOpts || {};
    window._runOpts[account.id] = { ...(window._runOpts[account.id] || {}), ...patch };
  } catch (e) {
    console.warn("run-opts:", e.message);
  }
}

doLikesEl?.addEventListener("change", () => saveRunOpts({ do_likes: doLikesEl.checked }));
doChatsEl?.addEventListener("change", () => saveRunOpts({ do_chats: doChatsEl.checked }));
splitInput?.addEventListener("change", () =>
  saveRunOpts({ limit_likes: Math.max(1, Math.min(100, parseInt(splitInput.value) || 10)) }));

const blockInfo = `${account.block_reason || ""} ${account.run_note || ""} ${account.session_reason || ""}`.toLowerCase();

const isBlocked =
  account.is_blocked === true ||
  String(account.is_blocked).toLowerCase() === "true" ||
  blockInfo.includes("заблок") ||
  blockInfo.includes("blocked") ||
  blockInfo.includes("confirm photo");

const sessionInfo = `${account.session_reason || ""} ${account.run_note || ""}`.toLowerCase();

const isLoggedOut =
  !isBlocked &&
  (account.platform || "").toLowerCase() !== "lovelaz" &&
  (account.platform || "").toLowerCase() !== "vznakomstve" &&
  (account.platform || "").toLowerCase() !== "intcity" &&
  (
    account.session_valid === false ||
    String(account.session_valid).toLowerCase() === "false" ||
    account.cookies_valid === false ||
    String(account.cookies_valid).toLowerCase() === "false" ||
    sessionInfo.includes("разлогин") ||
    sessionInfo.includes("cookies недействительны") ||
    sessionInfo.includes("unauthorized") ||
    sessionInfo.includes("session expired")
  );

if (isBlocked) {
  cardEl.classList.add("sqBlocked");

  // Делаем фотографию чёрно-белой
  img.style.filter = "grayscale(100%) brightness(45%)";
  fallback.style.filter = "grayscale(100%) brightness(45%)";

  const photoArea =
    img.closest(".sqPhoto, .sqImageWrap, .sqMedia") ||
    img.parentElement;

  if (photoArea) {
    photoArea.classList.add("sqBlockedPhoto");

    if (!photoArea.querySelector(".sqBlockedOverlay")) {
      const blockedOverlay = document.createElement("div");
      blockedOverlay.className = "sqBlockedOverlay";
      blockedOverlay.textContent = "БЛОК";
      photoArea.appendChild(blockedOverlay);
    }
  }

  // Находим зелёный VALID
  const validBadge = [...cardEl.querySelectorAll("*")].find(el =>
    el.children.length === 0 &&
    el.textContent.trim().toUpperCase() === "VALID"
  );

  if (validBadge) {
    validBadge.textContent = "БЛОК";
    validBadge.classList.add("sqBlockedBadge");
  }
}

if (isLoggedOut) {
  cardEl.classList.add("sqLoggedOut");

  img.style.filter = "grayscale(100%) brightness(55%)";
  fallback.style.filter = "grayscale(100%) brightness(55%)";

  const photoArea =
    img.closest(".sqPhoto, .sqImageWrap, .sqMedia") ||
    img.parentElement;

  if (photoArea) {
    photoArea.classList.add("sqBlockedPhoto");

    if (!photoArea.querySelector(".sqBlockedOverlay")) {
      const logoutOverlay = document.createElement("div");
      logoutOverlay.className = "sqBlockedOverlay";
      logoutOverlay.textContent = "РАЗЛОГИН";
      photoArea.appendChild(logoutOverlay);
    }
  }

  const validBadge = [...cardEl.querySelectorAll("*")].find(el =>
    el.children.length === 0 &&
    el.textContent.trim().toUpperCase() === "VALID"
  );

  if (validBadge) {
    validBadge.textContent = "РАЗЛОГИН";
    validBadge.classList.add("sqBlockedBadge");
  }
}

const isTeamRunning = account.run_status === "running";
let isCurrentlyRunning = isTeamRunning; // живой флаг, в отличие от account.run_status — его можно обновлять по ходу кликов

if (isTeamRunning) {
  cardEl.classList.add("sqActive");

  const taskName =
    account.run_task === "split" ? "Сплит запущен" :
    account.run_task === "groq" ? "Groq запущен" :
    account.run_task === "likes" ? "Лайки запущены" :
    "Анкета запущена";

  const startedBy = account.run_started_by ? ` · ${account.run_started_by}` : "";

  if (sqResultEl) {
    sqResultEl.textContent = account.run_note || `${taskName}${startedBy}`;
    sqResultEl.className = "sqResult";
  }

  splitBtn.classList.add("running");
  splitBtn.innerHTML = "⏹ Стоп";
  splitBtn.disabled = false;

  if (likesBtn) likesBtn.disabled = true;
  if (groqBtn) groqBtn.disabled = true;
  splitInput.disabled = true;
  if (likesInput) likesInput.disabled = true;
}

// Восстанавливаем сохранённые значения лимитов из localStorage
const likesLimitKey = `claw_likes_limit_${account.id}`;
const splitLimitKey = `claw_split_limit_${account.id}`;
try {
  const savedLikesLimit = localStorage.getItem(likesLimitKey);
  if (savedLikesLimit) likesInput.value = savedLikesLimit;
} catch {}
try {
  const savedSplitLimit = localStorage.getItem(splitLimitKey);
  if (savedSplitLimit) splitInput.value = savedSplitLimit;
} catch {}

// Сохраняем значения при изменении, чтобы они не сбрасывались после обновления страницы
likesInput.addEventListener?.("input", () => {
  try { localStorage.setItem(likesLimitKey, likesInput.value); } catch {}
});
splitInput.addEventListener("input", () => {
  try { localStorage.setItem(splitLimitKey, splitInput.value); } catch {}
});


  splitBtn.onclick = async () => {
  const limit = Math.max(1, Math.min(50, Number(splitInput.value) || 10));

  if (isCurrentlyRunning || runningSplits.has(account.id)) {
    isCurrentlyRunning = false;
    runningSplits.delete(account.id);
    if (sqResultEl) {
      sqResultEl.textContent = "Останавливаю...";
      sqResultEl.className = "sqResult";
    }

    try {
      await fetch(WORKER_API + "/api/tasks/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: account.id }),
      });
    } catch (err) {
      console.error("stop error:", err);
    }

    await setAccountRunStatus(account.id, "idle", "", "");

    splitBtn.classList.remove("running");
    splitBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Сплит';

    likesBtn.disabled = false;
    groqBtn.disabled = false;
    splitBtn.disabled = false;
    splitInput.disabled = false;
    likesInput.disabled = false;
    cardEl?.classList.remove("sqActive");

    if (sqResultEl) {
      sqResultEl.textContent = "Остановлено.";
      sqResultEl.className = "sqResult";
    }

    loadAccounts();
    return;
  }

  isCurrentlyRunning = true;
  splitBtn.classList.add("running");
  splitBtn.innerHTML = "⏹ Стоп";
  splitBtn.disabled = false;
  splitInput.disabled = true;
  cardEl?.classList.add("sqActive");
  if (sqResultEl) { sqResultEl.textContent = "Запускаю..."; sqResultEl.className = "sqResult"; }

  toggleSplit(account.id, splitBtn, splitInput, likesBtn, groqBtn, likesInput, limit, sqResultEl, cardEl, account.platform);
};

  if (runningSplits.has(account.id)) {
    splitBtn.disabled = false;
    splitBtn.classList.add("running");
    splitBtn.innerHTML = "⏹ Стоп";
    likesBtn.disabled = true;
    groqBtn.disabled = true;
    splitInput.disabled = true;
    likesInput.disabled = true;
  }

if (isBlocked || isLoggedOut) {
  likesBtn.disabled = true;
  groqBtn.disabled = true;
  splitBtn.disabled = true;
  likesInput.disabled = true;
  splitInput.disabled = true;

  if (sqResultEl) {
    sqResultEl.textContent = isBlocked
      ? "Анкета заблокирована"
      : "Анкета разлогинена";
    sqResultEl.className = "sqResult bad";
  }
}

const isReserved = reservedIds.has(account.id);
if (isReserved) {
  cardEl.classList.add("sqReserve");
  likesBtn.disabled = true;
  groqBtn.disabled = true;
  splitBtn.disabled = true;
  likesInput.disabled = true;
  splitInput.disabled = true;

  if (sqResultEl) {
    sqResultEl.textContent = "Резервная анкета";
    sqResultEl.className = "sqResult";
  }
}

// intCity — дефолтное фото
if ((account.platform || "").toLowerCase() === "intcity" && !account.photo_url) {
  account.photo_url = "/intcity_logo.png";
}

// ── intCity: показываем поля рассылки ──
const isIntCityCard = (account.platform || "").toLowerCase() === "intcity";
const intCityFields = node.querySelector(".sqIntCityFields");
if (isIntCityCard && intCityFields) {
  intCityFields.style.display = "flex";

  // Скрываем ненужные элементы
  const sqStats = node.querySelector(".sqStats");
  if (sqStats) sqStats.style.display = "none";

  // Восстанавливаем сохранённые значения
  const savedSubject = localStorage.getItem(`intcity_subject_${account.id}`) || "";
  const savedBody = localStorage.getItem(`intcity_body_${account.id}`) || "";
  const savedPages = localStorage.getItem(`intcity_pages_${account.id}`) || "3";
  const subjectEl = intCityFields.querySelector(".sqIntCitySubject");
  const bodyEl = intCityFields.querySelector(".sqIntCityBody");
  const pagesEl = intCityFields.querySelector(".sqIntCityPages");
  if (subjectEl) subjectEl.value = savedSubject;
  if (bodyEl) bodyEl.value = savedBody;
  if (pagesEl) pagesEl.value = savedPages;

  subjectEl?.addEventListener("input", () => {
    localStorage.setItem(`intcity_subject_${account.id}`, subjectEl.value);
  });
  bodyEl?.addEventListener("input", () => {
    localStorage.setItem(`intcity_body_${account.id}`, bodyEl.value);
  });
  pagesEl?.addEventListener("input", () => {
    localStorage.setItem(`intcity_pages_${account.id}`, pagesEl.value);
  });

  const cookieEl = intCityFields.querySelector(".sqIntCityCookie");
  const tokenEl = intCityFields.querySelector(".sqIntCityToken");
  if (cookieEl) {
    cookieEl.value = localStorage.getItem(`intcity_cookie_${account.id}`) || "";
    cookieEl.addEventListener("input", () => localStorage.setItem(`intcity_cookie_${account.id}`, cookieEl.value));
  }
  if (tokenEl) {
    tokenEl.value = localStorage.getItem(`intcity_token_${account.id}`) || "";
    tokenEl.addEventListener("input", () => localStorage.setItem(`intcity_token_${account.id}`, tokenEl.value));
  }

  // Переопределяем сплит для intCity
  splitBtn.onclick = async () => {
    if (runningSplits.has(account.id) || isCurrentlyRunning) {
      runningSplits.delete(account.id);
      isCurrentlyRunning = false;
    try {
      await fetch(WORKER_API + "/api/tasks/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: account.id }),
      });
      // Гасим серверный таймер, иначе schedule_loop поставит
      // новую задачу через несколько секунд.
      await fetch(`/api/accounts/${account.id}/schedule`, {
        method: "DELETE",
        headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" },
      });
    } catch (err) {
      console.error("stop error:", err);
    }

    await setAccountRunStatus(account.id, "idle", "", "");

    splitBtn.classList.remove("running");
      splitBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Сплит';
      splitBtn.disabled = false;
      splitInput.disabled = false;
      cardEl?.classList.remove("sqActive");
      if (sqResultEl) { sqResultEl.textContent = "Остановлено."; sqResultEl.className = "sqResult"; }
      loadAccounts();
      return;
    }

    const subject = subjectEl?.value.trim();
    const body = bodyEl?.value.trim();
    const pages = parseInt(pagesEl?.value) || 3;
    if (!subject) { alert("Введи тему письма"); return; }
    if (!body) { alert("Введи текст письма"); return; }

    runningSplits.add(account.id);
    isCurrentlyRunning = true;
    await setAccountRunStatus(account.id, "running", "split", "Рассылка запущена");
    splitBtn.classList.add("running");
    splitBtn.innerHTML = "⏹ Стоп";
    splitBtn.disabled = false;
    splitInput.disabled = true;
    cardEl?.classList.add("sqActive");

    // Отправляем задачу в job_queue
    if (sqResultEl) { sqResultEl.textContent = "Запускаю рассылку..."; sqResultEl.className = "sqResult"; }
    try {
      const res = await fetch(WORKER_API + "/api/tasks/intcity-split", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": localStorage.getItem("claw_auth_token") || "",
        },
        body: JSON.stringify({
          account_id: account.id,
          pages,
          subject,
          body,
          mail_cookie: localStorage.getItem(`intcity_cookie_${account.id}`) || "",
          mail_token: localStorage.getItem(`intcity_token_${account.id}`) || "",
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.detail || "Ошибка запуска");
      if (sqResultEl) { sqResultEl.textContent = "Задача запущена — воркер работает"; sqResultEl.className = "sqResult good"; }
    } catch (e) {
      if (sqResultEl) { sqResultEl.textContent = `Ошибка: ${e.message}`; sqResultEl.className = "sqResult bad"; }
      runningSplits.delete(account.id);
      splitBtn.classList.remove("running");
      splitBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Сплит';
      splitBtn.disabled = false;
      splitInput.disabled = false;
      cardEl?.classList.remove("sqActive");
    }

    // НЕ сбрасываем состояние — воркер работает в фоне бесконечно
    // Кнопка Стоп отменит задачу через job_queue
  };
}

// ── Кнопка скрещивания ──
  const chainBtn = node.querySelector(".sqChainBtn");
  if (chainBtn) {
    chainBtn.onclick = () => openChainModal(account.id, account.name);
  }

  // ── Lovelaz: кнопка Трансляция вместо Скрещивания ──
  const broadcastBtn = node.querySelector(".sqBroadcastBtn");
  const isLovelazCard = (account.platform || "").toLowerCase() === "lovelaz";
  if (broadcastBtn) {
    if (!isLovelazCard) {
      broadcastBtn.style.display = "none";
    } else {
      if (chainBtn) chainBtn.style.display = "none";
      broadcastBtn.style.display = "";

      const isBroadcasting = account.run_status === "running" && account.run_task === "broadcast";
      const renderBcastBtn = (running) => {
        broadcastBtn.classList.toggle("running", running);
        broadcastBtn.innerHTML = running
          ? "⏹ Стоп"
          : '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 12a8 8 0 0 1 8-8M4 12a8 8 0 0 0 8 8M20 12a8 8 0 0 0-8-8M20 12a8 8 0 0 1-8 8"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg> Трансляция';
      };
      renderBcastBtn(isBroadcasting);

      const splitRunning = runningSplits.has(account.id) ||
        (account.run_status === "running" && account.run_task === "split");

      if (isBlocked) broadcastBtn.disabled = true;
      if (splitRunning) {
        broadcastBtn.disabled = true;
        broadcastBtn.title = "Сначала останови сплит";
      }
      if (isBroadcasting) {
        splitBtn.disabled = true;
        splitInput.disabled = true;
        splitBtn.title = "Идёт трансляция";
      }

      broadcastBtn.onclick = async () => {
        // СТОП
        if (broadcastBtn.classList.contains("running")) {
          try {
            await fetch(WORKER_API + "/api/tasks/stop", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ account_id: account.id }),
            });
          } catch {}
          await setAccountRunStatus(account.id, "idle", "", "");
          renderBcastBtn(false);
          splitBtn.disabled = false;
          splitInput.disabled = false;
          splitBtn.title = "";
          cardEl?.classList.remove("sqActive");
          if (sqResultEl) { sqResultEl.textContent = "Трансляция остановлена."; sqResultEl.className = "sqResult"; }
          loadAccounts();
          return;
        }

        // СТАРТ
        const bcast = getBroadcastCardForAccount(account.id);
        if (!bcast) { alert("Подключи ноду «Промт Трансляция» ниткой к этой анкете"); return; }
        const prompt = (bcast.prompt || "").trim();
        if (!prompt) { alert("Промт трансляции пустой — заполни ноду"); return; }

        if (runningSplits.has(account.id)) { alert("Сначала останови сплит"); return; }

        renderBcastBtn(true);
        splitBtn.disabled = true;
        splitInput.disabled = true;
        splitBtn.title = "Идёт трансляция";
        cardEl?.classList.add("sqActive");
        if (sqResultEl) { sqResultEl.textContent = "Запускаю трансляцию..."; sqResultEl.className = "sqResult"; }
        await setAccountRunStatus(account.id, "running", "broadcast", "Трансляция запущена");

        try {
          const res = await fetch(WORKER_API + "/api/tasks/lovelaz-broadcast", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": localStorage.getItem("claw_auth_token") || "",
            },
            body: JSON.stringify({
              account_id: account.id,
              prompt,
              limit: bcast.limit || 30,
              delay: bcast.delay || 20,
              pages: bcast.pages || 1,
            }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.detail || "Ошибка запуска");
          if (sqResultEl) { sqResultEl.textContent = "Трансляция запущена — воркер работает"; sqResultEl.className = "sqResult good"; }
        } catch (e) {
          if (sqResultEl) { sqResultEl.textContent = `Ошибка: ${e.message}`; sqResultEl.className = "sqResult bad"; }
          renderBcastBtn(false);
          splitBtn.disabled = false;
          splitInput.disabled = false;
          splitBtn.title = "";
          cardEl?.classList.remove("sqActive");
          await setAccountRunStatus(account.id, "idle", "", "");
        }
      };
    }
  }

  // ── Оператор (Telegram): урезанный вид карточки ──
  const isOperatorCard = (account.platform || "").toLowerCase() === "operator";
  if (isOperatorCard) {
    const sqStatsEl = node.querySelector(".sqStats");
    if (sqStatsEl) sqStatsEl.style.display = "none";

    splitInput.style.display = "none";
    if (chainBtn) chainBtn.style.display = "none";
    splitBtn.classList.add("sqOperatorBadge");

    const isOperatorRunning = account.run_status === "running" && account.run_task === "operator";

    const renderOperatorBtn = (running) => {
      splitBtn.classList.toggle("sqOperatorActive", running);
      splitBtn.innerHTML = running ? "● Обрабатывает" : "▶ Обработка";
    };
    renderOperatorBtn(isOperatorRunning);

    if (isBlocked || isLoggedOut || isReserved) {
      splitBtn.disabled = true;
    } else {
      splitBtn.disabled = false;
      splitBtn.onclick = async () => {
        const nowRunning = splitBtn.classList.contains("sqOperatorActive");
        splitBtn.disabled = true;

        if (nowRunning) {
          await setAccountRunStatus(account.id, "idle", "", "");
          renderOperatorBtn(false);
          if (sqResultEl) { sqResultEl.textContent = "Обработка остановлена."; sqResultEl.className = "sqResult"; }
          cardEl?.classList.remove("sqActive");
        } else {
          await setAccountRunStatus(account.id, "running", "operator", "Слежу за входящими чатами Telegram");
          renderOperatorBtn(true);
          if (sqResultEl) { sqResultEl.textContent = "Слежу за входящими чатами..."; sqResultEl.className = "sqResult good"; }
          cardEl?.classList.add("sqActive");
        }

        splitBtn.disabled = false;
        loadAccounts();
      };
    }
  }

  delBtn.onclick = () => {
    const modal = document.getElementById("deleteAccountModal");
    const nameEl = document.getElementById("deleteAccountName");
    if (nameEl) nameEl.textContent = account.name || account.id;
    if (modal) modal.style.display = "flex";

    document.getElementById("deleteAccountCancelBtn").onclick = () => { modal.style.display = "none"; };
    document.getElementById("deleteAccountModalClose").onclick = () => { modal.style.display = "none"; };
    document.getElementById("deleteAccountConfirmBtn").onclick = async () => {
      modal.style.display = "none";
      markDeleted(account.id);
      cachedAccounts = cachedAccounts.filter(a => a.id !== account.id);
      try {
        const _c = JSON.parse(localStorage.getItem(ACCOUNTS_CACHE_KEY) || "[]");
        localStorage.setItem(ACCOUNTS_CACHE_KEY,
          JSON.stringify(_c.filter(a => a.id !== account.id)));
      } catch {}
      const group = cardEl.closest(".sqGroup") || cardEl.closest("[data-account-id]")?.parentElement || cardEl.parentElement?.parentElement;
      if (group) group.remove();
      else cardEl.parentElement?.remove();
      try {
        runningSplits.delete(account.id);
        try {
          await fetch(WORKER_API + "/api/tasks/stop", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account_id: account.id }),
          });
        } catch {}

        // ── Освобождаем привязанный слот ключей, если был ──
        const boundSlot = keySlots.find(s => s.account_id === account.id);
        if (boundSlot) {
          boundSlot.account_id = null;
          renderKeySlots();
          fetch(WORKER_API + "/api/key-slots/release/" + encodeURIComponent(account.id), { method: "POST" }).catch(() => {});
        }

        // ── Чистим нитки, которые указывали на эту анкету ──
        if (window._clawRemoveConnections) window._clawRemoveConnections(account.id);

        // ── Отвязываем аналитик-карточку АИ-менеджера, если была привязана ──
        const aiCard = analyticsCards.find(c => c.accountId === account.id);
        if (aiCard) {
          aiCard.accountId = null;
          fetch(WORKER_API + `/api/analytics-cards/${encodeURIComponent(aiCard.cardId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ account_id: null }),
          }).catch(() => {});
        }

        const _del = await fetch(WORKER_API + `/api/accounts/${encodeURIComponent(account.id)}`, {
          method: "DELETE",
          headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" },
        });
        if (!_del.ok) throw new Error("сервер ответил " + _del.status);
        await loadAccounts();
      } catch (err) {
        // Удаление не прошло — снимаем надгробие, иначе анкета
        // пропадёт с экрана, оставшись живой в базе.
        unmarkDeleted(account.id);
        await loadAccounts();
        alert("Не удалось удалить: " + err.message);
      }
    };
  };

  return node;
}

// ── Старая карточка (для страницы Анкеты) ────────────────

function createAccountCard(account) {
  const node = template.content.cloneNode(true);
  const img      = node.querySelector(".profilePhoto");
  const fallback = node.querySelector(".profileFallback");

  if (account.photo_url && account.photo_url !== account.profile_url) {
    img.style.display = "none";
    img.onload  = () => { img.style.display = "block"; fallback.style.display = "none"; };
    img.onerror = () => { img.style.display = "none";  fallback.style.display = "flex"; };
    img.src = proxyPhoto(account.photo_url);
  } else {
    img.style.display = "none";
    fallback.style.display = "grid";
  }

  node.querySelector("h3").textContent      = account.name || "Анкета";
  node.querySelector(".url").textContent    = account.final_url || account.profile_url || "";
  node.querySelector(".checked").textContent= `Сохранено: ${formatDate(account.checked_at)}`;
  node.querySelector(".cookies").textContent= `Cookies: ${account.cookies_count || 0}`;
  node.querySelector(".openBtn").onclick    = () => window.open(account.final_url || account.profile_url, "_blank");
  node.querySelector(".deleteBtn").onclick  = async (e) => {
    const card = e.target.closest(".accountCard, .card, li") || e.target.parentElement;
    if (card) card.remove();
    try {
      const res  = await fetch(WORKER_API + `/api/accounts/${encodeURIComponent(account.id)}`, {
        method: "DELETE",
        headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" },
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || "Ошибка удаления");
    } catch (err) { alert("Не удалось удалить: " + err.message); }
  };
  return node;
}

// ── Загрузка и рендер ─────────────────────────────────────

let cachedAccounts = [];
let cachedLogs = [];

// ── Раскладка канваса на сервере ───────────────────────────
// Позиции нод, нитки и ноды таймера/логов/трансляции жили только в
// localStorage — поэтому при входе с другого ПК всё разлеталось.
const UI_STATE_KEYS = [
  "claw_canvas_positions",
  "claw_connections",
  "claw_timer_cards",
  "claw_log_cards",
  "claw_broadcast_cards",
  "claw_proxy_cards",
  "claw_active_platform",
];

function uiStateOurs(k) {
  return typeof k === "string" &&
    (UI_STATE_KEYS.includes(k) || k.startsWith("claw_canvas_transform"));
}

let _uiReady = false, _uiTimer = null, _uiLast = "";

function uiStateCollect() {
  const out = {};
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (uiStateOurs(k)) out[k] = localStorage.getItem(k);
  }
  return out;
}

async function uiStatePull() {
  let _empty = false;
  try {
    const r = await fetch(WORKER_API + "/api/ui-state", {
      headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    const st = (await r.json()).state || {};
    const keys = Object.keys(st);
    if (keys.length) {
      keys.forEach(k => { if (typeof st[k] === "string") localStorage.setItem(k, st[k]); });
      console.log("UI-STATE: раскладка получена с сервера, ключей", keys.length);
    } else {
      console.log("UI-STATE: на сервере пусто — заливаю текущую раскладку");
      _empty = true;
    }
  } catch (e) {
    console.warn("UI-STATE: не смог получить раскладку:", e.message);
  } finally {
    _uiReady = true;
    _uiLast = JSON.stringify(uiStateCollect());
  }
  // Сервер пустой — сбрасываем отпечаток, иначе первая заливка
  // сочтёт раскладку неизменившейся и ничего не отправит.
  if (_empty) { _uiLast = ""; uiStatePush(); }
}

function uiStatePush() {
  if (!_uiReady) return;
  clearTimeout(_uiTimer);
  _uiTimer = setTimeout(async () => {
    const state = uiStateCollect();
    const blob = JSON.stringify(state);
    if (blob === _uiLast) return;
    try {
      const r = await fetch(WORKER_API + "/api/ui-state", {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          "Authorization": localStorage.getItem("claw_auth_token") || "",
        },
        body: JSON.stringify({ state }),
      });
      if (r.ok) _uiLast = blob;
    } catch {}
  }, 800);
}

// Перехватываем запись в localStorage, чтобы не дописывать uiStatePush()
// в каждый из десятка модулей карточек.
(function () {
  const _set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k, v) {
    _set.call(this, k, v);
    if (this === window.localStorage && uiStateOurs(k)) uiStatePush();
  };
  const _rm = Storage.prototype.removeItem;
  Storage.prototype.removeItem = function (k) {
    _rm.call(this, k);
    if (this === window.localStorage && uiStateOurs(k)) uiStatePush();
  };
})();

const ACCOUNTS_CACHE_KEY = "claw_accounts_cache";
const LOGS_CACHE_KEY     = "claw_logs_cache";
const ANALYTICS_CACHE_KEY = "claw_analytics_cache";

// ── Надгробия: id удалённых анкет ──────────────────────────
// Запрос /api/accounts мог уйти ДО удаления — его ответ придёт после
// и вернёт карточку на экран. Поэтому удалённые id помним и фильтруем,
// пока сервер не подтвердит, что анкеты действительно нет.
const DELETED_KEY = "claw_deleted_ids";
let deletedIds = new Set();
try { deletedIds = new Set(JSON.parse(localStorage.getItem(DELETED_KEY) || "[]")); } catch {}

function saveDeletedIds() {
  try { localStorage.setItem(DELETED_KEY, JSON.stringify([...deletedIds])); } catch {}
}
function markDeleted(id) { deletedIds.add(id); saveDeletedIds(); }
function unmarkDeleted(id) { deletedIds.delete(id); saveDeletedIds(); }
function dropDeleted(list) { return (list || []).filter(a => !deletedIds.has(a.id)); }

function loadCachedAccountsInstantly() {
  try {
    const accRaw = localStorage.getItem(ACCOUNTS_CACHE_KEY);
    const logRaw = localStorage.getItem(LOGS_CACHE_KEY);
    const anaRaw = localStorage.getItem(ANALYTICS_CACHE_KEY);

    if (accRaw) {
      const accounts = dropDeleted(JSON.parse(accRaw));
      const logs = logRaw ? JSON.parse(logRaw) : [];
      cachedAccounts = accounts;
      cachedLogs = logs;

      const cb = document.getElementById("countBadge");
      if (cb) cb.textContent = accounts.length;

      renderSquareGrid(accounts, logs);

      if (anaRaw) {
        try { analyticsCards = JSON.parse(anaRaw); } catch {}
      }
      renderAnalyticsGrid(accounts);
    }
  } catch (err) {
    console.error("loadCachedAccountsInstantly error:", err);
  }
}

async function loadAccounts() {
  try {
    const [accRes, statsRes, reservedRes] = await Promise.all([
      fetch(WORKER_API + "/api/accounts"),
      fetch(WORKER_API + "/api/accounts-stats"),
      fetch(WORKER_API + "/api/accounts/reserved-ids"),
    ]);
    const accData = await accRes.json();
    const statsData = await statsRes.json();
    const reservedData = await reservedRes.json();
    const raw = accData.accounts || [];
    // Сервер подтвердил удаление — надгробие больше не нужно.
    const serverIds = new Set(raw.map(a => a.id));
    [...deletedIds].forEach(id => { if (!serverIds.has(id)) deletedIds.delete(id); });
    saveDeletedIds();

    const accounts = dropDeleted(raw);
    const statsMap = statsData.stats || {};
    reservedIds = new Set(reservedData.reserved_ids || []);
    console.log("ACCOUNTS LOADED:", accounts.length, "скрыто удалённых:", raw.length - accounts.length);
    cachedAccounts = accounts;
    window._cachedAccounts = accounts; // для страницы таблиц

    // Галочки на карточках читаются отсюда при отрисовке
    try {
      const sr = await fetch("/api/schedules");
      const sd = await sr.json();
      window._runOpts = {};
      (sd.schedules || []).forEach(s => {
        window._runOpts[s.account_id] = {
          do_likes: s.do_likes, do_chats: s.do_chats, limit_likes: s.limit_likes,
        };
      });
    } catch {}
    window.cachedLogs = statsMap;
    cachedLogs = statsMap;

    // Синхронизируем локальный набор запущенных анкет с реальным статусом из базы.
    // Без этого фронт не знает про работу, запущенную сервером (таймером),
    // поэтому карточка не подсвечивалась и нитки не анимировались.
    accounts.forEach(a => {
      if (a.run_status === "running") runningSplits.add(a.id);
      else if (!a.run_status || a.run_status === "idle") runningSplits.delete(a.id);
    });
    if (window._clawStartAnim) window._clawStartAnim();

    // countBadge в шапке
    const cb = document.getElementById("countBadge");
    if (cb) cb.textContent = accounts.length;

    // Главная — квадратная сетка
  try {
    localStorage.setItem(ACCOUNTS_CACHE_KEY, JSON.stringify(accounts));
    localStorage.setItem(LOGS_CACHE_KEY, JSON.stringify(statsMap));
  } catch {}

    renderSquareGrid(accounts, statsMap);


    return accounts;
  } catch (err) {
    console.error("loadAccounts error:", err);
    return [];
  }
}


let accountStatusCheckRunning = false;

async function refreshAccountStatuses() {
  if (accountStatusCheckRunning) return;

  accountStatusCheckRunning = true;

  try {
    const res = await fetch(WORKER_API + "/api/accounts/check-statuses", {
      method: "POST",
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(
        data.detail ||
        data.error ||
        `Ошибка проверки статусов: HTTP ${res.status}`
      );
    }

    console.log("ACCOUNT STATUSES:", data.results);

    // Пропущенные заблокированные анкеты (жёсткий флаг)
    const skipped = data.results.filter(r => r.skipped);
    if (skipped.length) {
      console.log(`[STATUS] Пропущено заблокированных анкет: ${skipped.length}`, skipped.map(r => r.account_id));
    }

    // Перезагружаем карточки с обновлёнными статусами из Supabase
    await loadAccounts();
  } catch (err) {
    console.error("refreshAccountStatuses error:", err);
  } finally {
    accountStatusCheckRunning = false;
  }
}

// ── Infinite Canvas (pan/zoom/drag) ──────────────────────

const CANVAS_STORAGE_KEY = "claw_canvas_positions";
const CANVAS_TRANSFORM_KEY = "claw_canvas_transform";
function canvasTransformKey() {
  const p = (typeof activePlatform !== "undefined" && activePlatform) ? activePlatform : "Mamba";
  const tab = (typeof activeTabId !== "undefined" && activeTabId) ? "_" + activeTabId : "";
  return CANVAS_TRANSFORM_KEY + "_" + p + tab;
}
let canvasPositions = {}; // { [accountId]: { x, y } }
let canvasTransform = { x: 0, y: 0, scale: 1 };

function loadCanvasPositions() {
  try {
    const raw = localStorage.getItem(CANVAS_STORAGE_KEY);
    if (raw) canvasPositions = JSON.parse(raw);
  } catch {}
}

function saveCanvasPositions() {
  try { localStorage.setItem(CANVAS_STORAGE_KEY, JSON.stringify(canvasPositions)); } catch {}
}

function loadCanvasTransform() {
  canvasTransform.x = 0;
  canvasTransform.y = 0;
  canvasTransform.scale = 1;
  try {
    const raw = localStorage.getItem(canvasTransformKey());
    if (raw) {
      const saved = JSON.parse(raw);
      if (typeof saved.x === "number") canvasTransform.x = saved.x;
      if (typeof saved.y === "number") canvasTransform.y = saved.y;
      if (typeof saved.scale === "number") canvasTransform.scale = saved.scale;
    }
  } catch {}
}

function saveCanvasTransform() {
  try { localStorage.setItem(canvasTransformKey(), JSON.stringify(canvasTransform)); } catch {}
}
function initInfiniteCanvas() {
  const wrapper = document.getElementById("canvasWrapper");
  const canvas = document.getElementById("webCanvas");
  const container = document.getElementById("accountsList");
  if (!wrapper || !canvas || !container) return;

  loadCanvasPositions();
  loadCanvasTransform();

  let isPanning = false;
  let isDragging = false;
  let dragGroup = null;
  let dragOffsetX = 0, dragOffsetY = 0;
  let panStartX = 0, panStartY = 0;
  let panOriginX = 0, panOriginY = 0;

  function applyTransform() {
    container.style.transform = `translate(${canvasTransform.x}px, ${canvasTransform.y}px) scale(${canvasTransform.scale})`;
    if (window._clawDrawWeb) window._clawDrawWeb();
  }
  window._clawApplyTransform = applyTransform;


  // Pan — зажатие пустого места
  wrapper.addEventListener("mousedown", (e) => {
    if (e.target.closest(".sqLogGroup")) return;
    if (e.target.closest(".sqBroadcastGroup")) return;
    if (e.target.closest(".sqGroup")) return;
    if (e.target.closest(".sqAIGroup")) return;
    if (e.target.closest(".sqTimerGroup")) return;
    if (e.target.closest(".sqProxyGroup")) return;
    if (e.button !== 0) return;
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panOriginX = canvasTransform.x;
    panOriginY = canvasTransform.y;
    wrapper.style.cursor = "grabbing";
  });

  window.addEventListener("mousemove", (e) => {
    if (isPanning) {
      canvasTransform.x = panOriginX + (e.clientX - panStartX);
      canvasTransform.y = panOriginY + (e.clientY - panStartY);
      applyTransform();
    }
    if (isDragging && dragGroup) {
      const x = (e.clientX - wrapper.getBoundingClientRect().left - canvasTransform.x) / canvasTransform.scale - dragOffsetX;
      const y = (e.clientY - wrapper.getBoundingClientRect().top - canvasTransform.y) / canvasTransform.scale - dragOffsetY;
      dragGroup.style.left = x + "px";
      dragGroup.style.top = y + "px";
      const id = dragGroup.dataset.accountId || `ai_${dragGroup.dataset.cardId}`;
      if (id) canvasPositions[id] = { x, y };
      // true — не пересоздавать кнопки на каждом движении мыши
      if (window._clawDrawWeb) window._clawDrawWeb(true);
    }
  });

  window.addEventListener("mouseup", () => {
    if (isPanning) { isPanning = false; wrapper.style.cursor = ""; saveCanvasTransform(); }
    if (isDragging) {
      isDragging = false; dragGroup = null; saveCanvasPositions();
      drawConnections();  // вернуть кнопки отсоединения на новые места
    }
  });

  // Zoom — колесо мыши
  document.addEventListener("wheel", (e) => {
    const homePage = document.getElementById("homePage");
    if (!homePage || !homePage.classList.contains("activePage")) return;
    if (!e.target.closest("#canvasWrapper")) return;
    e.preventDefault();
    const rect = wrapper.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newScale = Math.max(0.2, Math.min(3, canvasTransform.scale * delta));
    canvasTransform.x = mouseX - (mouseX - canvasTransform.x) * (newScale / canvasTransform.scale);
    canvasTransform.y = mouseY - (mouseY - canvasTransform.y) * (newScale / canvasTransform.scale);
    canvasTransform.scale = newScale;
    applyTransform();
    saveCanvasTransform();
  }, { passive: false });

  // Drag карточек (анкеты)
  container.addEventListener("mousedown", (e) => {
    const group = e.target.closest(".sqGroup");
    if (!group) return;
    if (e.target.closest("button, input, textarea, select, a")) return;
    // Точка соединения — это нитка, а не перетаскивание карточки
    if (e.target.closest(".sqConnectDot")) return;
    e.preventDefault();
    isDragging = true;
    dragGroup = group;
    const rect = wrapper.getBoundingClientRect();
    const gx = parseFloat(group.style.left || 0);
    const gy = parseFloat(group.style.top || 0);
    dragOffsetX = (e.clientX - rect.left - canvasTransform.x) / canvasTransform.scale - gx;
    dragOffsetY = (e.clientY - rect.top - canvasTransform.y) / canvasTransform.scale - gy;
    group.style.zIndex = "100";
    setTimeout(() => { if (dragGroup) dragGroup.style.zIndex = ""; }, 500);
  });

  // Drag AI карточек
  container.addEventListener("mousedown", (e) => {
    const group = e.target.closest(".sqAIGroup");
    if (!group) return;
    if (e.target.closest(".sqConnectDot")) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = wrapper.getBoundingClientRect();
    const gx = parseFloat(group.style.left || 0);
    const gy = parseFloat(group.style.top || 0);
    const ox = (e.clientX - rect.left) - gx;
    const oy = (e.clientY - rect.top) - gy;
    group.style.zIndex = "100";
    function move(e) {
      const x = (e.clientX - rect.left) - ox;
      const y = (e.clientY - rect.top) - oy;
      group.style.left = x + "px";
      group.style.top = y + "px";
      const cardId = group.dataset.cardId;
      if (cardId) canvasPositions[`ai_${cardId}`] = { x, y };
      if (window._clawDrawWeb) window._clawDrawWeb();
    }
    function up() {
      group.style.zIndex = "";
      saveCanvasPositions();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
    });

  // Drag нитки от sqConnectDot
  let drawingLine = false;
  let lineFromId = null;
  let lineEndX = 0, lineEndY = 0;

  container.addEventListener("mousedown", (e) => {
    const dot = e.target.closest(".sqConnectDot");
    if (!dot) return;
    e.stopPropagation();
    e.preventDefault();
    drawingLine = true;
    const group = dot.closest(".sqGroup") || dot.closest(".sqAIGroup") || dot.closest(".sqTimerGroup") || dot.closest(".sqProxyGroup") || dot.closest(".sqLogGroup") || dot.closest(".sqBroadcastGroup");
    lineFromId = group?.dataset.accountId;
    const rect = wrapper.getBoundingClientRect();
    lineEndX = e.clientX - rect.left;
    lineEndY = e.clientY - rect.top;
  });

  window.addEventListener("mousemove", (e) => {
    if (!drawingLine) return;
    const rect = wrapper.getBoundingClientRect();
    lineEndX = e.clientX - rect.left;
    lineEndY = e.clientY - rect.top;
    drawConnections();
    const ctx = canvas.getContext("2d");
    const fromEl = container.querySelector(`[data-account-id="${lineFromId}"]`);
    if (!fromEl) return;
    const fx = (parseFloat(fromEl.style.left||0) + fromEl.offsetWidth/2) * canvasTransform.scale + canvasTransform.x;
    const fy = (parseFloat(fromEl.style.top||0) + fromEl.offsetHeight/2) * canvasTransform.scale + canvasTransform.y;
    ctx.strokeStyle = "rgba(16,245,168,0.8)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6,4]);
    ctx.beginPath();
    ctx.moveTo(fx, fy);
    ctx.lineTo(lineEndX, lineEndY);
    ctx.stroke();
    ctx.setLineDash([]);
  });

  window.addEventListener("mouseup", (e) => {
    if (!drawingLine) return;
    drawingLine = false;
    const target = document.elementFromPoint(e.clientX, e.clientY);
    const toGroup = target?.closest(".sqGroup") || target?.closest(".sqAIGroup") || target?.closest(".sqTimerGroup") || target?.closest(".sqProxyGroup") || target?.closest(".sqLogGroup") || target?.closest(".sqBroadcastGroup");
    const toId = toGroup?.dataset.accountId;
    if (toId && toId !== lineFromId) {
      const exists = connections.find(c => (c.from===lineFromId&&c.to===toId)||(c.from===toId&&c.to===lineFromId));
      if (!exists) {
        const aiId = lineFromId.startsWith("ai_") ? lineFromId : toId.startsWith("ai_") ? toId : null;
        const accountId = lineFromId.startsWith("ai_") ? toId : toId.startsWith("ai_") ? lineFromId : null;

        // ── Нитка от AI-менеджера к анкете — сперва проверяем слоты, ПОТОМ создаём нитку ──
        if (aiId && accountId && !accountId.startsWith("ai_") && !accountId.startsWith("timer_")) {
          const cardId = aiId.replace("ai_", "");
          const aiCard = analyticsCards.find(c => c.cardId === cardId);
          if (aiCard) {
            fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(accountId)}`).then(r=>r.json()).then(cur => {
              loadKeySlots().then(() => {
                const hasKeys = (cur.settings?.groq_api_keys || "").trim().length > 0;
                const freeSlot = hasKeys ? null : keySlots.find(s => !s.account_id);

                if (!hasKeys && !freeSlot) {
                  alert("Недостаточно слотов для ключей — добавь ещё слот перед подключением.");
                  drawConnections();
                  return; // нитку не создаём вообще
                }

                // Слот есть (или ключи уже назначены) — теперь можно рисовать нитку
                connections.push({ from: lineFromId, to: toId });
                saveConnections();
                drawConnections();

                aiCard.accountId = accountId;
                fetch(WORKER_API + `/api/analytics-cards/${encodeURIComponent(cardId)}`, {
                  method: "PATCH",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ account_id: accountId }),
                }).catch(() => {});

                fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(accountId)}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    ...(cur.settings || {}),
                    bot_name: aiCard.botName || "",
                    bot_age: aiCard.botAge || "",
                    bot_gender: aiCard.botGender || "female",
                    location: aiCard.location || "",
                    contacts: aiCard.contacts || "",
                    contacts_trigger: aiCard.contactsTrigger || "",
                    ...(!hasKeys && freeSlot ? { groq_api_keys: freeSlot.keys, groq_api_key: freeSlot.keys.split("\n")[0].trim() } : {}),
                  }),
                }).then(() => {
                  if (!hasKeys && freeSlot) {
                    freeSlot.account_id = accountId;
                    renderKeySlots();
                    fetch(WORKER_API + "/api/key-slots/" + freeSlot.id + "/assign?account_id=" + encodeURIComponent(accountId), { method: "POST" }).catch(() => {});
                  }
                }).catch(() => {});
              }).catch(() => {});
            }).catch(() => {});
          } else {
            drawConnections();
          }
          return; // эта ветка сама всё обработала — дальше (прокси/обычные нитки) не идём
        }

        // ── Остальные типы соединений (прокси, обычные нитки анкета↔анкета и т.п.) ──
        connections.push({ from: lineFromId, to: toId });
        saveConnections();

        // ── Atolin: нитка между парс-анкетой и главной ──
        const isNode = (id) => id.startsWith("ai_") || id.startsWith("timer_") || id.startsWith("proxy_") || id.startsWith("log_");
        if (!isNode(lineFromId) && !isNode(toId)) {
          const a = cachedAccounts.find(x => x.id === lineFromId);
          const b = cachedAccounts.find(x => x.id === toId);
          const bothAtolin = a && b
            && (a.platform || "").toLowerCase() === "atolin"
            && (b.platform || "").toLowerCase() === "atolin";

          if (bothAtolin) {
            const parser = (a.role === "parser") ? a : (b.role === "parser") ? b : null;
            const main   = (a.role === "parser") ? b : (b.role === "parser") ? a : null;

            if (!parser) {
              alert("Одна из анкет должна быть в роли «Парс» — она собирает рассылки.");
            } else if (main.role === "parser") {
              alert("Обе анкеты в роли «Парс». Нужна одна «Обработка» и одна «Парс».");
            } else {
              fetch(WORKER_API + `/api/accounts/${encodeURIComponent(main.id)}/parser`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
                body: JSON.stringify({ parser_account_id: parser.id }),
              }).then(r => r.json()).then(d => {
                if (d.ok) {
                  main.parser_account_id = parser.id;
                  console.log("[ATOLIN] источник целей привязан:", parser.name, "→", main.name);
                } else {
                  alert("Не удалось привязать: " + (d.detail || "ошибка"));
                }
              }).catch(() => {});
            }
          }
        }

        const proxyId = lineFromId.startsWith("proxy_") ? lineFromId : toId.startsWith("proxy_") ? toId : null;
        const proxyAccountId = lineFromId.startsWith("proxy_") ? toId : toId.startsWith("proxy_") ? lineFromId : null;
        if (proxyId && proxyAccountId && !proxyAccountId.startsWith("proxy_") && !proxyAccountId.startsWith("ai_") && !proxyAccountId.startsWith("timer_")) {
          const proxyCard = proxyCards.find(c => c.id === proxyId);
          if (proxyCard) {
            fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(proxyAccountId)}`).then(r=>r.json()).then(cur => {
              fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(proxyAccountId)}`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
                body: JSON.stringify({
                  ...(cur.settings || {}),
                  proxy_protocol: proxyCard.protocol,
                  proxy_host: proxyCard.host,
                  proxy_port: proxyCard.port,
                  proxy_login: proxyCard.login,
                  proxy_password: proxyCard.password,
                  user_agent: proxyCard.userAgent,
                }),
              }).catch(() => {});
            }).catch(() => {});
          }
        }
      }
    }
    drawConnections();
  });

  window.addEventListener("resize", () => {
    // Раньше тут была drawWeb() — она чистила холст и рисовала только
    // бледную паутину, стирая все нитки сразу после отрисовки карточек.
    drawConnections();
  });
  // Контекстное меню по правой кнопке
  const ctxMenu = document.createElement("div");
  ctxMenu.id = "canvasCtxMenu";
  ctxMenu.style.cssText = "display:none;position:fixed;z-index:1000;background:rgba(17,17,22,.98);border:1px solid rgba(255,255,255,.16);border-radius:11px;padding:6px 0;min-width:196px;box-shadow:0 14px 40px rgba(0,0,0,.8);";
  ctxMenu.innerHTML = `
    <div id="ctxAddAI" style="padding:10px 16px;cursor:pointer;font:500 13px 'Space Grotesk',sans-serif;color:var(--text);display:flex;align-items:center;gap:8px;">
      ✦ Добавить AI-менеджера
    </div>
    <div id="ctxAddTimer" style="padding:10px 16px;cursor:pointer;font:500 13px 'Space Grotesk',sans-serif;color:var(--text);display:flex;align-items:center;gap:8px;">
      ⏱ Добавить таймер
    </div>
    <div id="ctxAddLog" style="padding:10px 16px;cursor:pointer;font:500 13px 'Space Grotesk',sans-serif;color:var(--text);display:flex;align-items:center;gap:8px;">
      📋 Добавить лог
    </div>
    <div id="ctxAddProxy" style="padding:10px 16px;cursor:pointer;font:500 13px 'Space Grotesk',sans-serif;color:var(--text);display:flex;align-items:center;gap:8px;">
      🌐 Прокси / User-Agent
    </div>
    <div id="ctxAddBroadcast" style="padding:10px 16px;cursor:pointer;font:500 13px 'Space Grotesk',sans-serif;color:var(--text);display:flex;align-items:center;gap:8px;">
      📡 Промт Трансляция
    </div>
    <div id="ctxConnectAccount" style="padding:10px 16px;cursor:pointer;font:500 13px 'Space Grotesk',sans-serif;color:var(--text);display:flex;align-items:center;gap:8px;border-top:1px solid rgba(255,255,255,0.08);margin-top:4px;">
      🔗 Подключить анкету
    </div>
  `;
  document.body.appendChild(ctxMenu);

  let ctxMenuX = 0, ctxMenuY = 0;

  wrapper.addEventListener("contextmenu", (e) => {
    if (e.target.closest(".sqGroup")) return;
    e.preventDefault();
    ctxMenu.style.display = "block";
    ctxMenu.style.left = e.clientX + "px";
    ctxMenu.style.top = e.clientY + "px";
    // Запоминаем координаты в canvas-пространстве
    const rect = wrapper.getBoundingClientRect();
    ctxMenuX = (e.clientX - rect.left - canvasTransform.x) / canvasTransform.scale;
    ctxMenuY = (e.clientY - rect.top - canvasTransform.y) / canvasTransform.scale;
  });

  document.getElementById("ctxAddAI").onclick = () => {
    ctxMenu.style.display = "none";
    window._ctxSpawnX = ctxMenuX;
    window._ctxSpawnY = ctxMenuY;
    document.getElementById("addAnalyticsBtn")?.click();
  };

  document.getElementById("ctxAddTimer").onclick = () => {
    ctxMenu.style.display = "none";
    window._ctxSpawnX = ctxMenuX;
    window._ctxSpawnY = ctxMenuY;
    addTimerCard();
  };

  document.getElementById("ctxAddLog").onclick = () => {
    ctxMenu.style.display = "none";
    window._ctxSpawnX = ctxMenuX;
    window._ctxSpawnY = ctxMenuY;
    addLogCard();
  };
  
  document.getElementById("ctxAddProxy").onclick = () => {
    ctxMenu.style.display = "none";
    window._ctxSpawnX = ctxMenuX;
    window._ctxSpawnY = ctxMenuY;
    addProxyCard();
  };

  document.getElementById("ctxAddBroadcast").onclick = () => {
    ctxMenu.style.display = "none";
    window._ctxSpawnX = ctxMenuX;
    window._ctxSpawnY = ctxMenuY;
    addBroadcastCard();
  };

  document.getElementById("ctxConnectAccount").onclick = () => {
    ctxMenu.style.display = "none";
    const form = document.getElementById("connectForm");
    const body = document.getElementById("connectBody");
    if (!form) return;
    form.style.display = "";
    if (body) body.style.display = "flex";
    form.scrollIntoView({ behavior: "smooth" });
  };

  document.addEventListener("mousedown", (e) => {
    if (!e.target.closest(".sqProxyGroup")) return;
    if (e.target.closest(".sqConnectDot")) return;
    isPanning = false;
    e.stopImmediatePropagation();
    var startX = e.clientX;
    var startY = e.clientY;
    var grp = e.target.closest(".sqProxyGroup");
    var startLeft = parseFloat(grp.style.left) || 0;
    var startTop = parseFloat(grp.style.top) || 0;
    function move(e) {
      isPanning = false;
      var dx = (e.clientX - startX) / canvasTransform.scale;
      var dy = (e.clientY - startY) / canvasTransform.scale;
      grp.style.left = (startLeft + dx) + "px";
      grp.style.top = (startTop + dy) + "px";
      const proxyId = grp.dataset.proxyId;
      const card = proxyCards.find(c => c.id === proxyId);
      if (card) { card.x = parseFloat(grp.style.left); card.y = parseFloat(grp.style.top); }
      if (window._clawDrawWeb) window._clawDrawWeb();
    }
    function up() {
      saveProxyCards();
      window.removeEventListener("mousemove", move, true);
      window.removeEventListener("mouseup", up, true);
    }
    window.addEventListener("mousemove", move, true);
    window.addEventListener("mouseup", up, true);
  }, true);

  document.addEventListener("click", () => { ctxMenu.style.display = "none"; });
  document.addEventListener("contextmenu", (e) => {
    if (!e.target.closest("#canvasWrapper")) ctxMenu.style.display = "none";
  });

  // Нитки между карточками
  const connections = JSON.parse(localStorage.getItem("claw_connections") || "[]");

  function saveConnections() {
    localStorage.setItem("claw_connections", JSON.stringify(connections));
  }

  function drawConnections(skipButtons) {
    const ctx = canvas.getContext("2d");
    const W = wrapper.offsetWidth;
    const H = wrapper.offsetHeight;
    // Присвоение canvas.width пересоздаёт буфер холста — дорого делать это
    // каждый кадр. Меняем размер только если он реально изменился.
    if (canvas.width !== W || canvas.height !== H) {
      canvas.width = W;
      canvas.height = H;
    }
    ctx.clearRect(0, 0, W, H);

    if (!skipButtons) wrapper.querySelectorAll(".connDisconnectBtn").forEach(el => el.remove());

    // Паутина между карточками
    const groups = [...container.querySelectorAll(".sqGroup")];
    if (groups.length >= 2) {
      const centers = groups.map(g => ({
        x: (parseFloat(g.style.left||0) + g.offsetWidth/2) * canvasTransform.scale + canvasTransform.x,
        y: (parseFloat(g.style.top||0) + g.offsetHeight/2) * canvasTransform.scale + canvasTransform.y,
      }));
      for (let i = 0; i < centers.length; i++) {
        for (let j = i+1; j < centers.length; j++) {
          const dx = centers[i].x - centers[j].x;
          const dy = centers[i].y - centers[j].y;
          const dist = Math.sqrt(dx*dx+dy*dy);
          if (dist > 600) continue;
          const alpha = Math.max(0, 1 - dist/600) * 0.08;
          ctx.strokeStyle = `rgba(92,110,248,${alpha})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(centers[i].x, centers[i].y);
          ctx.lineTo(centers[j].x, centers[j].y);
          ctx.stroke();
        }
      }
    }

    // Нитки соединений
    const now = Date.now();

    connections.forEach((conn, idx) => {
      const fromEl = container.querySelector(`[data-account-id="${conn.from}"]`);
      const toEl = container.querySelector(`[data-account-id="${conn.to}"]`);
      if (!fromEl || !toEl) return;

      const fx = (parseFloat(fromEl.style.left||0) + fromEl.offsetWidth/2) * canvasTransform.scale + canvasTransform.x;
      const fy = (parseFloat(fromEl.style.top||0) + fromEl.offsetHeight/2) * canvasTransform.scale + canvasTransform.y;
      const tx = (parseFloat(toEl.style.left||0) + toEl.offsetWidth/2) * canvasTransform.scale + canvasTransform.x;
      const ty = (parseFloat(toEl.style.top||0) + toEl.offsetHeight/2) * canvasTransform.scale + canvasTransform.y;

      const dx = tx - fx, dy = ty - fy;
      const len = Math.sqrt(dx*dx + dy*dy);

      // Определяем — есть ли активный сплит на одном из концов
      const fromAccountId = conn.from.startsWith("ai_") ? null : conn.from.startsWith("timer_") ? null : conn.from;
      const toAccountId   = conn.to.startsWith("ai_") ? null : conn.to.startsWith("timer_") ? null : conn.to;
      const isActive = (fromAccountId && runningSplits.has(fromAccountId)) || (toAccountId && runningSplits.has(toAccountId));

      if (isActive) {
        // ── АКТИВНАЯ нитка: плазменная дуга ──

        // Пульсация яркости
        const pulse = 0.75 + 0.25 * Math.sin(now * 0.004);

        // Широкий внешний ореол
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = `rgba(16,245,168,${0.06 * pulse})`;
        ctx.lineWidth = 20;
        ctx.lineCap = "round";
        ctx.shadowBlur = 0;
        ctx.stroke();

        // Средний слой
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = `rgba(16,245,168,${0.2 * pulse})`;
        ctx.lineWidth = 8;
        ctx.shadowColor = "#10f5a8";
        ctx.shadowBlur = 15;
        ctx.stroke();

        // Тело кабеля — тёмное
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = "rgba(0,30,20,0.8)";
        ctx.lineWidth = 3;
        ctx.shadowBlur = 0;
        ctx.stroke();

        // Плазменное ядро
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = `rgba(255,255,255,${0.85 * pulse})`;
        ctx.lineWidth = 1;
        ctx.shadowColor = "#10f5a8";
        ctx.shadowBlur = 25;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Бегущие частицы — быстрые искры
        const speed = 0.0004;
        const particleCount = Math.max(3, Math.floor(len / 60));
        for (let p = 0; p < particleCount; p++) {
          const t = ((now * speed + p / particleCount) % 1);
          const px = fx + dx * t;
          const py = fy + dy * t;

          // Длинный хвост
          const tailLen = 0.18;
          const t0 = Math.max(0, t - tailLen);
          const tailX = fx + dx * t0;
          const tailY = fy + dy * t0;

          const grad = ctx.createLinearGradient(tailX, tailY, px, py);
          grad.addColorStop(0, "rgba(16,245,168,0)");
          grad.addColorStop(0.5, "rgba(16,245,168,0.4)");
          grad.addColorStop(1, "rgba(255,255,255,1)");

          ctx.beginPath();
          ctx.moveTo(tailX, tailY);
          ctx.lineTo(px, py);
          ctx.strokeStyle = grad;
          ctx.lineWidth = 3;
          ctx.shadowColor = "#ffffff";
          ctx.shadowBlur = 20;
          ctx.stroke();
          ctx.shadowBlur = 0;

          // Яркая голова
          ctx.beginPath();
          ctx.arc(px, py, 2.5, 0, Math.PI * 2);
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = "#10f5a8";
          ctx.shadowBlur = 25;
          ctx.fill();
          ctx.shadowBlur = 0;
        }

        // Терминалы — светящиеся коннекторы
        [[fx, fy], [tx, ty]].forEach(([cx, cy]) => {
          ctx.beginPath();
          ctx.arc(cx, cy, 6, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(16,245,168,${0.8 * pulse})`;
          ctx.lineWidth = 2;
          ctx.shadowColor = "#10f5a8";
          ctx.shadowBlur = 20;
          ctx.stroke();
          ctx.shadowBlur = 0;
          ctx.beginPath();
          ctx.arc(cx, cy, 3, 0, Math.PI * 2);
          ctx.fillStyle = "#ffffff";
          ctx.shadowColor = "#10f5a8";
          ctx.shadowBlur = 15;
          ctx.fill();
          ctx.shadowBlur = 0;
        });
        ctx.shadowBlur = 0;

        } else {
        // ── НЕАКТИВНАЯ нитка: кабель под напряжением ──

        // Внешний ореол — широкий размытый
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = "rgba(99,102,241,0.06)";
        ctx.lineWidth = 14;
        ctx.lineCap = "round";
        ctx.shadowBlur = 0;
        ctx.stroke();

        // Средний слой — тело кабеля
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = "rgba(30,27,75,0.9)";
        ctx.lineWidth = 4;
        ctx.stroke();

        // Внутреннее свечение — тонкое и яркое
        ctx.beginPath();
        ctx.moveTo(fx, fy);
        ctx.lineTo(tx, ty);
        ctx.strokeStyle = "rgba(139,92,246,0.7)";
        ctx.lineWidth = 1.5;
        ctx.shadowColor = "#7c3aed";
        ctx.shadowBlur = 10;
        ctx.stroke();
        ctx.shadowBlur = 0;

        // Блики — имитация стеклянного провода
        const perpX = -(dy / len) * 1.2;
        const perpY = (dx / len) * 1.2;
        ctx.beginPath();
        ctx.moveTo(fx + perpX, fy + perpY);
        ctx.lineTo(tx + perpX, ty + perpY);
        ctx.strokeStyle = "rgba(196,181,253,0.25)";
        ctx.lineWidth = 0.8;
        ctx.shadowBlur = 0;
        ctx.stroke();

        // Терминалы на концах — металлические коннекторы
        [[fx, fy], [tx, ty]].forEach(([cx, cy]) => {
          // Внешнее кольцо
          ctx.beginPath();
          ctx.arc(cx, cy, 7, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(139,92,246,0.5)";
          ctx.lineWidth = 1.5;
          ctx.shadowColor = "#7c3aed";
          ctx.shadowBlur = 12;
          ctx.stroke();
          ctx.shadowBlur = 0;
          // Внутренний кружок
          ctx.beginPath();
          ctx.arc(cx, cy, 3.5, 0, Math.PI * 2);
          ctx.fillStyle = "rgba(167,139,250,0.9)";
          ctx.shadowColor = "#a78bfa";
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.shadowBlur = 0;
        });
      }

      // Кнопка отсоединения. На кадрах анимации её не трогаем — раньше она
      // пересоздавалась вместе со всеми слушателями 60 раз в секунду.
      if (skipButtons) return;
      const mx = (fx + tx) / 2;
      const my = (fy + ty) / 2;
      const btn = document.createElement("div");
      btn.className = "connDisconnectBtn";
      btn.textContent = "✕";
      btn.style.cssText = `
        position:absolute;
        left:${mx}px;
        top:${my}px;
        transform:translate(-50%,-50%);
        background:#17171e;
        border:1px solid rgba(255,255,255,.25);
        border-radius:50%;
        color:#ffffff;
        font:700 11px 'Inter',sans-serif;
        width:20px;height:20px;
        display:flex;align-items:center;justify-content:center;
        cursor:pointer;
        z-index:50;
        pointer-events:all;
        opacity:0;
        transition:opacity 0.15s;
        box-shadow:0 4px 14px rgba(0,0,0,.6);
      `;
      btn.addEventListener("mouseenter", () => btn.style.opacity = "1");
      btn.addEventListener("mouseleave", () => btn.style.opacity = "0");
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const conn = connections[idx];
        const aiId = conn.from.startsWith("ai_") ? conn.from : conn.to.startsWith("ai_") ? conn.to : null;
        if (aiId) {
          const cardId = aiId.replace("ai_", "");
          const aiCard = analyticsCards.find(c => c.cardId === cardId);
          if (aiCard) {
            aiCard.accountId = null;
            fetch(WORKER_API + `/api/analytics-cards/${encodeURIComponent(cardId)}`, {
              method: "PATCH",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ account_id: null }),
            }).catch(() => {});
          }
        }
        // Отвязываем слот ключей
        const disconnAccountId = conn.from.startsWith("ai_") ? conn.to : conn.from.startsWith("timer_") ? null : conn.from.startsWith("proxy_") ? conn.to : conn.from;
        if (disconnAccountId && !disconnAccountId.startsWith("ai_") && !disconnAccountId.startsWith("timer_") && !disconnAccountId.startsWith("proxy_")) {
          const boundSlot = keySlots.find(s => s.account_id === disconnAccountId);
          if (boundSlot) {
            boundSlot.account_id = null;
            renderKeySlots();
            fetch(WORKER_API + "/api/key-slots/release/" + encodeURIComponent(disconnAccountId), { method: "POST" }).catch(() => {});
          }
        }
        // Отвязка прокси
        const proxyNodeId = conn.from.startsWith("proxy_") ? conn.from : conn.to.startsWith("proxy_") ? conn.to : null;
        const proxyAccId = conn.from.startsWith("proxy_") ? conn.to : conn.to.startsWith("proxy_") ? conn.from : null;
        if (proxyNodeId && proxyAccId) {
          fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(proxyAccId)}`).then(r=>r.json()).then(cur => {
            fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(proxyAccId)}`, {
              method: "POST",
              headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
              body: JSON.stringify({
                ...(cur.settings || {}),
                proxy_protocol: "", proxy_host: "", proxy_port: "",
                proxy_login: "", proxy_password: "", user_agent: "",
              }),
            }).catch(() => {});
          }).catch(() => {});
        }
        // Отвязка источника целей Atolin
        const nodePrefixes = ["ai_", "timer_", "proxy_", "log_"];
        const isPlainAccount = (id) => !nodePrefixes.some(p => id.startsWith(p));
        if (isPlainAccount(conn.from) && isPlainAccount(conn.to)) {
          const a = cachedAccounts.find(x => x.id === conn.from);
          const b = cachedAccounts.find(x => x.id === conn.to);
          if (a && b && (a.platform || "").toLowerCase() === "atolin" && (b.platform || "").toLowerCase() === "atolin") {
            const main = (a.role === "parser") ? b : (b.role === "parser") ? a : null;
            if (main) {
              main.parser_account_id = null;
              fetch(WORKER_API + `/api/accounts/${encodeURIComponent(main.id)}/parser`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
                body: JSON.stringify({ parser_account_id: null }),
              }).catch(() => {});
            }
          }
        }

        connections.splice(idx, 1);
        saveConnections();
        drawConnections();
      });
      wrapper.appendChild(btn);
    });
  }

  // Анимационный цикл для бегущих частиц
  let _animFrameId = null;
  let _lastFrameAt = 0;
  function _startAnimLoop() {
    if (_animFrameId) return;
    function loop(now) {
      const hasActive = connections.some(conn => {
        const fromId = (!conn.from.startsWith("ai_") && !conn.from.startsWith("timer_")) ? conn.from : null;
        const toId   = (!conn.to.startsWith("ai_")   && !conn.to.startsWith("timer_"))   ? conn.to   : null;
        return (fromId && runningSplits.has(fromId)) || (toId && runningSplits.has(toId));
      });
      if (hasActive) {
        // 30 кадров вместо 60 — на глаз не отличить, нагрузка вдвое меньше.
        // true = не трогать DOM-кнопки на кадрах анимации.
        if (now - _lastFrameAt >= 33) {
          _lastFrameAt = now;
          drawConnections(true);
        }
        _animFrameId = requestAnimationFrame(loop);
      } else {
        _animFrameId = null;
        drawConnections();
      }
    }
    _animFrameId = requestAnimationFrame(loop);
  }
  window._clawStartAnim = _startAnimLoop;
  window._clawDrawWeb = (skipButtons) => drawConnections(skipButtons);
  window._clawRemoveConnections = (nodeId) => {
    for (let i = connections.length - 1; i >= 0; i--) {
      if (connections[i].from === nodeId || connections[i].to === nodeId) connections.splice(i, 1);
    }
    saveConnections();
    drawConnections();
  };

  applyTransform();
}

function placeGroupOnCanvas(group, accountId) {
  const saved = canvasPositions[accountId];
  if (saved) {
    group.style.left = saved.x + "px";
    group.style.top = saved.y + "px";
  } else {
    // Авто-расстановка по спирали
    const idx = document.getElementById("accountsList").querySelectorAll(".sqGroup").length;
    const angle = idx * 2.4;
    const radius = 60 + idx * 55;
    const cx = 500, cy = 100;
    const x = cx + Math.cos(angle) * radius;
    const y = cy + Math.sin(angle) * radius;
    group.style.left = x + "px";
    group.style.top = y + "px";
    canvasPositions[accountId] = { x, y };
    saveCanvasPositions();
  }
}

function drawWebIfReady() {
  window.dispatchEvent(new Event("resize"));
}

function renderSquareGridFromCache() {
  renderSquareGrid(cachedAccounts, cachedLogs);
}

function renderSquareGrid(accounts, statsMap) {
  if (!accountsList) return;

  const filtered = accounts.filter(a => {
    if ((a.platform || "").toLowerCase() !== activePlatform.toLowerCase()) return false;
    if (activeTabId) {
      const tab = operatorTabs.find(t => t.id === activeTabId);
      const tabAccounts = tab?.account_ids || [];
      return tabAccounts.includes(a.id);
    }
    return true;
  });

  const empty = document.getElementById("gridEmpty");
  const intCityPanel = document.getElementById("intCityPanel");
  if (intCityPanel) intCityPanel.style.display = "none";
  if (accountsList) accountsList.style.display = "";

  if (!filtered.length) {
    if (empty) empty.style.display = "none";
    accountsList.querySelectorAll(".sqGroup").forEach(el => el.remove());
    return;
  }
  if (empty) empty.style.display = "none";

  // Удаляем карточки которых больше нет
  const filteredIds = new Set(filtered.map(a => a.id));
  accountsList.querySelectorAll(".sqGroup").forEach(el => {
    const id = el.dataset.accountId;
    if (!filteredIds.has(id) && !id?.startsWith("timer_") && !id?.startsWith("ai_") && !id?.startsWith("proxy_") && !id?.startsWith("log_")) el.remove();
  });

  // Добавляем/обновляем только изменившиеся
  filtered.forEach((account, idx) => {
    const stats = statsMap[account.id] || { liked: 0, replied: 0, contacts: 0 };
    const isBlockedNow = account.is_blocked === true || String(account.is_blocked).toLowerCase() === "true";
    const runStatusNow = account.run_status || "idle";
    const runNoteNow = account.run_note || "";
    const existing = accountsList.querySelector(`.sqGroup[data-account-id="${account.id}"]`);

    if (existing) {
      const wasBlocked = existing.dataset.blocked === "1";
      const wasRunStatus = existing.dataset.runStatus || "idle";
      const wasRunNote = existing.dataset.runNote || "";
      // Пересоздаём карточку не только при смене блокировки, но и когда
      // изменился статус запуска — иначе карточка не показывает что анкета
      // работает по серверному таймеру.
      if (wasBlocked === isBlockedNow && wasRunStatus === runStatusNow && wasRunNote === runNoteNow) return;
      existing.remove();
    }

    const group = document.createElement("div");
    group.className = "sqGroup";
    group.dataset.accountId = account.id;
    group.dataset.blocked = isBlockedNow ? "1" : "0";
    group.dataset.runStatus = runStatusNow;
    group.dataset.runNote = runNoteNow;

    const node = createSquareCard(account, stats);
    group.appendChild(node);

  

    group.style.position = "absolute";
    placeGroupOnCanvas(group, account.id);
    accountsList.appendChild(group);
  });

  // Раньше на КАЖДУЮ анкету ставился свой setTimeout с полной перерисовкой
  // холста. Теперь одна перерисовка на весь рендер, что бы ни изменилось.
  clearTimeout(renderSquareGrid._redrawT);
  renderSquareGrid._redrawT = setTimeout(() => {
    if (document.getElementById("canvasWrapper")) drawWebIfReady();
  }, 50);

  return; // дальше старый код не нужен
}


let proxyCards = [];
let _proxyCardsLoaded = false;
const _proxySaveTimers = {};

function _proxyAuthHeaders() {
  return { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" };
}

// Ноды живут в базе. Сохраняем с задержкой, чтобы каждый набранный
// символ в поле не улетал отдельным запросом.
function saveProxyCards(card) {
  const list = card ? [card] : proxyCards;
  for (const c of list) {
    if (!c || !c.id) continue;
    clearTimeout(_proxySaveTimers[c.id]);
    _proxySaveTimers[c.id] = setTimeout(() => {
      fetch("/api/proxy-nodes", {
        method: "POST",
        headers: _proxyAuthHeaders(),
        body: JSON.stringify({
          id: c.id,
          platform: c.platform || "Mamba",
          protocol: c.protocol || "http",
          host: c.host || "",
          port: String(c.port || ""),
          login: c.login || "",
          password: c.password || "",
          user_agent: c.userAgent || "",
          x: c.x || 0,
          y: c.y || 0,
        }),
      }).catch(err => console.warn("proxy-node save:", err));
    }, 600);
  }
}

async function loadProxyCards() {
  try {
    const res = await fetch("/api/proxy-nodes", { headers: _proxyAuthHeaders() });
    const data = await res.json();
    proxyCards = (data.nodes || []).map(n => ({
      id: n.id,
      protocol: n.protocol || "http",
      host: n.host || "",
      port: n.port || "",
      login: n.login || "",
      password: n.password || "",
      userAgent: n.user_agent || "",
      x: n.x || 300,
      y: n.y || 300,
      platform: n.platform || "Mamba",
    }));
    _proxyCardsLoaded = true;

    // Разовый перенос старых нод из localStorage в базу
    const legacy = localStorage.getItem("claw_proxy_cards");
    if (legacy) {
      try {
        const old = JSON.parse(legacy) || [];
        const known = new Set(proxyCards.map(c => c.id));
        const moved = old.filter(c => c && c.id && !known.has(c.id));
        if (moved.length) {
          proxyCards.push(...moved);
          moved.forEach(c => saveProxyCards(c));
          console.log(`[PROXY] Перенесено нод из localStorage: ${moved.length}`);
        }
      } catch {}
      localStorage.removeItem("claw_proxy_cards");
    }
  } catch (err) {
    console.error("[PROXY] Не загрузились ноды прокси:", err);
  }
}

function addProxyCard() {
  const id = "proxy_" + Date.now();
  const x = window._ctxSpawnX || 300;
  const y = window._ctxSpawnY || 300;
  const card = { id, protocol: "http", host: "", port: "", login: "", password: "", userAgent: "", x, y, platform: activePlatform };
  proxyCards.push(card);
  saveProxyCards(card);
  renderProxyCard(card);
}

function renderProxyCard(card) {
  const container = document.getElementById("accountsList");
  if (!container) return;
  const existing = container.querySelector(`.sqProxyGroup[data-proxy-id="${card.id}"]`);
  if (existing) existing.remove();

  const group = document.createElement("div");
  group.className = "sqProxyGroup";
  group.dataset.proxyId = card.id;
  group.dataset.accountId = card.id;
  group.style.cssText = `position:absolute;left:${card.x}px;top:${card.y}px;z-index:10;cursor:grab;`;

  const dot = document.createElement("div");
  dot.className = "sqConnectDot";
  dot.title = "Потяни чтобы соединить";
  dot.style.cssText = "position:absolute;top:50%;right:-10px;transform:translateY(-50%);width:16px;height:16px;border-radius:50%;background:#60a5fa;border:2px solid var(--bg);cursor:crosshair;z-index:10;box-shadow:0 0 8px rgba(96,165,250,0.6);";
  group.appendChild(dot);

  const inner = document.createElement("div");
  inner.style.cssText = "background:var(--card2);border:1px solid rgba(46,224,138,.4);border-radius:14px;padding:14px;min-width:220px;box-shadow:var(--shadow-card);";
  inner.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <span style="font:700 11px 'Inter',sans-serif;color:#2ee08a;letter-spacing:0.05em;">🌐 ПРОКСИ</span>
      <button class="sqProxyDeleteBtn" style="background:none;border:none;color:#fb7185;cursor:pointer;font-size:14px;opacity:0.6;">✕</button>
    </div>
    <select class="sqProxyProtocol" style="width:100%;padding:5px 8px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(5,8,16,0.8);color:#60a5fa;font:600 11px 'JetBrains Mono',monospace;margin-bottom:6px;">
      <option value="http" ${card.protocol==="http"?"selected":""}>HTTP</option>
      <option value="https" ${card.protocol==="https"?"selected":""}>HTTPS</option>
      <option value="socks5" ${card.protocol==="socks5"?"selected":""}>SOCKS5</option>
    </select>
    <input class="sqProxyHost" type="text" placeholder="host" value="${card.host}" style="width:100%;padding:5px 8px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(5,8,16,0.8);color:#e2e8f0;font:400 11px 'JetBrains Mono',monospace;margin-bottom:6px;box-sizing:border-box;" />
    <input class="sqProxyPort" type="text" placeholder="port" value="${card.port}" style="width:100%;padding:5px 8px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(5,8,16,0.8);color:#e2e8f0;font:400 11px 'JetBrains Mono',monospace;margin-bottom:6px;box-sizing:border-box;" />
    <input class="sqProxyLogin" type="text" placeholder="логин (опционально)" value="${card.login}" style="width:100%;padding:5px 8px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(5,8,16,0.8);color:#e2e8f0;font:400 11px 'JetBrains Mono',monospace;margin-bottom:6px;box-sizing:border-box;" />
    <input class="sqProxyPassword" type="password" placeholder="пароль (опционально)" value="${card.password}" style="width:100%;padding:5px 8px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(5,8,16,0.8);color:#e2e8f0;font:400 11px 'JetBrains Mono',monospace;margin-bottom:6px;box-sizing:border-box;" />
    <input class="sqProxyUA" type="text" placeholder="User-Agent (опционально)" value="${card.userAgent}" style="width:100%;padding:5px 8px;border-radius:6px;border:1px solid rgba(96,165,250,0.3);background:rgba(5,8,16,0.8);color:#e2e8f0;font:400 11px 'JetBrains Mono',monospace;margin-bottom:8px;box-sizing:border-box;" />
    <div class="sqProxyStatus" style="font:400 10px 'JetBrains Mono',monospace;color:rgba(255,255,255,0.4);margin-bottom:8px;min-height:14px;"></div>
    <button class="sqProxyCheckBtn" style="width:100%;padding:9px;border-radius:8px;border:0;background:#2ee08a;color:#000;font:700 11.5px 'Inter',sans-serif;cursor:pointer;">⚡ ПРОВЕРИТЬ</button>
  `;
  group.appendChild(inner);
  container.appendChild(group);

  // drag через глобальный document обработчик

  // Inputs
  inner.querySelector(".sqProxyProtocol").oninput = e => { card.protocol = e.target.value; saveProxyCards(); };
  inner.querySelector(".sqProxyHost").oninput = e => {
    const val = e.target.value;
    const parts = val.split(":");
    if (parts.length >= 4) {
      card.host = parts[0];
      card.port = parts[1];
      card.login = parts[2];
      card.password = parts.slice(3).join(":");
      inner.querySelector(".sqProxyHost").value = card.host;
      inner.querySelector(".sqProxyPort").value = card.port;
      inner.querySelector(".sqProxyLogin").value = card.login;
      inner.querySelector(".sqProxyPassword").value = card.password;
    } else if (parts.length === 2) {
      card.host = parts[0];
      card.port = parts[1];
      inner.querySelector(".sqProxyHost").value = card.host;
      inner.querySelector(".sqProxyPort").value = card.port;
    } else {
      card.host = val;
    }
    saveProxyCards();
  };
  inner.querySelector(".sqProxyPort").oninput = e => { card.port = e.target.value; saveProxyCards(); };
  inner.querySelector(".sqProxyLogin").oninput = e => { card.login = e.target.value; saveProxyCards(); };
  inner.querySelector(".sqProxyPassword").oninput = e => { card.password = e.target.value; saveProxyCards(); };
  inner.querySelector(".sqProxyUA").oninput = e => { card.userAgent = e.target.value; saveProxyCards(); };

  // Delete
  inner.querySelector(".sqProxyDeleteBtn").onclick = async () => {
    group.remove();
    proxyCards = proxyCards.filter(c => c.id !== card.id);
    clearTimeout(_proxySaveTimers[card.id]);
    try {
      await fetch(`/api/proxy-nodes/${encodeURIComponent(card.id)}`, {
        method: "DELETE",
        headers: _proxyAuthHeaders(),
      });
    } catch (err) { console.warn("proxy-node delete:", err); }
  };

  // Check
  inner.querySelector(".sqProxyCheckBtn").onclick = async () => {
    const status = inner.querySelector(".sqProxyStatus");
    status.textContent = "Проверяю...";
    status.style.color = "rgba(255,255,255,0.4)";
    try {
      const res = await fetch(WORKER_API + "/api/proxy/check", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
        body: JSON.stringify({ protocol: card.protocol, host: card.host, port: card.port, login: card.login, password: card.password }),
      });
      const data = await res.json();
      if (data.ok) {
        const ua = card.userAgent ? " | UA: " + card.userAgent.slice(0, 30) + "..." : "";
        status.textContent = "✓ " + (data.ip || "OK") + ua;
        status.style.color = "#10f5a8";
      } else {
        status.textContent = "✗ " + (data.error || "Ошибка");
        status.style.color = "#fb7185";
      }
    } catch {
      status.textContent = "✗ Нет ответа";
      status.style.color = "#fb7185";
    }
  };
}

async function renderProxyCardsOnCanvas() {
  if (!_proxyCardsLoaded) await loadProxyCards();
  const container = document.getElementById("accountsList");
  if (!container) return;
  container.querySelectorAll(".sqProxyGroup").forEach(el => el.remove());
  proxyCards.filter(c => (c.platform || "Mamba") === activePlatform).forEach(card => renderProxyCard(card));
  if (window._clawDrawWeb) window._clawDrawWeb();
}

let timerCards = [];

function saveTimerCards() {
  try { localStorage.setItem("claw_timer_cards", JSON.stringify(timerCards)); } catch {}
}


function addTimerCard() {
  const id = "timer_" + Date.now();
  const container = document.getElementById("accountsList");
  if (!container) return;

  const x = (window._ctxSpawnX != null) ? window._ctxSpawnX : 400 + Math.random() * 200;
  const y = (window._ctxSpawnY != null) ? window._ctxSpawnY : 200 + Math.random() * 200;
  window._ctxSpawnX = null;
  window._ctxSpawnY = null;

  const card = { id, workMin: 1, workSec: 0, pauseMin: 0, pauseSec: 30, x, y, platform: activePlatform };
  timerCards.push(card);
  saveTimerCards();
  renderTimerCard(card);
}

function renderTimerCard(card) {
  const container = document.getElementById("accountsList");
  if (!container) return;

  const existing = container.querySelector(`.sqTimerGroup[data-timer-id="${card.id}"]`);
  if (existing) existing.remove();

  const group = document.createElement("div");
  group.className = "sqTimerGroup";
  group.dataset.timerId = card.id;
  group.dataset.accountId = card.id;
  group.style.cssText = `position:absolute;left:${card.x}px;top:${card.y}px;cursor:grab;z-index:10;`;

  // Точка соединения
  const dot = document.createElement("div");
  dot.className = "sqConnectDot";
  dot.title = "Потяни чтобы соединить";
  dot.style.cssText = "position:absolute;top:50%;right:-10px;transform:translateY(-50%);width:16px;height:16px;border-radius:50%;background:var(--accent3);border:2px solid var(--bg);cursor:crosshair;z-index:10;box-shadow:0 0 8px rgba(16,245,168,0.6);";
  group.appendChild(dot);

  group.innerHTML += `
    <div style="background:var(--card2);border:1px solid rgba(255,176,32,.45);border-radius:14px;padding:14px 16px;min-width:200px;position:relative;box-shadow:var(--shadow-card);">
      <button class="sqTimerDeleteBtn" style="position:absolute;top:6px;right:6px;background:none;border:none;color:#fb7185;cursor:pointer;font-size:14px;opacity:0.6;">✕</button>
      <div style="font:700 11px 'Inter',sans-serif;color:#ffb020;letter-spacing:0.05em;margin-bottom:12px;">⏱ ТАЙМЕР</div>
      <div style="font:500 11px 'Space Grotesk',sans-serif;color:rgba(255,255,255,0.5);margin-bottom:4px;">Работает</div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:10px;">
        <input class="sqTimerWorkMin" type="number" min="0" max="999" value="${card.workMin}" style="width:54px;padding:5px 8px;border-radius:6px;border:1px solid rgba(251,191,36,0.3);background:rgba(5,8,16,0.8);color:#fbbf24;font:600 13px 'JetBrains Mono',monospace;text-align:center;" />
        <span style="color:rgba(255,255,255,0.4);font-size:11px;">мин</span>
        <input class="sqTimerWorkSec" type="number" min="0" max="59" value="${card.workSec}" style="width:54px;padding:5px 8px;border-radius:6px;border:1px solid rgba(251,191,36,0.3);background:rgba(5,8,16,0.8);color:#fbbf24;font:600 13px 'JetBrains Mono',monospace;text-align:center;" />
        <span style="color:rgba(255,255,255,0.4);font-size:11px;">сек</span>
      </div>
      <div style="font:500 11px 'Space Grotesk',sans-serif;color:rgba(255,255,255,0.5);margin-bottom:4px;">Пауза перед перезапуском</div>
      <div style="display:flex;gap:6px;align-items:center;margin-bottom:12px;">
        <input class="sqTimerPauseMin" type="number" min="0" max="999" value="${card.pauseMin}" style="width:54px;padding:5px 8px;border-radius:6px;border:1px solid rgba(92,110,248,0.3);background:rgba(5,8,16,0.8);color:#a5b4fc;font:600 13px 'JetBrains Mono',monospace;text-align:center;" />
        <span style="color:rgba(255,255,255,0.4);font-size:11px;">мин</span>
        <input class="sqTimerPauseSec" type="number" min="0" max="59" value="${card.pauseSec}" style="width:54px;padding:5px 8px;border-radius:6px;border:1px solid rgba(92,110,248,0.3);background:rgba(5,8,16,0.8);color:#a5b4fc;font:600 13px 'JetBrains Mono',monospace;text-align:center;" />
        <span style="color:rgba(255,255,255,0.4);font-size:11px;">сек</span>
      </div>
      <div class="sqTimerStatus" style="font:400 11px 'JetBrains Mono',monospace;color:rgba(255,255,255,0.4);margin-bottom:10px;min-height:16px;"></div>
      <button class="sqTimerStartBtn" style="width:100%;padding:9px;border-radius:8px;border:0;background:#ffb020;color:#000;font:700 11.5px 'Inter',sans-serif;cursor:pointer;">▶ ВКЛЮЧИТЬ</button>
    </div>
  `;

  // Drag
  group.addEventListener("mousedown", (e) => {
    if (e.target.closest(".sqConnectDot")) return;
    if (e.target.closest("button, input")) return;
    e.preventDefault();
    e.stopPropagation();
    const wrapper = document.getElementById("canvasWrapper");
    const rect = wrapper.getBoundingClientRect();
    const ox = e.clientX - rect.left - parseFloat(group.style.left);
    const oy = e.clientY - rect.top - parseFloat(group.style.top);
    group.style.zIndex = "100";
    function move(e) {
      const x = e.clientX - rect.left - ox;
      const y = e.clientY - rect.top - oy;
      group.style.left = x + "px";
      group.style.top = y + "px";
      card.x = x; card.y = y;
      canvasPositions[card.id] = { x, y };
      if (window._clawDrawWeb) window._clawDrawWeb();
    }
    function up() {
      group.style.zIndex = "";
      saveTimerCards();
      saveCanvasPositions();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  // Удалить
  group.querySelector(".sqTimerDeleteBtn").onclick = async (e) => {
    e.stopPropagation();
    stopTimerCard(card.id);

    // Снимаем расписание на сервере. Без этого воркер продолжит
    // ставить задачи вечно — ноды уже нет, а выключить нечем.
    const accountIds = Array.from(new Set([
      ...getTimerLinkedAccounts(card.id),
      ...(card.lastAccountIds || []),
    ]));
    for (const accId of accountIds) {
      try {
        await fetch(`/api/accounts/${accId}/schedule`, {
          method: "DELETE",
          headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" },
        });
        runningSplits.delete(accId);
      } catch (err) { console.warn("schedule delete:", err); }
    }

    timerCards = timerCards.filter(c => c.id !== card.id);
    saveTimerCards();
    group.remove();
    if (window._clawDrawWeb) window._clawDrawWeb();
    await loadAccounts();
  };

  // Сохранение значений при изменении
  group.querySelector(".sqTimerWorkMin").addEventListener("input", (e) => { card.workMin = parseInt(e.target.value) || 0; saveTimerCards(); });
  group.querySelector(".sqTimerWorkSec").addEventListener("input", (e) => { card.workSec = parseInt(e.target.value) || 0; saveTimerCards(); });
  group.querySelector(".sqTimerPauseMin").addEventListener("input", (e) => { card.pauseMin = parseInt(e.target.value) || 0; saveTimerCards(); });
  group.querySelector(".sqTimerPauseSec").addEventListener("input", (e) => { card.pauseSec = parseInt(e.target.value) || 0; saveTimerCards(); });

  // Старт/стоп
  const startBtn = group.querySelector(".sqTimerStartBtn");
  const statusEl = group.querySelector(".sqTimerStatus");

  // Восстанавливаем состояние после перезагрузки
  if (card.watching) {
    card._watching = true;
    startBtn.innerHTML = "⏹ ВЫКЛЮЧИТЬ";
    startBtn.style.background = "#ff5c85";
    statusEl.textContent = "Слежу за сплитом...";
    watchScheduleStatus(card, statusEl);
  }

  startBtn.onclick = async () => {
    const linked = getTimerLinkedAccounts(card.id);
    // При выключении добавляем анкеты, которые запускались этим таймером
    // раньше — нитку могли отцепить, а расписание на сервере осталось.
    const accountIds = card._watching
      ? Array.from(new Set([...linked, ...(card.lastAccountIds || [])]))
      : linked;
    if (!accountIds.length) {
      statusEl.textContent = "⚠ Привяжи анкету ниткой";
      return;
    }

    if (card._watching) {
      card._watching = false;
      card.watching = false;
      saveTimerCards();
      stopTimerCard(card.id);
      startBtn.innerHTML = "▶ ВКЛЮЧИТЬ";
      startBtn.style.background = "#ffb020";
      statusEl.textContent = "Выключаю...";
      for (const accId of accountIds) {
        try {
          await fetch(`/api/accounts/${accId}/schedule`, {
            method: "DELETE",
            headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" },
          });
          runningSplits.delete(accId);
        } catch (err) { console.warn("schedule delete:", err); }
      }
      statusEl.textContent = "Выключен";
      await loadAccounts();
      return;
    }

    const workSec  = (card.workMin  * 60) + card.workSec;
    const pauseSec = (card.pauseMin * 60) + card.pauseSec;
    if (workSec <= 0) { statusEl.textContent = "Укажи время работы"; return; }

    card._watching = true;
    card.watching = true;
    saveTimerCards();
    startBtn.innerHTML = "⏹ ВЫКЛЮЧИТЬ";
    startBtn.style.background = "#ff5c85";
    statusEl.textContent = "Запускаю на сервере...";

    let ok = 0;
    for (const accId of accountIds) {
      const limitInput = document.querySelector(`.sqGroup[data-account-id="${accId}"] .sqSplitInput`);
      const limit = parseInt(limitInput?.value) || 10;
      try {
        const res = await fetch(`/api/accounts/${accId}/schedule`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": localStorage.getItem("claw_auth_token") || "",
          },
          body: JSON.stringify({
            work_sec: workSec,
            pause_sec: pauseSec,
            limit_likes: limit,
            enabled: true,
            do_likes: document.querySelector(`.sqGroup[data-account-id="${accId}"] .sqDoLikes`)?.checked !== false,
            do_chats: document.querySelector(`.sqGroup[data-account-id="${accId}"] .sqDoChats`)?.checked !== false,
          }),
        });
        if (res.ok) { ok++; runningSplits.add(accId); }
      } catch (err) { console.warn("schedule post:", err); }
    }

    card.lastAccountIds = accountIds;
    saveTimerCards();

    statusEl.textContent = ok
      ? `▶ Работает на сервере (${ok})`
      : "⚠ Не удалось запустить";
    await loadAccounts();
    watchScheduleStatus(card, statusEl);
  };

  container.appendChild(group);
  canvasPositions[card.id] = { x: card.x, y: card.y };
  if (window._clawDrawWeb) window._clawDrawWeb();
}

const _timerIntervals = {};

function stopTimerCard(cardId) {
  const card = timerCards.find(c => c.id === cardId);
  if (!card) return;
  card._running = false;
  if (_timerIntervals[cardId]) {
    clearTimeout(_timerIntervals[cardId]);
    delete _timerIntervals[cardId];
  }
}

function getTimerLinkedAccounts(cardId) {
  const conns = JSON.parse(localStorage.getItem("claw_connections") || "[]");
  return conns
    .filter(c => c.from === cardId || c.to === cardId)
    .map(c => c.from === cardId ? c.to : c.from)
    .filter(id => !id.startsWith("ai_") && !id.startsWith("timer_") && !id.startsWith("proxy_"));
}

// Только отображение обратного отсчёта — сам отсчёт, паузы и запуск кругов
// делает воркер на сервере. Раньше весь цикл жил здесь, поэтому при
// сворачивании или закрытии браузера анкеты залипали и вставали.
function watchScheduleStatus(card, statusEl) {
  stopTimerCard(card.id);

  async function tick() {
    if (!card._watching) return;
    try {
      const res = await fetch("/api/schedules", {
        headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" },
      });
      const data = await res.json();
      const ids = getTimerLinkedAccounts(card.id);
      const all = data.schedules || [];
      const mine = all.filter(s => ids.includes(s.account_id) && s.enabled);

      if (!mine.length) {
        card._emptyStreak = (card._emptyStreak || 0) + 1;
        console.warn("[TIMER] нет совпадений", {
          httpStatus: res.status,
          ищетIds: ids,
          пришлоСервера: all.map(s => ({ id: s.account_id, enabled: s.enabled })),
          подряд: card._emptyStreak,
        });
        if (card._emptyStreak < 5) {
          statusEl.textContent = "Синхронизация...";
          _timerIntervals[card.id] = setTimeout(tick, 5000);
          return;
        }
        statusEl.textContent = "Выключен";
        card._watching = false;
        card.watching = false;
        saveTimerCards();
        return;
      }

      card._emptyStreak = 0;
      const s = mine[0];
      const started = new Date(s.phase_started_at).getTime();
      const total = (s.phase === "work" ? s.work_sec : s.pause_sec) * 1000;
      const left = Math.max(0, Math.round((started + total - Date.now()) / 1000));
      const mm = String(Math.floor(left / 60)).padStart(2, "0");
      const ss = String(left % 60).padStart(2, "0");
      statusEl.textContent = s.phase === "work"
        ? `▶ Работает — ${mm}:${ss} (${mine.length})`
        : `⏸ Пауза — ${mm}:${ss}`;
    } catch (err) {
      console.error("[TIMER] ошибка запроса /api/schedules:", err);
      statusEl.textContent = "Работает на сервере";
    }
    // Раньше loadAccounts() (три запроса, один из них читает весь tasks_log)
    // дёргался каждые 5 секунд на КАЖДУЮ ноду таймера.
    // Обратный отсчёт по-прежнему тикает раз в 5 сек, а карточки
    // перезагружаем раз в 30 — статус анкеты так часто не меняется.
    card._tickCount = (card._tickCount || 0) + 1;
    if (card._tickCount % 6 === 0) loadAccounts();
    _timerIntervals[card.id] = setTimeout(tick, 5000);
  }

  tick();
}

// ══════════════════════════════════════════════════════════
// ЛОГ-НОДА — живой лог действий анкеты прямо на канвасе
// ══════════════════════════════════════════════════════════

let logCards = [];
const _logIntervals = {};

function saveLogCards() {
  try { localStorage.setItem("claw_log_cards", JSON.stringify(logCards)); } catch {}
}

function addLogCard() {
  const id = "log_" + Date.now();
  const x = (window._ctxSpawnX != null) ? window._ctxSpawnX : 500 + Math.random() * 150;
  const y = (window._ctxSpawnY != null) ? window._ctxSpawnY : 250 + Math.random() * 150;
  window._ctxSpawnX = null;
  window._ctxSpawnY = null;
  const card = { id, x, y, platform: activePlatform };
  logCards.push(card);
  saveLogCards();
  renderLogCard(card);
}

function getLogLinkedAccount(cardId) {
  const conns = JSON.parse(localStorage.getItem("claw_connections") || "[]");
  const ids = conns
    .filter(c => c.from === cardId || c.to === cardId)
    .map(c => c.from === cardId ? c.to : c.from)
    .filter(id => !id.startsWith("ai_") && !id.startsWith("timer_") && !id.startsWith("proxy_") && !id.startsWith("log_") && !id.startsWith("bcast_"));
  return ids[0] || null;
}

function stopLogCard(cardId) {
  if (_logIntervals[cardId]) {
    clearTimeout(_logIntervals[cardId]);
    delete _logIntervals[cardId];
  }
}

function renderLogCard(card) {
  const container = document.getElementById("accountsList");
  if (!container) return;

  const existing = container.querySelector(`.sqLogGroup[data-log-id="${card.id}"]`);
  if (existing) existing.remove();

  const group = document.createElement("div");
  group.className = "sqLogGroup";
  group.dataset.logId = card.id;
  group.dataset.accountId = card.id;
  group.style.cssText = `position:absolute;left:${card.x}px;top:${card.y}px;cursor:grab;z-index:10;`;

  const dot = document.createElement("div");
  dot.className = "sqConnectDot";
  dot.title = "Потяни к анкете";
  dot.style.cssText = "position:absolute;top:50%;left:-10px;transform:translateY(-50%);width:16px;height:16px;border-radius:50%;background:#38bdf8;border:2px solid var(--bg);cursor:crosshair;z-index:10;box-shadow:0 0 8px rgba(56,189,248,0.6);";
  group.appendChild(dot);

  const inner = document.createElement("div");
  inner.style.cssText = "background:var(--card2);border:1px solid rgba(42,212,238,.35);border-radius:14px;width:340px;height:260px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow-card);";
  inner.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:rgba(42,212,238,.07);border-bottom:1px solid rgba(42,212,238,.18);flex-shrink:0;">
      <span style="font:700 11px 'Inter',sans-serif;color:#2ad4ee;letter-spacing:0.05em;">📋 ЛОГ</span>
      <span class="sqLogName" style="flex:1;font:400 11px 'Space Grotesk',sans-serif;color:rgba(255,255,255,0.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">не привязан</span>
      <button class="sqLogClearBtn" title="Очистить" style="background:none;border:none;color:rgba(255,255,255,0.3);cursor:pointer;font-size:12px;">⌫</button>
      <button class="sqLogDeleteBtn" style="background:none;border:none;color:#fb7185;cursor:pointer;font-size:13px;opacity:0.6;">✕</button>
    </div>
    <div class="sqLogBody" style="flex:1;overflow-y:auto;padding:9px 12px;font:400 10.5px/1.6 'JetBrains Mono',monospace;color:#7dd3fc;white-space:pre-wrap;word-break:break-word;"></div>
  `;
  group.appendChild(inner);
  container.appendChild(group);

  const bodyEl = inner.querySelector(".sqLogBody");
  const nameEl = inner.querySelector(".sqLogName");

  // Drag
  group.addEventListener("mousedown", (e) => {
    if (e.target.closest(".sqConnectDot")) return;
    if (e.target.closest("button, .sqLogBody")) return;
    e.preventDefault();
    e.stopPropagation();
    const wrapper = document.getElementById("canvasWrapper");
    const rect = wrapper.getBoundingClientRect();
    const ox = e.clientX - rect.left - parseFloat(group.style.left);
    const oy = e.clientY - rect.top - parseFloat(group.style.top);
    group.style.zIndex = "100";
    function move(e) {
      const x = e.clientX - rect.left - ox;
      const y = e.clientY - rect.top - oy;
      group.style.left = x + "px";
      group.style.top = y + "px";
      card.x = x; card.y = y;
      canvasPositions[card.id] = { x, y };
      if (window._clawDrawWeb) window._clawDrawWeb();
    }
    function up() {
      group.style.zIndex = "";
      saveLogCards();
      saveCanvasPositions();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  inner.querySelector(".sqLogDeleteBtn").onclick = (e) => {
    e.stopPropagation();
    stopLogCard(card.id);
    logCards = logCards.filter(c => c.id !== card.id);
    saveLogCards();
    if (window._clawRemoveConnections) window._clawRemoveConnections(card.id);
    group.remove();
    if (window._clawDrawWeb) window._clawDrawWeb();
  };

  inner.querySelector(".sqLogClearBtn").onclick = (e) => {
    e.stopPropagation();
    bodyEl.innerHTML = "";
    card._lastId = 0;
  };

  function appendLine(text) {
    const span = document.createElement("div");
    span.textContent = text;
    const t = text.toLowerCase();
    if (t.includes("блок") || t.includes("ошибка")) span.style.color = "#fb7185";
    else if (t.includes("пауза") || t.includes("пропус")) span.style.color = "#fbbf24";
    else if (t.includes("✓") || t.includes("отправ") || t.includes("лайк")) span.style.color = "#10f5a8";
    else span.style.color = "#7dd3fc";
    bodyEl.appendChild(span);
    while (bodyEl.childElementCount > 300) bodyEl.removeChild(bodyEl.firstChild);
    bodyEl.scrollTop = bodyEl.scrollHeight;
  }

  card._lastId = 0;

  async function poll() {
    const accountId = getLogLinkedAccount(card.id);
    if (!accountId) {
      nameEl.textContent = "не привязан";
      if (!bodyEl.childElementCount) appendLine("Протяни нитку к анкете →");
      _logIntervals[card.id] = setTimeout(poll, 10000);
      return;
    }

    const acc = (cachedAccounts || []).find(a => a.id === accountId);
    nameEl.textContent = acc ? (acc.name || accountId.slice(0, 8)) : accountId.slice(0, 8);

    try {
      const url = card._lastId
        ? `/api/split-log/${encodeURIComponent(accountId)}?after_id=${card._lastId}`
        : `/api/split-log/${encodeURIComponent(accountId)}`;
      const res = await fetch(url, {
        headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" },
      });
      const data = await res.json();
      const logs = data.logs || [];
      if (logs.length) {
        logs.forEach(row => appendLine(row.message));
        card._lastId = data.last_id || logs[logs.length - 1].id || card._lastId;
      } else if (!card._lastId && !bodyEl.childElementCount) {
        appendLine("Логов пока нет — жду активности...");
      }
    } catch (err) {
      // тихо — сеть моргнула, следующий тик подберёт
    }

    _logIntervals[card.id] = setTimeout(poll, 3000);
  }

  poll();

  canvasPositions[card.id] = { x: card.x, y: card.y };
  if (window._clawDrawWeb) window._clawDrawWeb();
}

function renderTimerCardsOnCanvas() {
  try {
    const raw = localStorage.getItem("claw_timer_cards");
    if (raw) timerCards = JSON.parse(raw);
  } catch {}
  const container = document.getElementById("accountsList");
  if (container) container.querySelectorAll(".sqTimerGroup").forEach(el => el.remove());
  timerCards.filter(c => (c.platform || "Mamba") === activePlatform).forEach(card => {
    renderTimerCard(card);
  });
}

function renderLogCardsOnCanvas() {
  try {
    const raw = localStorage.getItem("claw_log_cards");
    if (raw) logCards = JSON.parse(raw);
  } catch {}
  const container = document.getElementById("accountsList");
  if (container) container.querySelectorAll(".sqLogGroup").forEach(el => el.remove());
  Object.keys(_logIntervals).forEach(stopLogCard);
  logCards.filter(c => (c.platform || "Mamba") === activePlatform).forEach(card => renderLogCard(card));
}

// ══════════════════════════════════════════════════════════
// НОДА «ПРОМТ ТРАНСЛЯЦИЯ» — промт рассылки для Lovelaz
// ══════════════════════════════════════════════════════════

let broadcastCards = [];
const _bcastIntervals = {};

function saveBroadcastCards() {
  try { localStorage.setItem("claw_broadcast_cards", JSON.stringify(broadcastCards)); } catch {}
}

function addBroadcastCard() {
  const id = "bcast_" + Date.now();
  const x = (window._ctxSpawnX != null) ? window._ctxSpawnX : 500 + Math.random() * 150;
  const y = (window._ctxSpawnY != null) ? window._ctxSpawnY : 250 + Math.random() * 150;
  window._ctxSpawnX = null;
  window._ctxSpawnY = null;
  const card = { id, x, y, platform: activePlatform, prompt: "", limit: 30, delay: 20, pages: 1 };
  broadcastCards.push(card);
  saveBroadcastCards();
  renderBroadcastCard(card);
}

// какая анкета привязана к ноде
function getBroadcastLinkedAccount(cardId) {
  const conns = JSON.parse(localStorage.getItem("claw_connections") || "[]");
  const ids = conns
    .filter(c => c.from === cardId || c.to === cardId)
    .map(c => c.from === cardId ? c.to : c.from)
    .filter(id => !id.startsWith("ai_") && !id.startsWith("timer_") && !id.startsWith("proxy_") && !id.startsWith("log_") && !id.startsWith("bcast_"));
  return ids[0] || null;
}

// обратный поиск: нода трансляции, привязанная к анкете
function getBroadcastCardForAccount(accountId) {
  try {
    const raw = localStorage.getItem("claw_broadcast_cards");
    if (raw) broadcastCards = JSON.parse(raw);
  } catch {}
  const conns = JSON.parse(localStorage.getItem("claw_connections") || "[]");
  const ids = conns
    .filter(c => c.from === accountId || c.to === accountId)
    .map(c => c.from === accountId ? c.to : c.from)
    .filter(id => id.startsWith("bcast_"));
  if (!ids.length) return null;
  return broadcastCards.find(c => c.id === ids[0]) || null;
}

function renderBroadcastCard(card) {
  const container = document.getElementById("accountsList");
  if (!container) return;

  const existing = container.querySelector(`.sqBroadcastGroup[data-bcast-id="${card.id}"]`);
  if (existing) existing.remove();

  const group = document.createElement("div");
  group.className = "sqBroadcastGroup";
  group.dataset.bcastId = card.id;
  group.dataset.accountId = card.id;
  group.style.cssText = `position:absolute;left:${card.x}px;top:${card.y}px;cursor:grab;z-index:10;`;

  const dot = document.createElement("div");
  dot.className = "sqConnectDot";
  dot.title = "Потяни к анкете Lovelaz";
  dot.style.cssText = "position:absolute;top:50%;left:-10px;transform:translateY(-50%);width:16px;height:16px;border-radius:50%;background:#c084fc;border:2px solid var(--bg);cursor:crosshair;z-index:10;box-shadow:0 0 8px rgba(192,132,252,0.6);";
  group.appendChild(dot);

  const inner = document.createElement("div");
  inner.style.cssText = "background:var(--card2);border:1px solid rgba(255,92,133,.4);border-radius:14px;width:320px;display:flex;flex-direction:column;overflow:hidden;box-shadow:var(--shadow-card);";
  inner.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;padding:9px 12px;background:rgba(255,92,133,.08);border-bottom:1px solid rgba(255,92,133,.2);">
      <span class="sqBcastName" style="flex:1;font:400 11px 'Space Grotesk',sans-serif;color:rgba(255,255,255,0.45);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">не привязан</span>
      <button class="sqBcastDeleteBtn" style="background:none;border:none;color:#fb7185;cursor:pointer;font-size:13px;opacity:0.6;">✕</button>
    </div>
    <div style="padding:10px 12px;display:flex;flex-direction:column;gap:8px;">
      <textarea class="sqBcastPrompt" placeholder="Промт трансляции — что писать в рассылке..." style="width:100%;min-height:110px;resize:vertical;box-sizing:border-box;padding:8px;border-radius:8px;border:1px solid rgba(192,132,252,0.25);background:rgba(5,8,16,0.8);color:#e9d5ff;font:400 11.5px/1.5 'Space Grotesk',sans-serif;"></textarea>
      <div style="display:flex;gap:8px;align-items:center;">
        <span style="font:400 10.5px 'Space Grotesk',sans-serif;color:rgba(255,255,255,0.45);">Кол-во:</span>
        <input class="sqBcastLimit" type="number" min="1" max="500" style="width:60px;padding:4px 6px;border-radius:6px;border:1px solid rgba(192,132,252,0.25);background:rgba(5,8,16,0.8);color:#e9d5ff;font:400 11px 'JetBrains Mono',monospace;" />
        <span style="font:400 10.5px 'Space Grotesk',sans-serif;color:rgba(255,255,255,0.45);">Пауза, сек:</span>
        <input class="sqBcastDelay" type="number" min="1" max="600" style="width:60px;padding:4px 6px;border-radius:6px;border:1px solid rgba(192,132,252,0.25);background:rgba(5,8,16,0.8);color:#e9d5ff;font:400 11px 'JetBrains Mono',monospace;" />
      </div>
      <div style="display:flex;gap:8px;align-items:center;">
        <span style="font:400 10.5px 'Space Grotesk',sans-serif;color:rgba(255,255,255,0.45);">Листов за раз:</span>
        <input class="sqBcastPages" type="number" min="1" max="20" style="width:60px;padding:4px 6px;border-radius:6px;border:1px solid rgba(192,132,252,0.25);background:rgba(5,8,16,0.8);color:#e9d5ff;font:400 11px 'JetBrains Mono',monospace;" />
        <span style="font:400 10px 'Space Grotesk',sans-serif;color:rgba(255,255,255,0.3);">96 анкет / лист</span>
      </div>
    </div>
  `;
  group.appendChild(inner);
  container.appendChild(group);

  const promptEl = inner.querySelector(".sqBcastPrompt");
  const limitEl  = inner.querySelector(".sqBcastLimit");
  const delayEl  = inner.querySelector(".sqBcastDelay");
  const pagesEl  = inner.querySelector(".sqBcastPages");
  const nameEl   = inner.querySelector(".sqBcastName");

  promptEl.value = card.prompt || "";
  limitEl.value  = card.limit || 30;
  delayEl.value  = card.delay || 20;
  pagesEl.value  = card.pages || 1;

  promptEl.oninput = e => { card.prompt = e.target.value; saveBroadcastCards(); };
  limitEl.oninput  = e => { card.limit  = parseInt(e.target.value) || 30; saveBroadcastCards(); };
  delayEl.oninput  = e => { card.delay  = parseInt(e.target.value) || 20; saveBroadcastCards(); };
  pagesEl.oninput  = e => { card.pages  = parseInt(e.target.value) || 1; saveBroadcastCards(); };

  // Drag
  group.addEventListener("mousedown", (e) => {
    if (e.target.closest(".sqConnectDot")) return;
    if (e.target.closest("button, input, textarea, select")) return;
    e.preventDefault();
    e.stopPropagation();
    const wrapper = document.getElementById("canvasWrapper");
    const rect = wrapper.getBoundingClientRect();
    const ox = e.clientX - rect.left - parseFloat(group.style.left);
    const oy = e.clientY - rect.top - parseFloat(group.style.top);
    group.style.zIndex = "100";
    function move(e) {
      const x = e.clientX - rect.left - ox;
      const y = e.clientY - rect.top - oy;
      group.style.left = x + "px";
      group.style.top = y + "px";
      card.x = x; card.y = y;
      canvasPositions[card.id] = { x, y };
      if (window._clawDrawWeb) window._clawDrawWeb();
    }
    function up() {
      group.style.zIndex = "";
      saveBroadcastCards();
      saveCanvasPositions();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });

  inner.querySelector(".sqBcastDeleteBtn").onclick = (e) => {
    e.stopPropagation();
    if (_bcastIntervals[card.id]) { clearInterval(_bcastIntervals[card.id]); delete _bcastIntervals[card.id]; }
    broadcastCards = broadcastCards.filter(c => c.id !== card.id);
    saveBroadcastCards();
    if (window._clawRemoveConnections) window._clawRemoveConnections(card.id);
    group.remove();
    if (window._clawDrawWeb) window._clawDrawWeb();
  };

  function refreshName() {
    const accountId = getBroadcastLinkedAccount(card.id);
    if (!accountId) { nameEl.textContent = "не привязан"; return; }
    const acc = (cachedAccounts || []).find(a => a.id === accountId);
    nameEl.textContent = acc ? (acc.name || accountId.slice(0, 8)) : accountId.slice(0, 8);
  }
  refreshName();
  _bcastIntervals[card.id] = setInterval(refreshName, 2000);

  canvasPositions[card.id] = { x: card.x, y: card.y };
  if (window._clawDrawWeb) window._clawDrawWeb();
}

function renderBroadcastCardsOnCanvas() {
  try {
    const raw = localStorage.getItem("claw_broadcast_cards");
    if (raw) broadcastCards = JSON.parse(raw);
  } catch {}
  const container = document.getElementById("accountsList");
  if (container) container.querySelectorAll(".sqBroadcastGroup").forEach(el => el.remove());
  Object.keys(_bcastIntervals).forEach(id => { clearInterval(_bcastIntervals[id]); delete _bcastIntervals[id]; });
  broadcastCards.filter(c => (c.platform || "Mamba") === activePlatform).forEach(card => renderBroadcastCard(card));
}



function renderAICardsOnCanvas() {
  const container = document.getElementById("accountsList");
  if (!container) return;

  container.querySelectorAll(".sqAIGroup").forEach(el => el.remove());

  analyticsCards.filter(card => (card.platform || "Mamba") === activePlatform).forEach(card => {
    const group = document.createElement("div");
    group.className = "sqAIGroup";
    group.dataset.cardId = card.cardId;
    group.dataset.accountId = "ai_" + card.cardId;
    group.style.position = "absolute";
    group.style.cursor = "grab";

    const dot = document.createElement("div");
    dot.className = "sqConnectDot";
    dot.title = "Потяни чтобы соединить";
    dot.style.cssText = "position:absolute;top:50%;right:-10px;transform:translateY(-50%);width:16px;height:16px;border-radius:50%;background:var(--accent3);border:2px solid var(--bg);cursor:crosshair;z-index:10;box-shadow:0 0 8px rgba(16,245,168,0.6);";
    group.appendChild(dot);

    const aCard = document.createElement("div");
    aCard.className = "sqAnalyticsCard";
    aCard.style.cssText = "min-width:160px;cursor:grab;position:relative;";
    aCard.innerHTML = `
      <button class="sqAIDeleteBtn" data-card-id="${card.cardId}" style="position:absolute;top:6px;right:6px;background:none;border:none;color:#fb7185;cursor:pointer;font-size:14px;line-height:1;opacity:0.6;">✕</button>
      <button class="sqAIEditBtn" data-card-id="${card.cardId}" style="position:absolute;top:6px;right:26px;background:none;border:none;color:#a5b4fc;cursor:pointer;font-size:12px;line-height:1;opacity:0.6;">✎</button>
      <div class="sqACardHead">AI</div>
      <div class="sqACardName">${card.botName ? `${card.botName}, ${card.botAge}` : "Аналитик"}</div>
      <div class="sqACardRow"><span class="sqALabel">Контакт</span><span class="sqAVal">${card.contacts || "—"}</span></div>
    `;

    aCard.querySelector(".sqAIDeleteBtn").onclick = async (e) => {
      e.stopPropagation();
      group.remove();
      analyticsCards = analyticsCards.filter(c => c.cardId !== card.cardId);
      // Чистим нитки связанные с этой AI-карточкой
      const aiNodeId = "ai_" + card.cardId;
      if (window._clawRemoveConnections) window._clawRemoveConnections(aiNodeId);
      try {
        await fetch(WORKER_API + `/api/analytics-cards/${encodeURIComponent(card.cardId)}`, { method: "DELETE" });
      } catch {}
    };

    aCard.querySelector(".sqAIEditBtn").onclick = (e) => {
      e.stopPropagation();
      const saveBtn = document.getElementById("aModalSaveBtn");
      document.getElementById("aModalBotName").value         = card.botName || "";
      document.getElementById("aModalBotAge").value          = card.botAge || "";
      document.getElementById("aModalBotGender").value       = card.botGender || "female";
      document.getElementById("aModalLocation").value        = card.location || "";
      document.getElementById("aModalContacts").value        = card.contacts || "";
      saveBtn.dataset.editCardId    = card.cardId;
      saveBtn.dataset.editAccountId = card.accountId || "";
      document.getElementById("analyticsModal").classList.add("open");
    };

    group.appendChild(aCard);


    const saved = canvasPositions[`ai_${card.cardId}`];
    if (saved) {
      group.style.left = saved.x + "px";
      group.style.top = saved.y + "px";
    } else {
      const x = (window._ctxSpawnX != null) ? window._ctxSpawnX : 700 + Math.random() * 200;
      const y = (window._ctxSpawnY != null) ? window._ctxSpawnY : 100 + Math.random() * 200;
      window._ctxSpawnX = null;
      window._ctxSpawnY = null;
      group.style.left = x + "px";
      group.style.top = y + "px";
      canvasPositions[`ai_${card.cardId}`] = { x, y };
      saveCanvasPositions();
    }

    container.appendChild(group);
  });
}

// ── Навигация ─────────────────────────────────────────────

function openPage(pageName) {
  if (!pageInfo[pageName]) pageName = "home";
  navButtons.forEach(btn => btn.classList.toggle("active", btn.dataset.page === pageName));
  pages.forEach(p => {
    p.classList.remove("activePage");
    p.style.display = "none";
  });
  const activePage = document.getElementById(`${pageName}Page`);
  if (activePage) {
    activePage.classList.add("activePage");
    activePage.style.display = (pageName === "tables" || pageName === "home") ? "flex" : "block";
    const appEl = document.querySelector(".app");
    if (pageName === "tables") {
      if (appEl) {
        appEl.style.overflow = "visible";
        appEl.style.position = "static";
        appEl.style.zIndex = "0";
      }
      document.body.appendChild(activePage);
    } else {
      if (appEl) {
        appEl.style.overflow = "";
        appEl.style.position = "";
        appEl.style.zIndex = "";
      }
    }
  }
  try { localStorage.setItem(STORAGE_KEY, pageName); } catch {}
  if (pageName === "tasks") {
    initChatPage();
  }
  if (pageName === "tables") {
    if (!window._sheetInited) {
      window._sheetInited = true;
      initSheetApp(document.getElementById("sheetApp"));
    }
    setTimeout(() => {
      const c = document.querySelector("#sh_gridScroll canvas");
      if (c) c.focus();
    }, 100);
  }
  if (pageName === "analytics") {
    tlrLoad();
  }
  if (pageName === "settings") {
    setTimeout(() => { loadProxySettings(); loadPlatformPrompts(); }, 150);
  }
  if (pageName === "contacts") {
    loadContacts();
  }
  if (pageName === "cabinet") {
    cbLoad();
  }
  if (pageName === "training") {
    tvLoad();
  }
  if (pageName === "mails") {
    loadMails();
    try { resSwitch(localStorage.getItem("claw_res_tab") || "mine"); } catch { resSwitch("mine"); }
  }
  if (pageName === "team") {
    loadTeam();
    loadTeamEff();
  }
  if (pageName === "myTasks") {
    loadMyTasks();
  }
  if (pageName === "schedule") {
    loadSchedule();
  }
  if (pageName === "plan") {
    initPlanPage();
  }
}

navButtons.forEach(btn => btn.addEventListener("click", () => {
  openPage(btn.dataset.page);
  if (btn.dataset.page === "settings") {
    setTimeout(() => { loadProxySettings(); loadPlatformPrompts(); }, 150);
  }
}));

// ── Форма подключения ─────────────────────────────────────

// ── Twinby: отправка кода ─────────────────────────────────
connectSlots.addEventListener("click", async (e) => {
  const btn = e.target.closest(".slotTwinbySendCode");
  if (!btn) return;
  const slot = btn.closest(".connectSlot");
  const email = slot.querySelector(".slotTwinbyEmail").value.trim();
  if (!email) { alert("Введи email"); return; }
  btn.disabled = true;
  btn.textContent = "Отправляю...";
  try {
    const resp = await fetch(WORKER_API + "/api/twinby/send-code", {
       method: "POST",
       headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
       body: JSON.stringify({ email }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "Ошибка");
    btn.textContent = "Код отправлен ✓";
  } catch(err) {
    btn.textContent = "Ошибка — попробуй ещё";
    btn.disabled = false;
    alert(err.message);
  }
});

// ── Vznakomstve: отправка кода ────────────────────────────
connectSlots.addEventListener("click", async (e) => {
  const btn = e.target.closest(".slotVznSendCode");
  if (!btn) return;
  const slot = btn.closest(".connectSlot");
  const email = slot.querySelector(".slotVznEmail").value.trim();
  if (!email) { alert("Введи email"); return; }
  btn.disabled = true;
  btn.textContent = "Отправляю...";
  try {
    const resp = await fetch(WORKER_API + "/api/vznakomstve/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
      body: JSON.stringify({ email }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || "Ошибка");
    btn.textContent = "Код отправлен ✓";
    slot.querySelector(".slotVznCodeRow").style.display = "";
  } catch(err) {
    btn.textContent = "Ошибка — попробуй ещё";
    btn.disabled = false;
    alert(err.message);
  }
});

// ── Operator (Telegram): отправка кода ────────────────────
connectSlots.addEventListener("click", async (e) => {
  const btn = e.target.closest(".slotOperatorSendCode");
  if (!btn) return;
  const slot = btn.closest(".connectSlot");
  const phone = slot.querySelector(".slotOperatorPhone").value.trim();
  if (!phone) { alert("Введи номер телефона"); return; }
  btn.disabled = true;
  btn.textContent = "Отправляю...";
  try {
    const resp = await fetch(WORKER_API + "/api/operator/send-code", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
      body: JSON.stringify({ phone }),
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(data.error || data.detail || "Ошибка");
    btn.textContent = "Код отправлен ✓";
    slot.querySelector(".slotOperatorCodeRow").style.display = "";
  } catch (err) {
    btn.textContent = "Ошибка — попробуй ещё";
    btn.disabled = false;
    alert(err.message);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const slotEls = [...connectSlots.querySelectorAll(".connectSlot")];

  const jobs = slotEls.map(slotEl => {
    const isTwinby   = activePlatform === "Twinby";
    const isVzn      = activePlatform === "Vznakomstve";
    const isIntCity  = activePlatform === "intCity";
    const isOperator = activePlatform === "Operator";
    const isAtolin   = activePlatform === "Atolin";
const isBadanga  = activePlatform === "Badanga" || activePlatform === "Pure" || activePlatform === "Soderzhanka" || activePlatform === "LovePlanet";
    // Badanga, Pure и LovePlanet авторизуются логином и паролем — отдаём их одной строкой,
    // клиент на бэке разберёт и сам сходит за токеном
    const bdLogin = isBadanga ? (slotEl.querySelector(".slotBadangaLogin")?.value.trim() || "") : "";
    const bdPass  = isBadanga ? (slotEl.querySelector(".slotBadangaPassword")?.value || "") : "";
    return {
      slotEl,
      name:        slotEl.querySelector(".slotAccountName").value.trim(),
      proxyRaw:    slotEl.querySelector(".slotProxy")?.value.trim() || "",
      proxyScheme: slotEl.querySelector(".slotProxyScheme")?.value || "socks5",
      url:         (isTwinby || isVzn || isIntCity || isOperator || isAtolin || isBadanga) ? "" : slotEl.querySelector(".slotCheckUrl").value.trim(),
      rawCookies:  (isTwinby || isVzn || isOperator) ? ""
                   : isBadanga ? JSON.stringify({ username: bdLogin, password: bdPass })
                   : isIntCity ? (slotEl.querySelector(".slotIntCityCookiesJson")?.value.trim() || "")
                   : isAtolin  ? (slotEl.querySelector(".slotAtolinCookiesJson")?.value.trim() || "")
                   : (slotEl.querySelector(".slotCookiesJson")?.value.trim() || ""),
      twinbyEmail: isTwinby ? slotEl.querySelector(".slotTwinbyEmail").value.trim() : "",
      twinbyCode:  isTwinby ? slotEl.querySelector(".slotTwinbyCode").value.trim() : "",
      vznEmail:        isVzn ? slotEl.querySelector(".slotVznEmail").value.trim() : "",
      vznCode:         isVzn ? slotEl.querySelector(".slotVznCode").value.trim() : "",
      intCityEmail:    "",
      intCityPassword: "",
      operatorPhone:    isOperator ? slotEl.querySelector(".slotOperatorPhone").value.trim() : "",
      operatorCode:     isOperator ? slotEl.querySelector(".slotOperatorCode").value.trim() : "",
      operatorPassword: isOperator ? slotEl.querySelector(".slotOperatorPassword").value.trim() : "",
      atolinRole:        isAtolin ? slotEl.querySelector(".slotAtolinRole").value : "",
      atolinProxy:       isAtolin ? slotEl.querySelector(".slotAtolinProxy").value.trim() : "",
      atolinProxyScheme: isAtolin ? slotEl.querySelector(".slotAtolinProxyScheme").value : "",
      isTwinby,
      isBadanga,
      bdLogin,
      bdPass,
      isIntCity,
      isVzn,
      isOperator,
      isAtolin,
    };
  }).filter(j => j.name || j.url || j.rawCookies || j.twinbyEmail || j.vznEmail || j.isIntCity || j.operatorPhone || j.isAtolin);

  if (!jobs.length) { setResult("Заполни хотя бы одну анкету.", "bad"); return; }

  for (const j of jobs) {
    if (j.isTwinby) {
      if (!j.twinbyEmail) { setResult(`Анкета "${j.name || "без имени"}": введи email.`, "bad"); return; }
      if (!j.twinbyCode)  { setResult(`Анкета "${j.name || "без имени"}": введи код из письма.`, "bad"); return; }
    } else if (j.isVzn) {
      if (!j.vznEmail) { setResult(`Анкета "${j.name || "без имени"}": введи email.`, "bad"); return; }
      if (!j.vznCode)  { setResult(`Анкета "${j.name || "без имени"}": введи код из письма.`, "bad"); return; }
    } else if (j.isIntCity) {
      if (!j.rawCookies) { setResult(`Анкета "${j.name || "без имени"}": вставь Cookie Editor JSON.`, "bad"); return; }
    } else if (j.isAtolin) {
      if (!j.rawCookies) { setResult(`Анкета "${j.name || "без имени"}": вставь Cookie-Editor JSON от atolin.ru.`, "bad"); return; }
      if (!j.atolinProxy) { setResult(`Анкета "${j.name || "без имени"}": укажи прокси — без него Atolin работать не будет.`, "bad"); return; }
      if (j.atolinProxy.split(":").length < 2) { setResult(`Анкета "${j.name || "без имени"}": прокси в формате host:port:логин:пароль.`, "bad"); return; }
    } else if (j.isOperator) {
      if (!j.operatorPhone) { setResult(`Оператор "${j.name || "без имени"}": введи номер телефона.`, "bad"); return; }
      if (!j.operatorCode)  { setResult(`Оператор "${j.name || "без имени"}": введи код (сначала жми "Получить код").`, "bad"); return; }
    } else if (j.isBadanga) {
      if (!j.bdLogin) { setResult(`Анкета "${j.name || "без имени"}": введи логин (email).`, "bad"); return; }
      if (!j.bdPass)  { setResult(`Анкета "${j.name || "без имени"}": введи пароль.`, "bad"); return; }
    } else {
      if (!j.url.startsWith("http")) { setResult(`Анкета "${j.name || "без имени"}": URL должен начинаться с http.`, "bad"); return; }
      if (!j.rawCookies) { setResult(`Анкета "${j.name || "без имени"}": вставь Cookie-Editor JSON.`, "bad"); return; }
    }
  }

  connectBtn.disabled    = true;
  connectBtn.textContent = "Подключаю...";

  let succeeded = 0;
  let failed    = 0;

  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    setResult(`Подключаю ${i + 1}/${jobs.length}: ${j.name || j.url}...`);

    try {
      const endpoint = j.isOperator ? "/api/operator/login/verify" : "/api/connect";
      const body = j.isOperator
        ? {
            account_name: j.name,
            phone:        j.operatorPhone,
            code:         j.operatorCode,
            password:     j.operatorPassword,
          }
        : {
            account_name: j.name,
            profile_url:  j.url || (j.isAtolin ? "https://atolin.ru" : "https://vznakomstve.com/app/"),
            cookies_raw:  j.rawCookies,
            platform:     activePlatform,
            twinby_email: j.twinbyEmail,
            twinby_code:  j.twinbyCode,
            vzn_email:         j.vznEmail,
            vzn_code:          j.vznCode,
            intcity_email:     j.intCityEmail,
            intcity_password:  j.intCityPassword,
            atolin_role:         j.atolinRole,
            atolin_proxy:        j.atolinProxy,
            atolin_proxy_scheme: j.atolinProxyScheme,
            proxy:               j.proxyRaw,
            proxy_scheme:        j.proxyScheme,
            user_agent:          navigator.userAgent,
          };

      const response = await fetch(WORKER_API + endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": localStorage.getItem("claw_auth_token") || "",
        },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (data.need_password) throw new Error("Нужен пароль (2FA) — заполни поле «Пароль» и жми ещё раз.");
      if (!response.ok || !data.ok) throw new Error(data.detail || data.error || "Ошибка подключения");

      succeeded++;
      j.slotEl.style.opacity = "0.4";
    } catch (error) {
      failed++;
      j.slotEl.style.borderColor = "rgba(255,60,60,.6)";
      const errLabel = document.createElement("div");
      errLabel.className = "result bad";
      errLabel.style.marginTop = "8px";
      errLabel.textContent = error.message || "Ошибка подключения.";
      j.slotEl.appendChild(errLabel);
    }
  }

  await loadAccounts();

  setResult(
    failed
      ? `Готово: ${succeeded} подключено, ${failed} с ошибкой (см. под полями).`
      : `Готово: все ${succeeded} анкеты подключены.`,
    failed ? "bad" : "good"
  );

  // Прячем панель подключения после успешного подключения
  if (!failed) {
    setTimeout(() => {
      const form = document.getElementById("connectForm");
      if (form) form.style.display = "none";
    }, 2000);
  }

  // оставляем неудачные слоты на экране, удачные — очищаем форму
  if (!failed) {
    connectSlots.innerHTML = "";
    addConnectSlot();
    loadKeySlots();
  }

  connectBtn.disabled    = false;
  connectBtn.textContent = "Подключить и достать фото";
});


// ── AI Аналитики ──────────────────────────────────────────

const addAnalyticsBtn = document.getElementById("addAnalyticsBtn");
const analyticsGrid   = document.getElementById("analyticsGrid");
const analyticsEmpty  = document.getElementById("analyticsEmpty");
const analyticsCardTpl = document.getElementById("analyticsCardTemplate");

let analyticsCards = [];

async function loadAnalyticsCards() {
  try {
    const res = await fetch(WORKER_API + "/api/analytics-cards");

    if (!res.ok) {
      throw new Error(`Ошибка загрузки аналитиков: HTTP ${res.status}`);
    }

    const data = await res.json();

    analyticsCards = (data.cards || []).map(c => ({
      cardId:          c.id,
      accountId:       c.account_id,
      platform:        c.platform || "Mamba",
      botName:         c.bot_name || "",
      botAge:          c.bot_age || "",
      botGender:       c.bot_gender || "female",
      location:        c.location || "",
      persona:         c.persona || "",
      goal:            c.goal || "",
      stopTopics:      c.stop_topics || "",
      contacts:        c.contacts || "",
      contactsTrigger: c.contacts_trigger || "",
    }));

    try {
      localStorage.setItem(ANALYTICS_CACHE_KEY, JSON.stringify(analyticsCards));
    } catch {}
  } catch (err) {
    console.error("loadAnalyticsCards error:", err);

    // Важно: analyticsCards здесь не очищаем.
    // При временной ошибке остаются предыдущие карточки.
  }

  return analyticsCards;
}

function renderAnalyticsGrid(accounts) {
  if (!analyticsGrid) return;
  analyticsGrid.querySelectorAll(".analyticsCard").forEach(el => el.remove());

  if (!analyticsCards.length) {
    if (analyticsEmpty) analyticsEmpty.style.display = "flex";
    return;
  }
  if (analyticsEmpty) analyticsEmpty.style.display = "none";

  analyticsCards.forEach((card, idx) => {
    const account = accounts.find(a => a.id === card.accountId);
    const node = analyticsCardTpl.content.cloneNode(true);
    node.querySelector(".analyticsCardName").textContent    = card.botName ? `${card.botName}, ${card.botAge}` : "Аналитик";
    node.querySelector(".analyticsCardAccount").textContent = account ? account.name : "—";
    node.querySelector(".analyticsContact").textContent     = card.contacts || "—";
    node.querySelector(".analyticsPersona").textContent     = card.persona || "—";
    node.querySelector(".analyticsGoal").textContent        = card.goal || "—";

    const deleteBtn = node.querySelector(".analyticsCardDelete");
    deleteBtn.dataset.cardId = card.cardId;
    deleteBtn.onclick = async (e) => {
      e.stopPropagation();
      const cardId = deleteBtn.dataset.cardId;
      if (deleteBtn._deleting) return;
      deleteBtn._deleting = true;
      try {
        if (cardId) {
          await fetch(WORKER_API + `/api/analytics-cards/${encodeURIComponent(cardId)}`, { method: "DELETE" });
        }
      } catch (err) {
        console.error("delete analytics card error:", err);
      }
      await loadAnalyticsCards();
      const accounts = await loadAccounts();
      renderAnalyticsGrid(accounts);
      deleteBtn._deleting = false;
    };

    node.querySelector(".analyticsEditBtn").onclick = () => openAnalyticsModal(card.accountId, accounts, card.cardId);

    analyticsGrid.appendChild(node);
  });
}

async function openAnalyticsModal(accountId, accounts, cardId) {
  const saveBtn = document.getElementById("aModalSaveBtn");
  saveBtn.dataset.editCardId = cardId || "";

  // Если accountId не передан — берём первый аккаунт активной платформы
  let resolvedAccountId = accountId;
  if (!resolvedAccountId && cachedAccounts.length) {
    const platformAcc = cachedAccounts.find(a =>
      (a.platform || "").toLowerCase() === (activePlatform || "").toLowerCase()
    );
    if (platformAcc) resolvedAccountId = platformAcc.id;
  }

  saveBtn.dataset.editAccountId = resolvedAccountId || "";

  // Грузим данные из ai_settings если есть accountId
  let settings = {};
  if (resolvedAccountId) {
    try {
      const res = await fetch(`/api/ai-settings/${encodeURIComponent(resolvedAccountId)}`);
      const data = await res.json();
      if (data.ok) settings = data.settings || {};
    } catch(e) {}
  }

  // Фоллбэк на analyticsCards если ai_settings пустые
  const card = accountId ? (analyticsCards.find(c => c.accountId === accountId) || {}) : {};

  document.getElementById("aModalBotName").value         = settings.bot_name         || card.botName || "";
  document.getElementById("aModalBotAge").value          = settings.bot_age           || card.botAge  || "";
  document.getElementById("aModalBotGender").value       = settings.bot_gender        || card.botGender || "female";
  document.getElementById("aModalLocation").value        = settings.location          || card.location || "";
  document.getElementById("aModalContacts").value        = settings.contacts          || card.contacts || "";

  document.getElementById("analyticsModal").classList.add("open");
}

addAnalyticsBtn?.addEventListener("click", async () => {
  await openAnalyticsModal(null, cachedAccounts);
});

document.getElementById("analyticsModalClose")?.addEventListener("click", (e) => {
  e.stopPropagation();
  document.getElementById("analyticsModal").classList.remove("open");
  const saveBtn = document.getElementById("aModalSaveBtn");
  delete saveBtn.dataset.editCardId;
  delete saveBtn.dataset.editAccountId;
});

// закрытие только через крестик или кнопку сохранить

document.getElementById("aModalSaveBtn")?.addEventListener("click", async () => {
  const saveBtn = document.getElementById("aModalSaveBtn");
  const targetAccountId = saveBtn.dataset.editAccountId || null;

  const botName         = document.getElementById("aModalBotName").value.trim();
  const botAge          = document.getElementById("aModalBotAge").value.trim();
  const botGender       = document.getElementById("aModalBotGender").value;
  const location        = document.getElementById("aModalLocation").value.trim();
  const contacts        = document.getElementById("aModalContacts").value.trim();
  const contactsTrigger = "";

  // targetAccountId может быть пустым — карточка создаётся без привязки к анкете
  // привязка происходит через нитку на канвасе
  try {
    const editCardId = saveBtn.dataset.editCardId || null;
    if (editCardId) {
      // Обновляем существующую карточку
      await fetch(WORKER_API + `/api/analytics-cards/${encodeURIComponent(editCardId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_name: botName, bot_age: botAge, bot_gender: botGender, location, contacts, contacts_trigger: contactsTrigger, platform: activePlatform }),
      });
    } else {
      // Создаём новую карточку без привязки к анкете
      const res = await fetch(WORKER_API + "/api/analytics-cards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          account_id: targetAccountId || null,
          bot_name: botName, bot_age: botAge, bot_gender: botGender,
          location, persona: "", goal: "", stop_topics: "",
          contacts, contacts_trigger: contactsTrigger, tg_chat_id: "",
          platform: activePlatform,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.detail || "Ошибка сохранения");
    }

    // Если есть привязанная анкета — синхронизируем в ai_settings
    if (targetAccountId) {
      await fetch(`/api/ai-settings/${encodeURIComponent(targetAccountId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bot_name: botName, bot_age: botAge, bot_gender: botGender, location, contacts, contacts_trigger: contactsTrigger }),
      });
    }
  } catch (err) {
    alert("Не удалось сохранить: " + err.message);
    return;
  }

  document.getElementById("analyticsModal").classList.remove("open");
  await loadAnalyticsCards();
  renderAICardsOnCanvas();
  delete saveBtn.dataset.editAccountId;
  delete saveBtn.dataset.editCardId;
});

// ── Модалки ───────────────────────────────────────────────


async function setAccountRunStatus(accountId, status, task = "", note = "", isBlocked = false) {
  try {
    const body = { run_status: status, run_task: task, run_note: note };
    if (isBlocked) body.is_blocked = true;
    const res = await fetch(WORKER_API + `/api/accounts/${encodeURIComponent(accountId)}/run-status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.warn("run-status не сохранился:", await res.text());
  } catch (err) {
    console.warn("setAccountRunStatus error:", err);
  }
}

async function runGroq(accountId, resultEl, cardEl) {
  if (resultEl) {
    resultEl.textContent = `Запускаю ${limit} лайков...`;
    resultEl.className = "sqResult";
  }

  cardEl?.classList.add("sqActive");
  const livePollId = startLiveActionPolling(accountId, cardEl);
  await setAccountRunStatus(accountId, "running", "likes", "Лайки запущены");

  try {
    const res = await fetchWithTimeout(WORKER_API + "/api/tasks/likes-http", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: accountId, limit }),
    });

    const queued = await res.json();

    if (!res.ok || !queued.ok) {
      throw new Error(queued.detail || queued.error || "Ошибка постановки в очередь");
    }

    const job = await pollJob(queued.job_id);
    if (job.status === "error") {
      throw new Error(job.result?.error || "Ошибка выполнения задачи");
    }

    const data = job.result || {};
    const isCritical = ["vip_limit", "session_error"].includes(data.status);

    if (resultEl) {
      resultEl.textContent = data.summary || "Готово.";
      resultEl.className = isCritical ? "sqResult bad" : "sqResult good";
    }

    loadAccounts();
    loadTasksLog();
  } catch (err) {
    if (resultEl) {
      resultEl.textContent = err.message || "Ошибка.";
      resultEl.className = "sqResult bad";
    }
  } finally {
    clearInterval(livePollId);
    await setAccountRunStatus(accountId, "idle", "", "");
    cardEl?.classList.remove("sqActive");
    loadAccounts();
  }
}

async function pollJob(jobId, { intervalMs = 2000, timeoutMs = 600000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetchWithTimeout(WORKER_API + `/api/jobs/${encodeURIComponent(jobId)}`);
      const data = await res.json();
      if (!res.ok || !data.ok) {
        await new Promise(r => setTimeout(r, intervalMs));
        continue;
      }
      const job = data.job;
      if (["done", "cancelled", "error"].includes(job.status)) {
        return job;
      }
    } catch (e) {
      // сетевая ошибка — продолжаем ждать
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error("Превышено время ожидания задачи");
}

async function runGroq(accountId, resultEl, cardEl) {
  if (resultEl) {
    resultEl.textContent = "Запускаю автоответы...";
    resultEl.className = "sqResult";
  }

  cardEl?.classList.add("sqActive");
  await setAccountRunStatus(accountId, "running", "groq", "Groq запущен");

  try {
    const res = await fetchWithTimeout(WORKER_API + "/api/tasks/auto-reply-http", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: accountId }),
    });

    const data = await res.json();

    if (!res.ok || !data.ok) {
      throw new Error(data.detail || data.error || "Ошибка");
    }

    const isCritical = ["groq_keys_exhausted", "session_error"].includes(data.status);

    if (resultEl) {
      resultEl.textContent = data.summary || "Готово.";
      resultEl.className = isCritical ? "sqResult bad" : "sqResult good";
    }

    loadAccounts();
    loadTasksLog();
  } catch (err) {
    if (resultEl) {
      resultEl.textContent = err.message || "Ошибка.";
      resultEl.className = "sqResult bad";
    }
  } finally {
    await setAccountRunStatus(accountId, "idle", "", "");
    cardEl?.classList.remove("sqActive");
    loadAccounts();
  }
}

async function toggleSplit(accountId, splitBtn, splitInput, likesBtn, groqBtn, likesInput, limit, resultEl, cardEl, platform) {
  if (runningSplits.has(accountId)) {
    runningSplits.delete(accountId);

    if (resultEl) {
      resultEl.textContent = "Останавливаю немедленно...";
      resultEl.className = "sqResult";
    }

    try {
      await fetch(WORKER_API + "/api/tasks/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ account_id: accountId }),
      });
      // Гасим и серверный таймер, иначе schedule_loop поставит
      // новую задачу через несколько секунд.
      await fetch(`/api/accounts/${accountId}/schedule`, {
        method: "DELETE",
        headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" },
      });
    } catch (err) {
      console.error("stop error:", err);
    }

    await setAccountRunStatus(accountId, "idle", "", "");

    splitBtn.classList.remove("running");
    splitBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg> Сплит';

    likesBtn.disabled = false;
    groqBtn.disabled = false;
    splitBtn.disabled = false;
    splitInput.disabled = false;
    likesInput.disabled = false;
    cardEl?.classList.remove("sqActive");

    if (resultEl) {
      resultEl.textContent = "Сплит остановлен.";
      resultEl.className = "sqResult";
    }

    loadAccounts();
    return;
  }

  runningSplits.add(accountId);
  if (window._clawStartAnim) window._clawStartAnim();
  window._splitLogs[accountId] = [];
  pushLog(accountId, "Сплит запущен");
  // Инициализируем живой счётчик из текущей статистики
  liveStats[accountId] = {
    liked:    parseInt(cardEl?.querySelector(".sqLikesVal")?.textContent) || 0,
    replied:  parseInt(cardEl?.querySelector(".sqMsgsVal")?.textContent)  || 0,
    contacts: parseInt(cardEl?.querySelector(".sqContactsVal")?.textContent) || 0,
  };
  await setAccountRunStatus(accountId, "running", "split", "Сплит запущен");

  splitBtn.classList.add("running");
  splitBtn.innerHTML = "⏹ Стоп";

  likesBtn.disabled = true;
  groqBtn.disabled = true;
  splitBtn.disabled = false;
  splitInput.disabled = true;
  likesInput.disabled = true;
  cardEl?.classList.add("sqActive");

  const livePollId = startLiveActionPolling(accountId, cardEl);
  runSplitLoop(accountId, limit, resultEl, cardEl, livePollId, platform);
}

async function runOneLikesStep(accountId, limit, resultEl, round) {
  try {
    pushLog(accountId, `Круг ${round}: запрос лайков...`);
    const queueRes = await fetchWithTimeout(WORKER_API + "/api/tasks/likes-http", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: accountId, limit }),
    }, 30000);

    const queued = await queueRes.json().catch(() => ({}));
    if (!queueRes.ok || queued.ok === false) {
      throw new Error(queued.detail || queued.error || "Ошибка постановки в очередь");
    }

    const job = await pollJob(queued.job_id, { timeoutMs: 120000 });
    const likesData = job.result || {};
    if (job.status === "error" && !likesData.error) {
      likesData.error = "Ошибка выполнения задачи";
    }
    const status = likesData.status || "completed";

    // Моментально обновляем счётчик лайков на карточке
    if (likesData.liked > 0) {
      bumpLiveStat(accountId, "liked", likesData.liked);
    }
    pushLog(accountId, `Лайков поставлено: ${likesData.liked || 0}`);

    if (likesData.blocked || status === "profile_blocked") {
      pushLog(accountId, "БЛОК — запускаю резерв");
      await loadAccounts();
      return {
        blocked: true,
        reserve_account_id:
          likesData.reserve_account_id ||
          likesData.chain_result?.reserve_account_id ||
          null,
        summary: likesData.summary || "Анкета заблокирована",
      };
    }

    if (likesData.ok === false) {
      throw new Error(likesData.detail || likesData.error || likesData.summary || "Ошибка лайков");
    }

    if (status === "vip_limit" || status === "session_error") {
      if (resultEl) {
        resultEl.textContent = `Круг ${round}: ${likesData.summary || "Остановлено."}. Продолжаю...`;
        resultEl.className = "sqResult bad";
      }
    } else if (likesData.liked === 0 && (likesData.skipped > 0 || likesData.errors > 0)) {
      if (resultEl) {
        resultEl.textContent = `Круг ${round}: лимит лайков исчерпан, пропускаю лайки`;
        resultEl.className = "sqResult";
      }
    } else {
      if (resultEl) {
        resultEl.textContent = `Круг ${round}: ${likesData.summary || "лайки готовы"}`;
        resultEl.className = "sqResult good";
      }
    }

    loadTasksLog();
  } catch (err) {
    console.error("SPLIT LIKES ERROR:", err);
    pushLog(accountId, `Круг ${round}: ОШИБКА лайков — ${err.message}`);

    if (resultEl) {
      resultEl.textContent = `Круг ${round}: ошибка лайков — ${err.message}. Продолжаю...`;
      resultEl.className = "sqResult bad";
    }
  }

  return { blocked: false, reserve_account_id: null };
}

async function runOneChatsStep(accountId, resultEl, round, passLabel) {
  try {
    pushLog(accountId, `Круг ${round} (${passLabel}): обрабатываю чаты...`);
    const queueRes = await fetchWithTimeout(WORKER_API + "/api/tasks/auto-reply-http", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: accountId }),
    }, 30000);

    const queued = await queueRes.json().catch(() => ({}));
    if (!queueRes.ok || queued.ok === false) {
      throw new Error(queued.detail || queued.error || "Ошибка постановки в очередь");
    }

    const job = await pollJob(queued.job_id, { timeoutMs: 120000 });
    const groqData = job.result || {};
    if (job.status === "error" && !groqData.error) {
      groqData.error = "Ошибка выполнения задачи";
    }
    const groqStatus = groqData.status || "completed";

    // Моментально обновляем счётчики ответов и лидов на карточке
    if (groqData.replied > 0) {
      bumpLiveStat(accountId, "replied", groqData.replied);
    }
    pushLog(accountId, `Ответов отправлено: ${groqData.replied || 0}, контактов: ${groqData.contacts_sent || 0}`);
    if (groqData.contacts_sent > 0) {
      bumpLiveStat(accountId, "contacts", groqData.contacts_sent);
    }

    if (groqData.blocked || groqStatus === "profile_blocked") {
      pushLog(accountId, "БЛОК в чатах — запускаю резерв");
      await loadAccounts();
      renderSquareGridFromCache();
      return {
        blocked: true,
        reserve_account_id:
          groqData.reserve_account_id ||
          groqData.chain_result?.reserve_account_id ||
          null,
        summary: groqData.summary || "Анкета заблокирована",
      };
    }

    if (groqData.ok === false) {
      throw new Error(groqData.detail || groqData.error || groqData.summary || "Ошибка чатов");
    }

    if (groqStatus === "groq_keys_exhausted" || groqStatus === "session_error") {
      if (resultEl) {
        resultEl.textContent = `Круг ${round} (${passLabel}): ${groqData.summary || "Остановлено."}. Продолжаю...`;
        resultEl.className = "sqResult bad";
      }
    } else {
      if (resultEl) {
        resultEl.textContent = `Круг ${round} (${passLabel}): ${groqData.summary || "чаты обработаны"}`;
        resultEl.className = "sqResult good";
      }
    }

    loadTasksLog();
  } catch (err) {
    console.error("SPLIT GROQ ERROR:", err);
    pushLog(accountId, `Круг ${round} (${passLabel}): ОШИБКА чатов — ${err.message}`);

    if (resultEl) {
      resultEl.textContent = `Круг ${round} (${passLabel}): ошибка чатов — ${err.message}. Продолжаю...`;
      resultEl.className = "sqResult bad";
    }
  }

  return { blocked: false, reserve_account_id: null };
}

async function switchSplitToReserve(oldAccountId, blockResult, limit, resultEl, cardEl, livePollId) {
  const reserveId = blockResult?.reserve_account_id || null;

  runningSplits.delete(oldAccountId);

  if (livePollId) {
    clearInterval(livePollId);
  }

  try {
    await setAccountRunStatus(oldAccountId, "idle", "", "Анкета заблокирована", true);
  } catch (err) {
    console.warn("old blocked status error:", err);
  }

  cardEl?.classList.remove("sqActive");

  if (!reserveId) {
    if (resultEl) {
      resultEl.textContent = "БЛОК: анкета заблокирована, резерв не найден";
      resultEl.className = "sqResult bad";
    }

    await loadAccounts();
    return;
  }

  if (resultEl) {
    resultEl.textContent = `БЛОК: запускаю резерв ${reserveId.slice(0, 8)}...`;
    resultEl.className = "sqResult good";
  }

  runningSplits.add(reserveId);

  await setAccountRunStatus(
    reserveId,
    "running",
    "split",
    "Резерв запущен вместо заблокированной анкеты"
  );

  await loadAccounts();

  const newLivePollId = startLiveActionPolling(reserveId, null);
  runSplitLoop(reserveId, limit, resultEl, null, newLivePollId, null);
}

async function runSplitLoop(accountId, limit, resultEl, cardEl, livePollId, platform) {
  const MAX_ROUNDS = Infinity; // карточка крутится без остановки на всех платформах — стоп/рестарт только вручную или через ноду таймера

  // Heartbeat — если цикл завис, перезапускаем.
  // Каждому запуску выдаём номер поколения. Старый цикл, увидев что номер
  // сменился, выходит сам. Раньше тут было delete+add подряд — старый цикл
  // этого не замечал и работал ПАРАЛЛЕЛЬНО с новым: двойные лайки,
  // двойные сообщения и нагрузка, растущая с каждым срабатыванием.
  window._splitGen = window._splitGen || {};
  const myGen = (window._splitGen[accountId] || 0) + 1;
  window._splitGen[accountId] = myGen;
  const isMine = () => window._splitGen[accountId] === myGen && runningSplits.has(accountId);

  let lastHeartbeat = Date.now();
  const heartbeatInterval = setInterval(() => {
    if (!isMine()) {
      clearInterval(heartbeatInterval);
      return;
    }
    if (Date.now() - lastHeartbeat > 3 * 60 * 1000) {
      clearInterval(heartbeatInterval);
      runSplitLoop(accountId, limit, resultEl, cardEl, livePollId, platform);
    }
  }, 30000);

  while (isMine()) {
    let round = 1;
    lastHeartbeat = Date.now();

    // ── Внутренний цикл: 5 кругов для Mamba, бесконечно для Lovelaz ──
    while (isMine() && round <= MAX_ROUNDS) {

      const doLikes = (round % 3 === 1); // лайки на 1-м круге из каждых трёх: 1, 4, 7, 10...

      if (doLikes) {
        // ── Шаг 1: лайки ──
        if (resultEl) {
          resultEl.textContent = `Круг ${round}: ставлю ${limit} лайков...`;
          resultEl.className = "sqResult";
        }
        pushLog(accountId, `Круг ${round}: ставлю ${limit} лайков...`);

        const likesResult = await runOneLikesStep(accountId, limit, resultEl, round);
        lastHeartbeat = Date.now();

        if (likesResult.blocked || likesResult.logged_out) {
          await switchSplitToReserve(accountId, likesResult, limit, resultEl, cardEl, livePollId);
          return;
        }

        if (!runningSplits.has(accountId)) break;
      } else {
        pushLog(accountId, `Круг ${round}: лайки пропускаю, только проверяю чаты...`);
        if (resultEl) {
          resultEl.textContent = `Круг ${round}: лайки пропущены, проверяю чаты...`;
          resultEl.className = "sqResult";
        }
      }

      // ── Шаг 2: первый проход по чатам ──
      await setAccountRunStatus(accountId, "running", "split", `Круг ${round}: чаты (1/2)`);

      if (resultEl) {
        resultEl.textContent = `Круг ${round}: проверяю чаты (1/2)...`;
        resultEl.className = "sqResult";
      }
      pushLog(accountId, `Круг ${round}: чаты (1/2)...`);

      const chatsResult1 = await runOneChatsStep(accountId, resultEl, round, "1/2");
      lastHeartbeat = Date.now();

      if (chatsResult1.blocked || chatsResult1.logged_out) {
        await switchSplitToReserve(accountId, chatsResult1, limit, resultEl, cardEl, livePollId);
        return;
      }

      if (!runningSplits.has(accountId)) break;

      // ── Шаг 3: второй проход по чатам ──
      await setAccountRunStatus(accountId, "running", "split", `Круг ${round}: чаты (2/2)`);

      if (resultEl) {
        resultEl.textContent = `Круг ${round}: проверяю чаты (2/2)...`;
        resultEl.className = "sqResult";
      }
      pushLog(accountId, `Круг ${round}: чаты (2/2)...`);

      const chatsResult2 = await runOneChatsStep(accountId, resultEl, round, "2/2");
      lastHeartbeat = Date.now();

      if (chatsResult2.blocked || chatsResult2.logged_out) {
        await switchSplitToReserve(accountId, chatsResult2, limit, resultEl, cardEl, livePollId);
        return;
      }

      if (!runningSplits.has(accountId)) break;

      // Сразу переходим к следующему кругу
      if (resultEl) {
        resultEl.textContent = `Круг ${round} завершён, запускаю следующий...`;
        resultEl.className = "sqResult";
      }
      pushLog(accountId, `Круг ${round} завершён, запускаю следующий...`);

      round++;
    } // конец внутреннего цикла (5 кругов)


  } // конец внешнего цикла

  if (livePollId) clearInterval(livePollId);
  runningSplits.delete(accountId);
  await setAccountRunStatus(accountId, "idle", "", "");
  cardEl?.classList.remove("sqActive");
  await loadAccounts();
}



// ── ЧАТЫ ──────────────────────────────────────────────────

let currentChatsAccountId = null;
let currentChatHref       = null;

function showChatsView(viewName) {
  document.getElementById("chatsAccountsView").style.display    = viewName === "accounts"     ? "block" : "none";
  document.getElementById("chatsDialogsView").style.display     = viewName === "dialogs"       ? "block" : "none";
  document.getElementById("chatsConversationView").style.display = viewName === "conversation" ? "block" : "none";
}

async function loadChatsAccountsList() {
  const container = document.getElementById("chatsAccountsList");
  if (!container) return;
  try {
    const res = await fetch(WORKER_API + "/api/accounts");
    const data = await res.json();
    const accounts = data.accounts || [];

    if (!accounts.length) {
      container.innerHTML = '<div class="empty"><div><b>Анкет пока нет</b><span>Подключи анкету на главной.</span></div></div>';
      return;
    }

    container.innerHTML = accounts.map(acc => `
      <div class="sqCard" style="cursor:default;">
        <div class="sqPhoto" data-account-id="${acc.id}" style="cursor:pointer;">
          ${acc.photo_url ? `<img class="sqImg" src="${acc.photo_url}" alt="" />` : `<div class="sqFallback">AI</div>`}
        </div>
        <div class="sqBody">
          <div class="sqName" data-account-id="${acc.id}" style="cursor:pointer;">${acc.name || "Анкета"}</div>
          <input class="tgChatIdInput" data-account-id="${acc.id}" placeholder="TG chat_id для скринов" value="" style="margin-top:8px;font-size:11px;padding:6px 10px;" />
          <button class="sqBtn tgSaveBtn" data-account-id="${acc.id}" style="margin-top:6px;width:100%;">Сохранить chat_id</button>
        </div>
      </div>
    `).join("");

    container.querySelectorAll("[data-account-id].sqPhoto, [data-account-id].sqName").forEach(el => {
      el.addEventListener("click", () => {
        const accId = el.dataset.accountId;
        const accName = accounts.find(a => a.id === accId)?.name || "Анкета";
        openChatsDialogsView(accId, accName);
      });
    });

    // Подгружаем текущий tg_chat_id для каждой анкеты
    accounts.forEach(async acc => {
      try {
        const r = await fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(acc.id)}`);
        const d = await r.json();
        const input = container.querySelector(`.tgChatIdInput[data-account-id="${acc.id}"]`);
        if (input && d.settings) input.value = d.settings.tg_chat_id || "";
      } catch {}
    });

    container.querySelectorAll(".tgSaveBtn").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const accId = btn.dataset.accountId;
        const input = container.querySelector(`.tgChatIdInput[data-account-id="${accId}"]`);
        const chatId = input.value.trim();

        btn.disabled = true;
        btn.textContent = "Сохраняю...";
        try {
          const settingsRes = await fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(accId)}`);
          const settingsData = await settingsRes.json();
          const current = settingsData.settings || {};

          await fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(accId)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...current, tg_chat_id: chatId }),
          });
          btn.textContent = "Сохранено ✓";
        } catch (err) {
          btn.textContent = "Ошибка";
        } finally {
          setTimeout(() => { btn.disabled = false; btn.textContent = "Сохранить chat_id"; }, 1500);
        }
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="result bad">Ошибка загрузки анкет: ${err.message}</div>`;
  }
}

async function openChatsDialogsView(accountId, accountName) {
  currentChatsAccountId = accountId;
  document.getElementById("chatsDialogsAccountName").textContent = accountName;
  showChatsView("dialogs");

  const container = document.getElementById("chatsDialogsList");
  container.innerHTML = '<div class="result">Загружаю диалоги...</div>';

  try {
    const res = await fetch(WORKER_API + `/api/chats/${encodeURIComponent(accountId)}`);
    const data = await res.json();
    const chats = data.chats || [];

    if (!chats.length) {
      container.innerHTML = '<div class="empty"><div><b>Диалогов пока нет</b><span>Запусти автоответы чтобы появились данные.</span></div></div>';
      return;
    }

    container.innerHTML = chats.map(chat => `
      <div class="result" data-href="${chat.href}" style="cursor:pointer;padding:12px 16px;">
        <div style="display:flex;justify-content:space-between;margin-bottom:4px;opacity:.6;font-size:11px;">
          <span>${chat.contact_name || chat.href}</span>
          <span>${formatDate(chat.updated_at)}</span>
        </div>
        <div style="font-size:13px;">${chat.last_role === "user" ? "← " : "→ "}${(chat.last_message || "").slice(0, 80)}</div>
      </div>
    `).join("");

    container.querySelectorAll("[data-href]").forEach(el => {
      el.addEventListener("click", () => {
        const chat = chats.find(c => c.href === el.dataset.href);
        openChatsConversationView(el.dataset.href, chat?.contact_name);
      });
    });
  } catch (err) {
    container.innerHTML = `<div class="result bad">Ошибка загрузки диалогов: ${err.message}</div>`;
  }
}

async function openChatsConversationView(href, contactName) {
  currentChatHref = href;
  document.getElementById("chatsConversationTitle").textContent = contactName || href;
  showChatsView("conversation");

  const container = document.getElementById("chatsMessagesList");
  container.innerHTML = '<div class="result">Загружаю переписку...</div>';
  document.getElementById("chatsSendResult").textContent = "";

  try {
    const res = await fetch(WORKER_API + `/api/chats/${encodeURIComponent(currentChatsAccountId)}/history?href=${encodeURIComponent(href)}`);
    const data = await res.json();
    const history = data.history || [];

    if (!history.length) {
      container.innerHTML = '<div class="empty"><div><b>Сообщений нет</b></div></div>';
      return;
    }

    container.innerHTML = history.map(msg => `
      <div style="align-self:${msg.role === "user" ? "flex-start" : "flex-end"};max-width:75%;">
        <div class="result" style="background:${msg.role === "user" ? "rgba(255,255,255,.04)" : "rgba(92,110,248,.10)"};margin:0;">
          ${msg.content}
        </div>
      </div>
    `).join("");

    container.scrollTop = container.scrollHeight;
  } catch (err) {
    container.innerHTML = `<div class="result bad">Ошибка загрузки переписки: ${err.message}</div>`;
  }
}


document.getElementById("chatsSendBtn")?.addEventListener("click", async () => {
  const input = document.getElementById("chatsSendInput");
  const message = input.value.trim();
  const resultBox = document.getElementById("chatsSendResult");
  if (!message) return;

  const btn = document.getElementById("chatsSendBtn");
  btn.disabled = true;
  btn.textContent = "Отправляю...";
  setBoxResult(resultBox, "Открываю браузер и отправляю...");

  try {
    const res = await fetchWithTimeout(WORKER_API + "/api/chats/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_id: currentChatsAccountId, href: currentChatHref, message }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || "Ошибка отправки");
    input.value = "";
    setBoxResult(resultBox, "Отправлено.", "good");
    await openChatsConversationView(currentChatHref);
  } catch (err) {
    setBoxResult(resultBox, err.message || "Ошибка отправки.", "bad");
  } finally {
    btn.disabled = false;
    btn.textContent = "Отправить";
  }
});


// ── Инициализация (запускается только после авторизации) ──

let appStarted = false;

async function loadNotifications() {
  try {
    const res = await fetch(WORKER_API + "/api/notifications");
    const data = await res.json();

    const notifications = data.notifications || [];

    const unread = notifications.filter(n => !n.is_read);

    if (notificationsCount) {
      notificationsCount.textContent = unread.length;

      notificationsCount.style.display =
        unread.length ? "block" : "none";
    }

    if (notificationsList) {

      notificationsList.innerHTML = notifications.length
        ? notifications.map(n => {

            const inviteId =
              n.data?.invite_id || "";


            return `
              <div class="result" style="margin-bottom:10px;">
                <b>${n.title}</b>

                <div style="margin-top:6px;">
                  ${n.message}
                </div>

                ${
                  n.type === "contact_assignment"
                  ? `<div style="margin-top:10px;"><button class="taskRunBtn openAssignmentBtn">Открыть МОИ TG</button></div>`
                  : n.type === "shift_schedule"
                  ? `<div style="margin-top:10px;"><button class="taskRunBtn openScheduleBtn">Открыть график</button></div>`
                  : ""
                }

                ${
                  n.type === "team_invite" && !n.is_read
                  ? `
                  <div style="margin-top:10px;display:flex;gap:8px;">
                    <button
                      class="taskRunBtn acceptInviteBtn"
                      data-id="${inviteId}"
                    >
                      Принять
                    </button>

                    <button
                      class="small danger rejectInviteBtn"
                      data-id="${inviteId}"
                    >
                      Отклонить
                    </button>
                  </div>
                  `
                  : ""
                }
              </div>
            `;
          }).join("")
        : `<div class="result">Уведомлений нет</div>`;

      bindInviteButtons();
    }

  } catch (err) {
    console.error(err);
  }
}

function bindInviteButtons() {

  document
    .querySelectorAll(".acceptInviteBtn")
    .forEach(btn => {

      btn.onclick = async () => {

        await fetch(
          "/api/team/invite/accept",
          {
            method: "POST",
            headers: {
              "Content-Type":"application/json"
            },
            body: JSON.stringify({
              invite_id: btn.dataset.id
            })
          }
        );

        await loadNotifications();
        await loadAccounts();
        document.getElementById("bellPanel")?.classList.remove("open");
        document.getElementById("notificationsModal")?.classList.remove("open");
        openPage("plan");
      };
    });

  document
    .querySelectorAll(".rejectInviteBtn")
    .forEach(btn => {

      btn.onclick = async () => {

        await fetch(
          "/api/team/invite/reject",
          {
            method: "POST",
            headers: {
              "Content-Type":"application/json"
            },
            body: JSON.stringify({
              invite_id: btn.dataset.id
            })
          }
        );

        await loadNotifications();
      };
    });
}

async function loadTeamMembers() {

  try {

    const res =
      await fetch(WORKER_API + "/api/team/members");

    const data =
      await res.json();

    const members =
      data.members || [];

    if (!teamMembersList) return;

    teamMembersList.innerHTML =
      members.length
      ? members.map(m => `
          <div class="result">
            ${m.member_email}
            (${m.role})
          </div>
        `).join("")
      : `<div class="result">Пока пусто</div>`;

  } catch (err) {
    console.error(err);
  }
}

let keySlots = [];

async function loadKeySlots() {
  try {
    const res = await fetch(WORKER_API + "/api/key-slots");
    const data = await res.json();
    keySlots = data.slots || [];
    renderKeySlots();
  } catch(e) { console.error("loadKeySlots error:", e); }
}

function renderKeySlots() {
  const list = document.getElementById("keySlotsBody");
  if (!list) return;
  list.innerHTML = "";
  if (!keySlots.length) {
    list.innerHTML = '<div style="color:var(--text2);font:400 12px Space Grotesk,sans-serif;padding:12px 0;text-align:center;">Нет слотов — нажми +</div>';
    return;
  }
  keySlots.forEach(slot => {
    const keyCount = (slot.keys || "").split("\n").filter(k => k.trim()).length;
    const isAssigned = !!slot.account_id;
    const boundAccount = isAssigned ? cachedAccounts.find(a => a.id === slot.account_id) : null;
    const boundName = boundAccount ? (boundAccount.name || boundAccount.id) : (isAssigned ? "неизвестная анкета" : "");

    const el = document.createElement("div");
    el.style.cssText = "border:1px solid var(--border);border-radius:12px;padding:13px;margin-bottom:10px;background:var(--card2);";
    el.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">' +
        '<span style="font:700 12.5px Inter,sans-serif;color:var(--white);">' + slot.name + '</span>' +
        '<div style="display:flex;gap:6px;align-items:center;">' +
          '<span style="font:600 10.5px Inter,sans-serif;color:' + (isAssigned ? "var(--green)" : "var(--text3)") + ';">' + (isAssigned ? "✓ привязан" : "свободен") + '</span>' +
          (isAssigned ? '<button class="slotReleaseBtn" data-id="' + slot.id + '" data-account="' + slot.account_id + '" style="background:none;border:none;color:var(--amber);cursor:pointer;font-size:13px;" title="Отвязать">⛓✕</button>' : '') +
          '<button class="slotEditBtn" data-id="' + slot.id + '" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:13px;">✎</button>' +
          '<button class="slotDeleteBtn" data-id="' + slot.id + '" style="background:none;border:none;color:var(--pink);cursor:pointer;font-size:13px;">✕</button>' +
        '</div>' +
      '</div>' +
      '<div style="font:400 11px Space Grotesk,sans-serif;color:var(--text2);display:flex;justify-content:space-between;">' +
        '<span>Ключей: <b style="color:var(--text);">' + keyCount + '</b></span>' +
        (isAssigned ? '<span title="' + slot.account_id + '">Анкета: <b style="color:var(--text);">' + boundName + '</b></span>' : '') +
      '</div>';

    el.querySelector(".slotEditBtn").onclick = () => openKeySlotModal(slot);
    el.querySelector(".slotDeleteBtn").onclick = async () => {
      await fetch(WORKER_API + "/api/key-slots/" + slot.id, { method: "DELETE" });
      loadKeySlots();
    };
    el.querySelector(".slotReleaseBtn")?.addEventListener("click", async () => {
      await fetch(WORKER_API + "/api/key-slots/release/" + encodeURIComponent(slot.account_id), { method: "POST" });
      slot.account_id = null;
      loadKeySlots();
    });
    list.appendChild(el);
  });
}

const KEY_STATUS_KEY = "claw_key_status";

async function loadKeyCooldowns() {
  try {
    const res = await fetch(WORKER_API + "/api/key-slots/cooldowns", {
      headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" },
    });
    const data = await res.json();
    window._keyCooldowns = data.cooldowns || {};
  } catch { window._keyCooldowns = window._keyCooldowns || {}; }
  renderKeyStatusList();
}

const KEY_STATUS_META = {
  ok:         { color: "#10f5a8", label: "рабочий" },
  rate_limit: { color: "#fbbf24", label: "лимит на сутки" },
  too_long:   { color: "#fb923c", label: "промпт не влезает" },
  no_credits: { color: "#fb7185", label: "нужен баланс" },
  blocked:    { color: "#fb7185", label: "забанен" },
  invalid:    { color: "#fb7185", label: "невалидный" },
  error:      { color: "#94a3b8", label: "ошибка — см. ниже" },
  no_response:{ color: "#64748b", label: "сервер не ответил" },
  unknown:    { color: "#5b6480", label: "не проверен" },
};

function loadKeyStatuses() {
  try { return JSON.parse(localStorage.getItem(KEY_STATUS_KEY) || "{}"); } catch { return {}; }
}

function saveKeyStatuses(map) {
  try { localStorage.setItem(KEY_STATUS_KEY, JSON.stringify(map)); } catch {}
}

function renderKeyStatusList() {
  const box = document.getElementById("keySlotStatusList");
  const ta = document.getElementById("keySlotKeys");
  if (!box || !ta) return;

  const statuses = loadKeyStatuses();
  const keys = ta.value.split("\n").map(k => k.trim()).filter(Boolean);
  if (!keys.length) { box.innerHTML = ""; return; }

  const counts = {};
  const rows = keys.map((k, i) => {
    const st = statuses[k] || "unknown";
    counts[st] = (counts[st] || 0) + 1;
    const m = KEY_STATUS_META[st] || KEY_STATUS_META.unknown;
    const cd = (window._keyCooldowns || {})[k.slice(-8)];
    const rawErr = (window._keyErrors || {})[k] || "";
    let errRow = "";
    if (rawErr && st !== "ok") {
      const safe = rawErr.replace(/[<>&]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[c]));
      const low = rawErr.toLowerCase();
      let hint = "";
      if (low.includes("data policy")) {
        hint = "→ включи бесплатные эндпоинты: openrouter.ai/settings/privacy";
      } else if (low.includes("no endpoints")) {
        hint = "→ модель уехала из бесплатных, поменяй OPENROUTER_MODEL_FALLBACKS";
      }
      errRow = `<div style="font:400 10px 'JetBrains Mono',monospace;color:#94a3b8;padding:0 0 6px 15px;white-space:normal;word-break:break-word;">${safe}${hint ? `<br><span style="color:#fbbf24;">${hint}</span>` : ""}</div>`;
    }
    let cdRow = "";
    if (cd) {
      const ch = Math.floor(cd.minutes_left / 60), cm = cd.minutes_left % 60;
      cdRow = `<div style="font:600 10px 'Space Grotesk',sans-serif;color:#fbbf24;padding:0 0 6px 15px;">⏳ лимит 50/сутки — вернётся через ${ch ? ch + "ч " : ""}${cm}м</div>`;
    }
    return `<div style="display:flex;align-items:center;gap:8px;padding:3px 0;font:400 11px 'JetBrains Mono',monospace;">
      <span style="width:7px;height:7px;border-radius:50%;background:${m.color};flex-shrink:0;box-shadow:0 0 6px ${m.color};"></span>
      <span style="color:${m.color};flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">#${i + 1} ${k.slice(0, 16)}…${k.slice(-6)}</span>
      <span style="color:${m.color};opacity:.85;flex-shrink:0;">${m.label}</span>
    </div>${cdRow}${errRow}`;
  }).join("");

  const summary = Object.keys(counts)
    .map(st => `<span style="color:${(KEY_STATUS_META[st] || KEY_STATUS_META.unknown).color};">${(KEY_STATUS_META[st] || KEY_STATUS_META.unknown).label}: ${counts[st]}</span>`)
    .join(" · ");

  box.innerHTML = `<div style="font:600 11px 'Space Grotesk',sans-serif;margin-bottom:8px;">${summary}</div>${rows}`;
}

async function checkSlotKeys() {
  const ta = document.getElementById("keySlotKeys");
  const btn = document.getElementById("keySlotCheckBtn");
  if (!ta || !btn) return;

  const keys = ta.value.split("\n").map(k => k.trim()).filter(Boolean);
  if (!keys.length) return;

  btn.disabled = true;
  const statuses = loadKeyStatuses();
  let done = 0;
  const CHUNK = 3;

  for (let i = 0; i < keys.length; i += CHUNK) {
    const part = keys.slice(i, i + CHUNK);
    btn.textContent = `Проверяю ${done}/${keys.length}...`;
    try {
      const res = await fetch(WORKER_API + "/api/key-slots/check", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": localStorage.getItem("claw_auth_token") || "",
        },
        body: JSON.stringify({ keys: part, account_id: document.getElementById("keySlotSaveBtn").dataset.accountId || "" }),
      });
      if (!res.ok) throw new Error("http " + res.status);
      const data = await res.json();
      Object.assign(statuses, data.results || {});
      window._keyErrors = Object.assign(window._keyErrors || {}, data.errors || {});
    } catch {
      // это уже наш бэкенд не ответил, а не ключ виноват
      part.forEach(k => { statuses[k] = "no_response"; });
    }
    done += part.length;
    saveKeyStatuses(statuses);
    renderKeyStatusList();
  }

  btn.disabled = false;
  btn.textContent = "🔍 Проверить ключи";
}

function removeDeadKeysFromSlot() {
  const ta = document.getElementById("keySlotKeys");
  if (!ta) return;
  const statuses = loadKeyStatuses();
  const keys = ta.value.split("\n").map(k => k.trim()).filter(Boolean);
  const alive = keys.filter(k => !["blocked", "invalid"].includes(statuses[k]));
  const removed = keys.length - alive.length;
  if (!removed) { alert("Забаненных ключей не найдено."); return; }
  ta.value = alive.join("\n");
  renderKeyStatusList();
  alert(`Убрано мёртвых ключей: ${removed}. Нажми «Сохранить».`);
}

async function openKeySlotModal(slot = null) {
  const form = document.getElementById("keySlotForm");
  if (!form) return;
  document.getElementById("keySlotName").value = slot ? slot.name : "";
  document.getElementById("keySlotKeys").value = slot ? slot.keys : "";
  document.getElementById("keySlotSaveBtn").dataset.slotId = slot ? slot.id : "";
  document.getElementById("keySlotSaveBtn").dataset.accountId = (slot && slot.account_id) ? slot.account_id : "";

  // Панель проверки — создаём один раз, дальше переиспользуем
  const ta = document.getElementById("keySlotKeys");
  if (ta && !document.getElementById("keySlotStatusList")) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "margin-top:10px;";
    wrap.innerHTML = `
      <div style="display:flex;gap:6px;margin-bottom:8px;">
        <button id="keySlotCheckBtn" type="button" style="flex:1;padding:10px;border-radius:9px;border:1px solid rgba(255,255,255,.16);background:#17171e;color:#f4f5f8;font:700 12px 'Inter',sans-serif;cursor:pointer;">🔍 Проверить ключи</button>
        <button id="keySlotCleanBtn" type="button" title="Убрать забаненные" style="padding:10px 13px;border-radius:9px;border:1px solid rgba(255,92,133,.35);background:rgba(255,92,133,.10);color:#ff5c85;font:700 12px 'Inter',sans-serif;cursor:pointer;">🧹</button>
      </div>
      <div id="keySlotStatusList" style="max-height:220px;overflow-y:auto;"></div>
    `;
    ta.insertAdjacentElement("afterend", wrap);
    document.getElementById("keySlotCheckBtn").onclick = checkSlotKeys;
    document.getElementById("keySlotCleanBtn").onclick = removeDeadKeysFromSlot;
    ta.addEventListener("input", renderKeyStatusList);
  }

  renderKeyStatusList();
  loadKeyCooldowns();
  form.classList.add("open");
}

async function autoAssignAllFreeSlots() {
  const freeSlots = keySlots.filter(s => !s.account_id);
  if (!freeSlots.length) return;

  const accRes = await fetch(WORKER_API + "/api/accounts");
  const accData = await accRes.json();
  const accounts = accData.accounts || [];

  for (const account of accounts) {
    const alreadyBound = keySlots.find(s => s.account_id === account.id);
    if (alreadyBound) continue;
    const settingsRes = await fetch(WORKER_API + "/api/ai-settings/" + encodeURIComponent(account.id));
    const settingsData = await settingsRes.json();
    const hasKeys = (settingsData.settings?.groq_api_keys || "").trim().length > 0;
    if (hasKeys) continue;

    const freeSlot = freeSlots.find(s => !s.account_id);
    if (!freeSlot) break;

    const keys = (freeSlot.keys || "").split("\n").filter(k => k.trim());
    if (!keys.length) continue;

    await fetch(WORKER_API + "/api/ai-settings/" + encodeURIComponent(account.id), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groq_api_keys: keys.join("\n"), groq_api_key: keys[0] }),
    });
    await fetch(WORKER_API + "/api/key-slots/" + freeSlot.id + "/assign?account_id=" + encodeURIComponent(account.id), {
      method: "POST",
    });
    freeSlot.account_id = account.id;
  }
  loadKeySlots();
}


function startApp() {
  if (appStarted) return;
  appStarted = true;
  initTeamNav();
  updateMyTgBadge();
  setInterval(updateMyTgBadge, 15000);

  document.getElementById("addKeySlotBtn").onclick = () => openKeySlotModal();
  document.getElementById("keySlotModalClose").onclick = () => {
    document.getElementById("keySlotForm").classList.remove("open");
    loadKeySlots();
  };
  document.getElementById("keySlotSaveBtn").onclick = async () => {
    const saveBtn = document.getElementById("keySlotSaveBtn");
    const slotId = saveBtn.dataset.slotId || null;
    const name = document.getElementById("keySlotName").value.trim() || "Слот";
    const keys = document.getElementById("keySlotKeys").value.trim();
    if (slotId) {
      await fetch(WORKER_API + "/api/key-slots/" + slotId, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, keys }),
      });
    } else {
      await fetch(WORKER_API + "/api/key-slots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, keys }),
      });
    }
    document.getElementById("keySlotForm").classList.remove("open");
    loadKeySlots();
    autoAssignAllFreeSlots();
  };

  const _toggleBtn = document.getElementById("keysPanelToggle");
  const _keysPanel = document.getElementById("keysPanel");
  if (_toggleBtn && _keysPanel) {
    _toggleBtn.onclick = () => {
      const isOpen = _keysPanel.classList.contains("open");
      _keysPanel.classList.toggle("open", !isOpen);
      if (!isOpen) loadKeySlots();
    };
  }

  // Сначала подгружаем сохранённые координаты карточек, иначе мгновенный
  // рендер из кэша ниже расставит карточки по спирали и тут же перезапишет
  // сохранённый layout в localStorage
  // Сначала раскладка с сервера, иначе канвас соберётся из пустого
  // localStorage и расставит всё заново по спирали, затерев сохранённое.
  uiStatePull().then(() => {
    loadCanvasPositions();

    // Мгновенно показываем то что было закэшировано с прошлой сессии
    loadCachedAccountsInstantly();

    loadOperatorTabs();
    initInfiniteCanvas();

    return Promise.all([
      loadAnalyticsCards(),
      loadAccounts(),
    ]);
  }).then(([, accounts]) => {
    renderAnalyticsGrid(accounts);
    renderAICardsOnCanvas();
    renderTimerCardsOnCanvas();
    renderProxyCardsOnCanvas();
    renderLogCardsOnCanvas();
    renderBroadcastCardsOnCanvas();

    // После отображения карточек проверяем анкеты через HTTP
    refreshAccountStatuses();
  });

  setInterval(async () => {
    await loadAnalyticsCards();
    const accounts = await loadAccounts();
    if (!document.querySelector('.analyticsCard._deleting')) {
      renderAnalyticsGrid(accounts);
    }
  }, 20000);

  const savedPage = (() => {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  })();

  const savedPlatform = localStorage.getItem("claw_active_platform");
  if (savedPlatform) {
    const btn = document.querySelector(`.platformBtn[data-platform="${savedPlatform}"]`);
    if (btn) btn.click();
  }

  openPage(savedPage || "home");


  loadNotifications();
  loadTeamMembers();

  setInterval(loadNotifications, 10000);
  setInterval(refreshAccountStatuses, 300000);
}



// ── ТАБЛИЦА (Google Sheets-style) ────────────────────────

function initSheetApp(container) {
  if (!container) return;

  const SK = "claw_sheets_v2";
  const COLS = 30, ROWS = 60;
  const DEF_COL_W = 130, DEF_ROW_H = 24;
  const HDR_W = 46, HDR_H = 24;

  function loadState() {
    try { return JSON.parse(localStorage.getItem(SK) || "null"); } catch { return null; }
  }
  function saveState() {
    try { localStorage.setItem(SK, JSON.stringify(state)); } catch {}
    // дебаунс: не шлём на сервер чаще раза в 800мс
    clearTimeout(saveState._t);
    saveState._t = setTimeout(() => _pushSheetToServer(), 800);
  }

  async function _pushSheetToServer() {
    for (const sheet of state.sheets) {
      const cells = [];
      for (const key of Object.keys(sheet.cells)) {
        const [r, c] = key.split(",").map(Number);
        const mapKey = sheet.id + ":" + key;
        const cellData = {
          row: r,
          col: c,
          value: sheet.cells[key],
        };
        const aid = assignedMap[mapKey];
        if (aid) cellData.assigned_account_id = aid;
        cells.push(cellData);
      }
      if (!cells.length) continue;
      try {
        await fetch("/api/sheet/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sheet_id: sheet.id, cells }),
        });
      } catch (e) {
        console.warn("[sheet] save error", e);
      }
    }
  }

  async function _loadSheetFromServer(sheetId) {
    try {
      const res = await fetch(`/api/sheet/load?sheet_id=${encodeURIComponent(sheetId)}`);
      const data = await res.json();
      if (!data.ok) return;
      const sheet = state.sheets.find(s => s.id === sheetId);
      if (!sheet) return;
      sheet.cells = {};
      for (const row of data.cells) {
        const key = row.row_idx + "," + row.col_idx;
        if (row.value !== undefined && row.value !== null) sheet.cells[key] = row.value;
        const mapKey = sheetId + ":" + key;
        if (row.assigned_account_id) {
          assignedMap[mapKey] = row.assigned_account_id;
        } else {
          delete assignedMap[mapKey];
        }
      }
    } catch (e) {
      console.warn("[sheet] load error", e);
    }
  }

  async function _loadBlockedAccounts() {
    try {
      const res = await fetch(WORKER_API + "/api/accounts");
      const data = await res.json();
      blockedSet = new Set(
        (data.accounts || [])
          .filter(a => a.is_blocked)
          .map(a => String(a.id))
      );
    } catch (e) {
      console.warn("[sheet] blocked load error", e);
    }
  }
  function newSheet(name) {
    const fixedId = "sheet_" + name.replace(/\s+/g, "_").toLowerCase();
    return { id: fixedId, name, cells: {}, colW: {}, rowH: {} };
  }

  let state = loadState() || { sheets: [newSheet("Лист 1")], active: 0 };
  // Загружаем данные с сервера при старте
  setTimeout(async () => {
    for (const sheet of state.sheets) {
      await _loadSheetFromServer(sheet.id);
    }
    render();
  }, 500);
  // assigned_account_id по ключу "sheetId:r,c" → для окраски ячеек
  let assignedMap = {};
  // id заблокированных анкет
  let blockedSet = new Set();
  if (state.active >= state.sheets.length) state.active = 0;

  function sh() { return state.sheets[state.active]; }
  function ck(r, c) { return r + "," + c; }
  function colLetter(c) {
    let s = ""; c++;
    while (c > 0) { s = String.fromCharCode(64 + (c % 26 || 26)) + s; c = Math.floor((c - 1) / 26); }
    return s;
  }
  function cellName(r, c) { return colLetter(c) + (r + 1); }
  function cw(c) { return sh().colW[c] || DEF_COL_W; }
  function rh(r) { return sh().rowH[r] || DEF_ROW_H; }

  // selection state
  let sel = { r: 0, c: 0, r2: 0, c2: 0 };
  let editing = false;
  let dragColIdx = null, dragColX0 = 0, dragColW0 = 0;
  let dragRowIdx = null, dragRowY0 = 0, dragRowH0 = 0;

  // ── DOM ───────────────────────────────────────────────
  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:6px;padding:5px 10px;background:#0a0d1a;border-bottom:1px solid rgba(100,120,255,0.15);flex-shrink:0;flex-wrap:wrap;">
      <span id="sh_cellname" style="font:500 12px 'JetBrains Mono',monospace;color:#818cf8;min-width:52px;text-align:center;background:rgba(255,255,255,0.04);border:1px solid rgba(100,120,255,0.18);border-radius:4px;padding:3px 6px;">A1</span>
      <div style="width:1px;height:18px;background:rgba(100,120,255,0.2);"></div>
      <input id="sh_formula" style="flex:1;min-width:180px;background:rgba(255,255,255,0.04);border:1px solid rgba(100,120,255,0.16);border-radius:4px;color:#e8ecff;font:400 12px 'JetBrains Mono',monospace;padding:3px 8px;outline:none;" placeholder="Значение..." />
      <div style="width:1px;height:18px;background:rgba(100,120,255,0.2);"></div>
      <button id="sh_addColBtn" style="${shBtn()}">+ Столбец</button>
      <button id="sh_addRowBtn" style="${shBtn()}">+ Строка</button>
      <button id="sh_clearBtn"  style="${shBtn()}">Очистить</button>
    </div>
    <div id="sh_gridScroll" style="flex:1;overflow:auto;position:relative;background:#050810;cursor:default;"></div>
    <div id="sh_sheetsBar" style="display:flex;align-items:center;background:#07091a;border-top:1px solid rgba(100,120,255,0.14);flex-shrink:0;min-height:32px;padding:0 6px;gap:2px;overflow-x:auto;"></div>
  `;

  function shBtn() {
    return "background:rgba(255,255,255,0.05);border:1px solid rgba(100,120,255,0.2);border-radius:4px;color:#a5b4fc;font:400 12px 'Space Grotesk',sans-serif;padding:3px 10px;cursor:pointer;";
  }

  const scroll    = container.querySelector("#sh_gridScroll");
  const formulaEl = container.querySelector("#sh_formula");
  const cellnameEl= container.querySelector("#sh_cellname");
  const sheetsBar = container.querySelector("#sh_sheetsBar");

  // ── Canvas ────────────────────────────────────────────
  let canvas, ctx;

  function totalW() {
    let w = HDR_W;
    for (let c = 0; c < COLS; c++) w += cw(c);
    return w;
  }
  function totalH() {
    let h = HDR_H;
    for (let r = 0; r < ROWS; r++) h += rh(r);
    return h;
  }
  function colX(c) {
    let x = HDR_W;
    for (let i = 0; i < c; i++) x += cw(i);
    return x;
  }
  function rowY(r) {
    let y = HDR_H;
    for (let i = 0; i < r; i++) y += rh(i);
    return y;
  }
  function colAtX(px) {
    let x = HDR_W;
    for (let c = 0; c < COLS; c++) {
      if (px < x + cw(c)) return { col: c, edge: px > x + cw(c) - 5 };
      x += cw(c);
    }
    return null;
  }
  function rowAtY(py) {
    let y = HDR_H;
    for (let r = 0; r < ROWS; r++) {
      if (py < y + rh(r)) return { row: r, edge: py > y + rh(r) - 5 };
      y += rh(r);
    }
    return null;
  }

  function buildCanvas() {
    scroll.innerHTML = "";
    canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;";
    canvas.setAttribute("tabindex", "-1");
    canvas.style.outline = "none";
    document.addEventListener("paste", (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      const tablesPage = document.getElementById('tablesPage');
      if (!tablesPage || !tablesPage.classList.contains('activePage')) return;
      e.preventDefault();
      const text = e.clipboardData.getData("text/plain");
      if (!text) return;
      const rows = text.split("\n");
      rows.forEach((row, ri) => {
        row.split("\t").forEach((cell, ci) => {
          const r = sel.r + ri, c = sel.c + ci;
          if (r < ROWS && c < COLS) {
            if (cell.trim()) sh().cells[ck(r, c)] = cell.trim();
            else delete sh().cells[ck(r, c)];
          }
        });
      });
      saveState(); render(); updateFormulaBar();
    });
    scroll.appendChild(canvas);
    canvas.addEventListener("mousedown", onMouseDown);
    canvas.addEventListener("click", () => { canvas.focus(); });
    canvas.addEventListener("mousemove", onMouseMove);
    canvas.addEventListener("mouseup",   onMouseUp);
    canvas.addEventListener("dblclick",  onDblClick);
    ctx = canvas.getContext("2d");
    render();
  }

  function render() {
    if (!canvas) return;
    const W = totalW(), H = totalH();
    canvas.width  = W;
    canvas.height = H;
    canvas.style.width  = W + "px";
    canvas.style.height = H + "px";

    ctx.clearRect(0, 0, W, H);

    const BG   = "#050810";
    const HDR  = "#0c0f20";
    const BORD = "rgba(100,120,255,0.12)";
    const SEL  = "rgba(92,110,248,0.18)";
    const SELHDR = "rgba(92,110,248,0.35)";
    const ACCENT = "#818cf8";
    const TEXT = "#c8cff5";
    const MUTED= "#4a5280";

    // background
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    // selection highlight
    const sx1 = Math.min(sel.c, sel.c2), sx2 = Math.max(sel.c, sel.c2);
    const sy1 = Math.min(sel.r, sel.r2), sy2 = Math.max(sel.r, sel.r2);
    ctx.fillStyle = SEL;
    ctx.fillRect(colX(sx1), rowY(sy1), colX(sx2) + cw(sx2) - colX(sx1), rowY(sy2) + rh(sy2) - rowY(sy1));

    // cells
    ctx.font = "12px 'Space Grotesk',sans-serif";
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x = colX(c), y = rowY(r), w = cw(c), h = rh(r);
        // окраска по assigned_account_id
        const mapKey = sh().id + ":" + ck(r, c);
        const aid = assignedMap[mapKey];
        if (aid && !blockedSet.has(String(aid))) {
          ctx.fillStyle = "rgba(16,245,168,0.13)";
          ctx.fillRect(x, y, w, h);
        }
        // border
        ctx.strokeStyle = BORD;
        ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
        // text
        const val = sh().cells[ck(r, c)] || "";
        if (val) {
          if (val === "✗ ИСЧЕРПАН") {
            ctx.fillStyle = "rgba(244,63,94,0.18)";
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = "#f43f5e";
          } else if (val === "✓ OK") {
            ctx.fillStyle = "rgba(16,245,168,0.15)";
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = "#10f5a8";
          } else if (val === "? ОШИБКА") {
            ctx.fillStyle = "rgba(251,191,36,0.15)";
            ctx.fillRect(x, y, w, h);
            ctx.fillStyle = "#fbbf24";
          } else {
            ctx.fillStyle = TEXT;
          }
          ctx.save();
          ctx.beginPath();
          ctx.rect(x + 3, y + 1, w - 6, h - 2);
          ctx.clip();
          ctx.fillText(val, x + 4, y + h - 7);
          ctx.restore();
        }
      }
    }

    // active cell border
    ctx.strokeStyle = ACCENT;
    ctx.lineWidth = 2;
    ctx.strokeRect(colX(sel.c) + 1, rowY(sel.r) + 1, cw(sel.c) - 2, rh(sel.r) - 2);
    ctx.lineWidth = 1;

    // col headers
    ctx.fillStyle = HDR;
    ctx.fillRect(0, 0, W, HDR_H);
    ctx.strokeStyle = BORD;
    ctx.strokeRect(0.5, 0.5, W - 1, HDR_H - 1);
    ctx.font = "11px 'Space Grotesk',sans-serif";
    for (let c = 0; c < COLS; c++) {
      const x = colX(c), w = cw(c);
      const isSel = c >= sx1 && c <= sx2;
      ctx.fillStyle = isSel ? SELHDR : HDR;
      ctx.fillRect(x, 0, w, HDR_H);
      ctx.strokeStyle = BORD;
      ctx.strokeRect(x + 0.5, 0.5, w - 1, HDR_H - 1);
      ctx.fillStyle = isSel ? ACCENT : MUTED;
      ctx.textAlign = "center";
      ctx.fillText(colLetter(c), x + w / 2, HDR_H - 7);
    }

    // row headers
    ctx.fillStyle = HDR;
    ctx.fillRect(0, 0, HDR_W, H);
    ctx.font = "11px 'Space Grotesk',sans-serif";
    for (let r = 0; r < ROWS; r++) {
      const y = rowY(r), h = rh(r);
      const isSel = r >= sy1 && r <= sy2;
      ctx.fillStyle = isSel ? SELHDR : HDR;
      ctx.fillRect(0, y, HDR_W, h);
      ctx.strokeStyle = BORD;
      ctx.strokeRect(0.5, y + 0.5, HDR_W - 1, h - 1);
      ctx.fillStyle = isSel ? ACCENT : MUTED;
      ctx.textAlign = "center";
      ctx.fillText(r + 1, HDR_W / 2, y + h - 7);
    }

    // corner
    ctx.fillStyle = HDR;
    ctx.fillRect(0, 0, HDR_W, HDR_H);
    ctx.strokeStyle = BORD;
    ctx.strokeRect(0.5, 0.5, HDR_W - 1, HDR_H - 1);

    ctx.textAlign = "left";
  }

  // ── Mouse ─────────────────────────────────────────────
  function onMouseDown(e) {
    canvas.focus();
    if (editing) commitEdit();
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    // col resize?
    if (py < HDR_H) {
      let x = HDR_W;
      for (let c = 0; c < COLS; c++) {
        x += cw(c);
        if (Math.abs(px - x) < 5) {
          dragColIdx = c; dragColX0 = e.clientX; dragColW0 = cw(c);
          canvas.style.cursor = "col-resize";
          return;
        }
      }
    }
    // row resize?
    if (px < HDR_W) {
      let y = HDR_H;
      for (let r = 0; r < ROWS; r++) {
        y += rh(r);
        if (Math.abs(py - y) < 5) {
          dragRowIdx = r; dragRowY0 = e.clientY; dragRowH0 = rh(r);
          canvas.style.cursor = "row-resize";
          return;
        }
      }
    }

    const hit = hitCell(px, py);
    if (!hit) return;
    sel.r = sel.r2 = hit.r;
    sel.c = sel.c2 = hit.c;
    updateFormulaBar();
    render();
  }

  function onMouseMove(e) {
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;

    if (dragColIdx !== null) {
      const delta = e.clientX - dragColX0;
      sh().colW[dragColIdx] = Math.max(30, dragColW0 + delta);
      saveState(); render(); return;
    }
    if (dragRowIdx !== null) {
      const delta = e.clientY - dragRowY0;
      sh().rowH[dragRowIdx] = Math.max(16, dragRowH0 + delta);
      saveState(); render(); return;
    }

    // cursor hint
    if (py < HDR_H) {
      let x = HDR_W;
      for (let c = 0; c < COLS; c++) {
        x += cw(c);
        if (Math.abs(px - x) < 5) { canvas.style.cursor = "col-resize"; return; }
      }
    }
    if (px < HDR_W) {
      let y = HDR_H;
      for (let r = 0; r < ROWS; r++) {
        y += rh(r);
        if (Math.abs(py - y) < 5) { canvas.style.cursor = "row-resize"; return; }
      }
    }
    canvas.style.cursor = "default";

    if (e.buttons === 1) {
      const hit = hitCell(px, py);
      if (hit) { sel.r2 = hit.r; sel.c2 = hit.c; render(); }
    }
  }

  function onMouseUp(e) {
    if (dragColIdx !== null || dragRowIdx !== null) {
      dragColIdx = null; dragRowIdx = null;
      canvas.style.cursor = "default";
      saveState(); render();
      return;
    }
    showSelectionPlugin(e);
  }

  function showSelectionPlugin(e) {
    document.getElementById("sh_plugin_panel")?.remove();

    const r1=Math.min(sel.r,sel.r2), r2=Math.max(sel.r,sel.r2);
    const c1=Math.min(sel.c,sel.c2), c2=Math.max(sel.c,sel.c2);

    // показываем плагин только при выделении больше одной ячейки
    if (r1 === r2 && c1 === c2) return;

    const panel = document.createElement("div");
    panel.id = "sh_plugin_panel";
    panel.style.cssText = `
      position:fixed;
      left:${e.clientX + 10}px;
      top:${e.clientY - 10}px;
      background:#0e1230;
      border:1px solid rgba(100,120,255,0.4);
      border-radius:8px;
      padding:6px;
      z-index:9999;
      display:flex;
      flex-direction:column;
      gap:4px;
      box-shadow:0 8px 32px rgba(0,0,0,0.5);
      min-width:180px;
    `;

    const assignBtn = document.createElement("button");
    assignBtn.textContent = "🔑 Присвоить анкете";
    assignBtn.style.cssText = `
      padding:8px 14px;
      border-radius:6px;
      border:1px solid rgba(92,110,248,0.3);
      background:rgba(92,110,248,0.1);
      color:#a5b4fc;
      font:600 11px 'Space Grotesk',sans-serif;
      cursor:pointer;
      text-align:left;
    `;
    assignBtn.onmouseenter = () => assignBtn.style.background = "rgba(92,110,248,0.25)";
    assignBtn.onmouseleave = () => assignBtn.style.background = "rgba(92,110,248,0.1)";
    assignBtn.onclick = () => {
      panel.remove();
      console.log("[assign] r1,r2,c1,c2 =", r1, r2, c1, c2);
      openAssignKeysModal(r1, r2, c1, c2);
    };
    panel.appendChild(assignBtn);

    const checkBtn = document.createElement("button");
    checkBtn.textContent = "🔍 Проверить статус ключей";
    checkBtn.style.cssText = `
      padding:8px 14px;
      border-radius:6px;
      border:1px solid rgba(16,245,168,0.3);
      background:rgba(16,245,168,0.07);
      color:#10f5a8;
      font:600 11px 'Space Grotesk',sans-serif;
      cursor:pointer;
      text-align:left;
    `;
    checkBtn.onmouseenter = () => checkBtn.style.background = "rgba(16,245,168,0.18)";
    checkBtn.onmouseleave = () => checkBtn.style.background = "rgba(16,245,168,0.07)";
    checkBtn.onclick = () => {
      panel.remove();
      checkKeysStatus(r1, r2, c1, c2);
    };
    panel.appendChild(checkBtn);

    const consoleBtn = document.createElement("button");
    consoleBtn.textContent = "📋 Консоль логов";
    consoleBtn.style.cssText = `
      padding:8px 14px;
      border-radius:6px;
      border:1px solid rgba(251,191,36,0.3);
      background:rgba(251,191,36,0.07);
      color:#fbbf24;
      font:600 11px 'Space Grotesk',sans-serif;
      cursor:pointer;
      text-align:left;
    `;
    consoleBtn.onmouseenter = () => consoleBtn.style.background = "rgba(251,191,36,0.18)";
    consoleBtn.onmouseleave = () => consoleBtn.style.background = "rgba(251,191,36,0.07)";
    consoleBtn.onclick = () => {
      panel.remove();
      openLogConsole(r1, r2, c1, c2);
    };
    panel.appendChild(consoleBtn);

    document.body.appendChild(panel);

    // закрыть при клике вне
    setTimeout(() => {
      document.addEventListener("mousedown", function handler(ev) {
        if (!panel.contains(ev.target)) {
          panel.remove();
          document.removeEventListener("mousedown", handler);
        }
      });
    }, 100);
  }

  function openLogConsole(r1, r2, c1, c2) {
  const existing = document.getElementById("sh_log_console");
  if (existing) existing.remove();

  const scroll = document.getElementById("sh_gridScroll");
  if (!scroll) return;

  const accounts = window._cachedAccounts || [];

  const overlay = document.createElement("div");
  overlay.id = "sh_log_console";
  overlay.style.cssText = `
    position:absolute;
    left:${colX(c1)}px;
    top:${rowY(r1)}px;
    width:${Math.max(380, colX(c2) + cw(c2) - colX(c1))}px;
    height:${Math.max(260, rowY(r2) + rh(r2) - rowY(r1))}px;
    background:rgba(5,8,16,0.97);
    border:1px solid rgba(251,191,36,0.4);
    border-radius:10px;
    z-index:500;
    display:flex;
    flex-direction:column;
    box-shadow:0 8px 32px rgba(0,0,0,0.7);
    overflow:hidden;
  `;

  // Шапка
  const header = document.createElement("div");
  header.style.cssText = `
    display:flex;align-items:center;gap:8px;
    padding:8px 12px;
    background:rgba(251,191,36,0.08);
    border-bottom:1px solid rgba(251,191,36,0.2);
    flex-shrink:0;
  `;

  const title = document.createElement("span");
  title.textContent = "📋 Консоль логов";
  title.style.cssText = "font:700 11px 'Orbitron',sans-serif;color:#fbbf24;letter-spacing:0.06em;flex:1;";
  header.appendChild(title);

  // Селект анкеты
  const select = document.createElement("select");
  select.style.cssText = `
    padding:4px 8px;border-radius:5px;
    border:1px solid rgba(251,191,36,0.3);
    background:rgba(5,8,16,0.9);color:#e8ecff;
    font:400 11px 'Space Grotesk',sans-serif;
    max-width:160px;
  `;
  const emptyOpt = document.createElement("option");
  emptyOpt.value = "";
  emptyOpt.textContent = "— выбери анкету —";
  select.appendChild(emptyOpt);
  accounts.forEach(a => {
    const o = document.createElement("option");
    o.value = a.id;
    o.textContent = (a.name || a.id).slice(0, 22);
    select.appendChild(o);
  });
  header.appendChild(select);

  // Кнопка закрыть
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "✕";
  closeBtn.style.cssText = `
    background:transparent;border:none;color:#6872a8;
    font-size:16px;cursor:pointer;padding:0 4px;line-height:1;
  `;
  closeBtn.onmouseenter = () => closeBtn.style.color = "#fbbf24";
  closeBtn.onmouseleave = () => closeBtn.style.color = "#6872a8";
  closeBtn.onclick = () => {
    overlay.remove();
    try { localStorage.removeItem("claw_log_console_state"); } catch {}
  };
  header.appendChild(closeBtn);

  overlay.appendChild(header);

  // Лог-область
  const logArea = document.createElement("div");
  logArea.style.cssText = `
    flex:1;overflow-y:auto;
    padding:10px 12px;
    font:400 11px 'JetBrains Mono',monospace;
    color:#a5b4fc;
    line-height:1.7;
    white-space:pre-wrap;
    word-break:break-all;
  `;
  logArea.textContent = "Выбери анкету для просмотра лога...";
  overlay.appendChild(logArea);

  overlay.dataset.sheetId = sh().id;
  scroll.appendChild(overlay);

  // Polling логов каждые 500мс
  let lastLen = 0;
  let pollInterval = null;

  function startPolling(accountId) {
  if (pollInterval) clearInterval(pollInterval);
  lastLen = 0;
  logArea.innerHTML = "";

  let lastId = 0;

  function appendLine(line) {
    const span = document.createElement("span");
    span.textContent = line + "\n";
    if (line.includes("БЛОК")) span.style.color = "#f43f5e";
    else if (line.includes("Ошибка") || line.includes("ошибка")) span.style.color = "#fbbf24";
    else if (line.includes("поставлено") || line.includes("Ответов") || line.includes("запущен")) span.style.color = "#10f5a8";
    else span.style.color = "#a5b4fc";
    logArea.appendChild(span);
    logArea.scrollTop = logArea.scrollHeight;
  }

  // Сначала подгружаем историю из Supabase
  fetch(WORKER_API + `/api/split-log/${encodeURIComponent(accountId)}`)
    .then(r => r.json())
    .then(data => {
      if (data.logs && data.logs.length) {
        data.logs.forEach(row => appendLine(row.message));
        lastId = data.last_id || 0;
      } else {
        const noLog = document.createElement("span");
        noLog.textContent = "Логов пока нет.";
        noLog.style.color = "#4a5280";
        logArea.appendChild(noLog);
      }
    })
    .catch(() => {});

  // Потом раз в 3 сек подгружаем новые строки
  pollInterval = setInterval(async () => {
    if (!document.getElementById("sh_log_console")) {
      clearInterval(pollInterval);
      return;
    }

    // Новые строки из in-memory лога (мгновенно, без сервера)
    const logs = window._splitLogs[accountId];
    if (logs && logs.length > lastLen) {
      const newLines = logs.slice(lastLen);
      lastLen = logs.length;
      newLines.forEach(line => appendLine(line));
    }

    // Каждые 3 сек также тянем с сервера новые строки по lastId
    try {
      const res = await fetch(WORKER_API + `/api/split-log/${encodeURIComponent(accountId)}?after_id=${lastId}`);
      const data = await res.json();
      if (data.logs && data.logs.length) {
        data.logs.forEach(row => appendLine(row.message));
        lastId = data.last_id || lastId;
      }
    } catch {}

  }, 3000);
}

  select.addEventListener("change", () => {
    if (select.value) {
      startPolling(select.value);
      try {
        localStorage.setItem("claw_log_console_state", JSON.stringify({
          accountId: select.value, r1, r2, c1, c2, sheetId: sh().id
        }));
      } catch {}
    } else {
      logArea.textContent = "Выбери анкету для просмотра лога...";
      try { localStorage.removeItem("claw_log_console_state"); } catch {}
    }
  });

  // Если запущен только один сплит — выбираем его автоматически
  const runningSplitIds = [...runningSplits];
  if (runningSplitIds.length === 1) {
    select.value = runningSplitIds[0];
    startPolling(runningSplitIds[0]);
    try {
      localStorage.setItem("claw_log_console_state", JSON.stringify({
        accountId: runningSplitIds[0], r1, r2, c1, c2, sheetId: sh().id
      }));
    } catch {}
  }
}

  async function checkKeysStatus(r1, r2, c1, c2) {
    const sheet = sh();
    const keys = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const v = sheet.cells[ck(r, c)];
        if (v && v.trim().startsWith("gsk_")) keys.push({ r, c, key: v.trim() });
      }
    }
    if (!keys.length) { alert("Нет Groq ключей в выделенных ячейках"); return; }

    // Показываем индикатор прогресса
    const progressId = "sh_check_progress";
    let prog = document.getElementById(progressId);
    if (prog) prog.remove();
    prog = document.createElement("div");
    prog.id = progressId;
    prog.style.cssText = `
      position:fixed;bottom:24px;right:24px;z-index:10001;
      background:#0e1230;border:1px solid rgba(16,245,168,0.4);
      border-radius:10px;padding:14px 18px;
      font:400 12px 'JetBrains Mono',monospace;color:#10f5a8;
      box-shadow:0 8px 32px rgba(0,0,0,0.5);
    `;
    prog.textContent = `Проверяю 0 / ${keys.length} ключей...`;
    document.body.appendChild(prog);

    let done = 0;
    // Проверяем батчами по 5
    const BATCH = 5;
    for (let i = 0; i < keys.length; i += BATCH) {
      const batch = keys.slice(i, i + BATCH);
      try {
        const res = await fetch("/api/sheet/check-keys", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keys: batch.map(k => k.key) }),
        });
        const data = await res.json();
        for (const { r, c, key } of batch) {
          const status = data.results?.[key];
          const statusCol = c + 1;
          if (statusCol < COLS) {
            if (status === "ok") {
              sheet.cells[ck(r, statusCol)] = "✓ OK";
              // зелёный цвет через assignedMap не нужен — просто текст
            } else if (status === "exhausted") {
              sheet.cells[ck(r, statusCol)] = "✗ ИСЧЕРПАН";
            } else {
              sheet.cells[ck(r, statusCol)] = "? ОШИБКА";
            }
          }
        }
      } catch (e) {
        for (const { r, c } of batch) {
          if (c + 1 < COLS) sheet.cells[ck(r, c + 1)] = "? ОШИБКА";
        }
      }
      done += batch.length;
      prog.textContent = `Проверяю ${done} / ${keys.length} ключей...`;
      render();
      saveState();
    }

    prog.textContent = `✓ Проверено ${keys.length} ключей`;
    setTimeout(() => prog.remove(), 2500);
  }

  function openAssignKeysModal(r1, r2, c1, c2) {
    console.log("[modal] r1,r2,c1,c2 =", r1, r2, c1, c2, "cells:", JSON.stringify(sh().cells).slice(0,200));
    const keys = [];
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        const v = sh().cells[ck(r, c)];
        if (v) keys.push(v.trim());
      }
    }
    if (!keys.length) { alert("Нет ключей в выделенных ячейках"); return; }

    const existing = document.getElementById("sh_assign_modal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "sh_assign_modal";
    modal.style.cssText = `
      position:fixed;inset:0;z-index:10000;
      background:rgba(5,8,16,0.8);
      display:flex;align-items:center;justify-content:center;
    `;

    modal.innerHTML = `
      <div style="background:#0e1230;border:1px solid rgba(100,120,255,0.4);border-radius:14px;padding:24px;min-width:320px;max-width:400px;">
        <div style="font:800 14px 'Inter',sans-serif;color:#ffffff;margin-bottom:16px;letter-spacing:-0.01em;">Присвоить ключи анкете</div>
        <div style="font:400 11px 'Space Grotesk',sans-serif;color:#6872a8;margin-bottom:12px;">Выбрано ключей: <b style="color:#a5b4fc">${keys.length}</b></div>
        <select id="sh_assign_select" style="width:100%;padding:9px 12px;border-radius:8px;border:1px solid rgba(100,120,255,0.2);background:rgba(5,8,16,0.8);color:#e8ecff;font:400 12px 'Space Grotesk',sans-serif;margin-bottom:16px;">
          <option value="">— выбери анкету —</option>
        </select>
        <div style="display:flex;gap:8px;">
          <button id="sh_assign_confirm" style="flex:1;padding:11px;border-radius:9px;border:0;background:#ffffff;color:#000;font:700 12px 'Inter',sans-serif;cursor:pointer;">Присвоить</button>
          <button id="sh_assign_cancel" style="padding:11px 16px;border-radius:9px;border:1px solid rgba(255,255,255,0.16);background:transparent;color:#9a9caa;font:600 12px 'Inter',sans-serif;cursor:pointer;">Отмена</button>
        </div>
        <div id="sh_assign_result" style="margin-top:10px;font:400 11px 'JetBrains Mono',monospace;min-height:14px;"></div>
      </div>
    `;

    document.body.appendChild(modal);

    // заполняем список анкет
    const sel2 = modal.querySelector("#sh_assign_select");
    const accounts = window._cachedAccounts || [];
    accounts.forEach(a => {
      const o = document.createElement("option");
      o.value = a.id;
      o.textContent = a.name || a.id;
      sel2.appendChild(o);
    });

    modal.querySelector("#sh_assign_cancel").onclick = () => modal.remove();
    modal.querySelector("#sh_assign_confirm").onclick = async () => {
      const accountId = sel2.value;
      if (!accountId) { alert("Выбери анкету"); return; }
      const resultEl = modal.querySelector("#sh_assign_result");
      resultEl.textContent = "Сохраняю...";
      resultEl.style.color = "#a5b4fc";
      try {
        const res = await fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(accountId)}`);
        const data = await res.json();
        const current = data.settings || {};

        // Объединяем существующие ключи с новыми, без дублей (не перезатираем старые!)
        const existingKeys = (current.groq_api_keys || "")
          .split("\n")
          .map(k => k.trim())
          .filter(Boolean);
        const mergedKeys = Array.from(new Set([...existingKeys, ...keys]));

        await fetch(WORKER_API + `/api/ai-settings/${encodeURIComponent(accountId)}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...current, groq_api_keys: mergedKeys.join("\n") }),
        });

        // сохраняем assigned_account_id в sheet_cells
        const sheet = sh();
        const assignCells = [];
        for (let r = r1; r <= r2; r++) {
          for (let c = c1; c <= c2; c++) {
            const v = sheet.cells[ck(r, c)];
            if (!v) continue;
            const mapKey = sheet.id + ":" + ck(r, c);
            assignedMap[mapKey] = accountId;
            assignCells.push({
              row: r,
              col: c,
              value: v,
              assigned_account_id: accountId,
            });
          }
        }
        console.log("[assignedMap after]", JSON.stringify(assignedMap));
        console.log("[sheet.id]", sheet.id, "[sh().id]", sh().id);
        if (assignCells.length) {
          await fetch("/api/sheet/save", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sheet_id: sheet.id, cells: assignCells }),
          });
        }
        render(); // перерисовать зелёный
        resultEl.textContent = `✓ ${mergedKeys.length} ключей всего (добавлено новых: ${keys.length})`;
        resultEl.style.color = "#10f5a8";
        setTimeout(() => modal.remove(), 1200);
      } catch (err) {
        resultEl.textContent = "Ошибка: " + err.message;
        resultEl.style.color = "#f43f5e";
      }
    };
  }

  function onDblClick(e) {
    const rect = canvas.getBoundingClientRect();
    startEdit(e.clientX - rect.left, e.clientY - rect.top);
  }

  function hitCell(px, py) {
    if (px < HDR_W || py < HDR_H) return null;
    const ci = colAtX(px); const ri = rowAtY(py);
    if (!ci || !ri) return null;
    return { r: ri.row, c: ci.col };
  }

  // ── Inline edit ───────────────────────────────────────
  let editInput = null;

  function startEdit(px, py) {
    if (editing) return;
    const hit = hitCell(px, py);
    if (!hit) return;
    sel.r = sel.r2 = hit.r; sel.c = sel.c2 = hit.c;


    editing = true;
    editInput = document.createElement("input");
    editInput.value = sh().cells[ck(sel.r, sel.c)] || "";
    editInput.style.cssText = `
      position:absolute;
      left:${colX(sel.c)}px; top:${rowY(sel.r)}px;
      width:${cw(sel.c)}px; height:${rh(sel.r)}px;
      background:#0e1230; color:#e8ecff;
      border:2px solid #818cf8; outline:none;
      font:12px 'JetBrains Mono',monospace;
      padding:0 4px; box-sizing:border-box; z-index:10;
    `;
    scroll.appendChild(editInput);
    editInput.focus();
    editInput.select();

    editInput.addEventListener("keydown", e => {
      if (e.key === "Enter")  { commitEdit(); moveDown(); }
      if (e.key === "Tab")    { e.preventDefault(); commitEdit(); moveRight(); }
      if (e.key === "Escape") { cancelEdit(); }
    });
    editInput.addEventListener("blur", () => { if (editing) commitEdit(); });
  }

  function commitEdit() {
    if (!editInput) return;
    const val = editInput.value;
    if (val) sh().cells[ck(sel.r, sel.c)] = val;
    else delete sh().cells[ck(sel.r, sel.c)];
    const inp = editInput;
    editInput = null; editing = false;
    if (inp.parentNode) inp.remove();
    updateFormulaBar(); saveState(); render();
  }

  function cancelEdit() {
    if (editInput) { editInput.remove(); editInput = null; }
    editing = false;
  }

  function moveDown()  { if (sel.r < ROWS - 1) { sel.r++; sel.r2 = sel.r; sel.c2 = sel.c; updateFormulaBar(); render(); } }
  function moveRight() { if (sel.c < COLS - 1) { sel.c++; sel.c2 = sel.c; sel.r2 = sel.r; updateFormulaBar(); render(); } }

  // ── Formula bar ───────────────────────────────────────
  function updateFormulaBar() {
    cellnameEl.textContent = cellName(sel.r, sel.c);
    formulaEl.value = sh().cells[ck(sel.r, sel.c)] || "";
  }

  formulaEl.addEventListener("focus", () => {
    formulaEl._editing = true;
  });
  formulaEl.addEventListener("keydown", e => {
    if (e.key === "Enter") {
      const val = formulaEl.value;
      if (val) sh().cells[ck(sel.r, sel.c)] = val;
      else delete sh().cells[ck(sel.r, sel.c)];
      saveState(); render(); formulaEl.blur();
    }
    if (e.key === "Escape") { formulaEl.blur(); updateFormulaBar(); }
  });
  formulaEl.addEventListener("blur", () => { formulaEl._editing = false; });

  // ── Keyboard nav ──────────────────────────────────────
  container.setAttribute("tabindex", "0");
  container.addEventListener("keydown", e => {
    if (editing || formulaEl === document.activeElement) return;
    const mv = { ArrowUp: [-1,0], ArrowDown: [1,0], ArrowLeft: [0,-1], ArrowRight: [0,1] }[e.key];
    if (mv) {
      e.preventDefault();
      sel.r = Math.max(0, Math.min(ROWS-1, sel.r + mv[0]));
      sel.c = Math.max(0, Math.min(COLS-1, sel.c + mv[1]));
      sel.r2 = sel.r; sel.c2 = sel.c;
      updateFormulaBar(); render();
      scrollToCell();
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      const r1=Math.min(sel.r,sel.r2), r2=Math.max(sel.r,sel.r2);
      const c1=Math.min(sel.c,sel.c2), c2=Math.max(sel.c,sel.c2);
      const deletedCells = [];
      for (let r=r1;r<=r2;r++) for(let c=c1;c<=c2;c++) {
        if (sh().cells[ck(r,c)]) deletedCells.push({ row: r, col: c, value: null });
        delete sh().cells[ck(r,c)];
      }
      saveState();
      if (deletedCells.length) {
        fetch("/api/sheet/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sheet_id: sh().id, cells: deletedCells }),
        }).catch(() => {});
      }
      render(); updateFormulaBar(); return;
    }
    if (e.key === "F2") { startEditByKey(); return; }
    // начать вводить символ
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      startEditByKeyChar(e.key);
    }
  });

  function startEditByKey() {
    const x = colX(sel.c), y = rowY(sel.r);
    editing = true;
    editInput = document.createElement("input");
    editInput.value = sh().cells[ck(sel.r, sel.c)] || "";
    editInput.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${cw(sel.c)}px;height:${rh(sel.r)}px;background:#0e1230;color:#e8ecff;border:2px solid #818cf8;outline:none;font:12px 'JetBrains Mono',monospace;padding:0 4px;box-sizing:border-box;z-index:10;`;
    scroll.appendChild(editInput);
    editInput.focus(); editInput.select();
    editInput.addEventListener("keydown", e => {
      if (e.key === "Enter")  { commitEdit(); moveDown(); }
      if (e.key === "Tab")    { e.preventDefault(); commitEdit(); moveRight(); }
      if (e.key === "Escape") { cancelEdit(); }
    });
    editInput.addEventListener("blur", () => { if (editing) commitEdit(); });
  }

  function startEditByKeyChar(char) {
    const x = colX(sel.c), y = rowY(sel.r);
    editing = true;
    editInput = document.createElement("input");
    editInput.value = char;
    editInput.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${cw(sel.c)}px;height:${rh(sel.r)}px;background:#0e1230;color:#e8ecff;border:2px solid #818cf8;outline:none;font:12px 'JetBrains Mono',monospace;padding:0 4px;box-sizing:border-box;z-index:10;`;
    scroll.appendChild(editInput);
    editInput.focus();
    editInput.setSelectionRange(editInput.value.length, editInput.value.length);
    editInput.addEventListener("keydown", e => {
      if (e.key === "Enter")  { commitEdit(); moveDown(); }
      if (e.key === "Tab")    { e.preventDefault(); commitEdit(); moveRight(); }
      if (e.key === "Escape") { cancelEdit(); }
    });
    editInput.addEventListener("blur", () => { if (editing) commitEdit(); });
  }

  function scrollToCell() {
    const x = colX(sel.c), y = rowY(sel.r);
    const w = cw(sel.c), h = rh(sel.r);
    if (x < scroll.scrollLeft) scroll.scrollLeft = x - HDR_W;
    if (x + w > scroll.scrollLeft + scroll.clientWidth) scroll.scrollLeft = x + w - scroll.clientWidth;
    if (y < scroll.scrollTop) scroll.scrollTop = y - HDR_H;
    if (y + h > scroll.scrollTop + scroll.clientHeight) scroll.scrollTop = y + h - scroll.clientHeight;
  }

  // ── Toolbar buttons ───────────────────────────────────
  container.querySelector("#sh_clearBtn").onclick = () => {
    const r1=Math.min(sel.r,sel.r2),r2=Math.max(sel.r,sel.r2);
    const c1=Math.min(sel.c,sel.c2),c2=Math.max(sel.c,sel.c2);
    const cleared = [];
    for (let r=r1;r<=r2;r++) for(let c=c1;c<=c2;c++) {
      if (sh().cells[ck(r,c)]) cleared.push({ row: r, col: c, value: null });
      delete sh().cells[ck(r,c)];
    }
    saveState();
    if (cleared.length) {
      fetch("/api/sheet/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sheet_id: sh().id, cells: cleared }),
      }).catch(() => {});
    }
    render(); updateFormulaBar();
  };

  // ── Sheets bar ────────────────────────────────────────
  function renderSheetsBar() {
    sheetsBar.innerHTML = "";
    state.sheets.forEach((s, i) => {
      const tab = document.createElement("div");
      tab.style.cssText = `
        display:flex;align-items:center;gap:4px;
        padding:4px 12px 4px 10px;
        border-radius:6px 6px 0 0;
        border:1px solid ${i === state.active ? "rgba(100,120,255,0.4)" : "transparent"};
        border-bottom:none;
        background:${i === state.active ? "rgba(92,110,248,0.12)" : "rgba(255,255,255,0.03)"};
        color:${i === state.active ? "#a5b4fc" : "#4a5280"};
        font:500 12px 'Space Grotesk',sans-serif;
        cursor:pointer;white-space:nowrap;user-select:none;
        transition:background 0.15s;
      `;

      // Label — double click to rename
      const label = document.createElement("span");
      label.textContent = s.name;
      let clickTimer = null;
      label.addEventListener("click", (e) => {
        e.stopPropagation();
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
          renameSheet(i, tab, label);
        } else {
          clickTimer = setTimeout(async () => {
            clickTimer = null;
            state.active = i;
            const existingConsole = document.getElementById("sh_log_console");
            if (existingConsole) {
              if (existingConsole.dataset.sheetId !== sh().id) {
                existingConsole.style.display = "none";
              } else {
                existingConsole.style.display = "flex";
              }
            }
            saveState();
            await _loadSheetFromServer(sh().id);
            renderSheetsBar(); render(); updateFormulaBar();
          }, 250);
        }
      });
      tab.appendChild(label);

      // Delete x (not on last sheet)
      if (state.sheets.length > 1) {
        const x = document.createElement("span");
        x.textContent = "×";
        x.style.cssText = "margin-left:2px;opacity:0.5;font-size:13px;line-height:1;";
        x.onmouseenter = () => x.style.opacity = "1";
        x.onmouseleave = () => x.style.opacity = "0.5";
        x.onclick = (e) => { e.stopPropagation(); deleteSheet(i); };
        tab.appendChild(x);
      }

      sheetsBar.appendChild(tab);
    });

    // + button
    const addBtn = document.createElement("div");
    addBtn.textContent = "+";
    addBtn.style.cssText = "padding:4px 12px;color:#4a5280;font-size:16px;cursor:pointer;line-height:24px;border-radius:4px;";
    addBtn.onmouseenter = () => addBtn.style.color = "#a5b4fc";
    addBtn.onmouseleave = () => addBtn.style.color = "#4a5280";
    addBtn.onclick = () => {
      const name = "Лист " + (state.sheets.length + 1);
      state.sheets.push(newSheet(name));
      state.active = state.sheets.length - 1;
      saveState(); renderSheetsBar(); render(); updateFormulaBar();
    };
    sheetsBar.appendChild(addBtn);
  }

  function renameSheet(i, tabEl, labelEl) {
    const inp = document.createElement("input");
    inp.value = state.sheets[i].name;
    inp.style.cssText = "width:80px;font:500 12px 'Space Grotesk',sans-serif;background:#0a0d1a;color:#e8ecff;border:1px solid #818cf8;border-radius:3px;padding:1px 4px;outline:none;";
    labelEl.replaceWith(inp);
    inp.focus(); inp.select();
    inp.addEventListener("keydown", (e) => { e.stopPropagation(); });
    inp.addEventListener("click", (e) => { e.stopPropagation(); });
    function done() {
      const v = inp.value.trim() || state.sheets[i].name;
      state.sheets[i].name = v;
      saveState(); renderSheetsBar();
    }
    inp.onblur = done;
    inp.onkeydown = e => { if (e.key === "Enter") { e.preventDefault(); done(); } if (e.key === "Escape") { renderSheetsBar(); } };
  }

  function deleteSheet(i) {
    if (!confirm(`Удалить лист «${state.sheets[i].name}»?`)) return;
    state.sheets.splice(i, 1);
    if (state.active >= state.sheets.length) state.active = state.sheets.length - 1;
    saveState(); renderSheetsBar(); render(); updateFormulaBar();
  }

  // ── Инициализация ─────────────────────────────────────
  buildCanvas();
  renderSheetsBar();
  updateFormulaBar();
  // загружаем данные с сервера асинхронно
  (async () => {
    await _loadBlockedAccounts();
    for (const s of state.sheets) {
      await _loadSheetFromServer(s.id);
    }
    render();
  })();
  scroll.addEventListener("mousedown", () => { canvas.focus(); });

  // Восстанавливаем консоль логов после перезагрузки страницы
  setTimeout(() => {
    try {
      const saved = localStorage.getItem("claw_log_console_state");
      if (!saved) return;
      const { accountId, r1, r2, c1, c2, sheetId } = JSON.parse(saved);
      if (!accountId) return;
      if (sheetId && sheetId !== sh().id) return;
      openLogConsole(r1 ?? 0, r2 ?? 5, c1 ?? 4, c2 ?? 6);
      setTimeout(() => {
        const sel = document.getElementById("sh_log_console")?.querySelector("select");
        if (sel) {
          sel.value = accountId;
          sel.dispatchEvent(new Event("change"));
        }
      }, 300);
    } catch {}
  }, 800);

// Copy / paste
  let _copyBuffer = [];

  canvas.addEventListener("keydown", e => {
    // используем e.code вместо e.key — не зависит от раскладки клавиатуры (RU/EN)
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyC") {
      e.preventDefault();
      _copyBuffer = [];
      const r1=Math.min(sel.r,sel.r2), r2=Math.max(sel.r,sel.r2);
      const c1=Math.min(sel.c,sel.c2), c2=Math.max(sel.c,sel.c2);
      for (let r=r1; r<=r2; r++) {
        const row = [];
        for (let c=c1; c<=c2; c++) row.push(sh().cells[ck(r,c)] || "");
        _copyBuffer.push(row);
      }
      // также пишем в системный буфер
      const text = _copyBuffer.map(r => r.join("\t")).join("\n");
      try { navigator.clipboard.writeText(text); } catch {}
    }

    if ((e.ctrlKey || e.metaKey) && e.code === "KeyV") {
      e.preventDefault();
      if (_copyBuffer.length) {
        _copyBuffer.forEach((row, ri) => {
          row.forEach((cell, ci) => {
            const r = sel.r + ri, c = sel.c + ci;
            if (r < ROWS && c < COLS) {
              if (cell) sh().cells[ck(r, c)] = cell;
              else delete sh().cells[ck(r, c)];
            }
          });
        });
        saveState(); render(); updateFormulaBar();
      } else {
        navigator.clipboard.readText().then(text => {
          const rows = text.split("\n");
          rows.forEach((row, ri) => {
            row.split("\t").forEach((cell, ci) => {
              const r = sel.r + ri, c = sel.c + ci;
              if (r < ROWS && c < COLS) {
                if (cell) sh().cells[ck(r, c)] = cell;
                else delete sh().cells[ck(r, c)];
              }
            });
          });
          saveState(); render(); updateFormulaBar();
        }).catch(()=>{});
      }
    }
  });
}

// ── Модалка скрещивания ───────────────────────────────────

let chainModalAccountId = null;
let chainModalAccountName = "";

function openChainModal(accountId, accountName) {
  chainModalAccountId = accountId;
  chainModalAccountName = accountName;

  const modal = document.getElementById("chainModal");
  const title = document.getElementById("chainModalTitle");
  if (title) title.textContent = `Цепочка резервов: ${accountName}`;

  renderChainModal();
  modal?.classList.add("open");
}

async function renderChainModal() {
  const listEl = document.getElementById("chainModalList");
  if (!listEl) return;

  listEl.innerHTML = '<div class="result">Загружаю...</div>';

  try {
    const [chainRes, accRes] = await Promise.all([
      fetch(WORKER_API + `/api/accounts/${encodeURIComponent(chainModalAccountId)}/chain`),
      fetch(WORKER_API + "/api/accounts"),
    ]);
    const chainData = await chainRes.json();
    const accData   = await accRes.json();

    const chain    = chainData.chain || [];
    const accounts = (accData.accounts || []).filter(a => a.id !== chainModalAccountId);

    listEl.innerHTML = "";

    if (!chain.length) {
      listEl.innerHTML = '<div class="result" style="opacity:.5;">Резервов пока нет</div>';
    } else {
      chain.forEach((resId, idx) => {
        const acc = accounts.find(a => a.id === resId);
        const name = acc ? (acc.name || resId) : `(удалена) ${resId.slice(0,8)}`;

        const row = document.createElement("div");
        row.className = "result";
        row.style.cssText = "display:flex;align-items:center;justify-content:space-between;padding:10px 14px;margin-bottom:6px;";
        row.innerHTML = `
          <span style="font-size:13px;">${idx + 1}. ${name}</span>
          <button class="sqBtn" data-remove-idx="${idx}" style="padding:4px 10px;font-size:11px;background:rgba(255,60,60,.15);border-color:rgba(255,60,60,.3);color:#ff6b6b;">✕</button>
        `;
        row.querySelector("[data-remove-idx]").onclick = async () => {
          const newChain = [...chain];
          newChain.splice(idx, 1);
          await saveChain(newChain);
          renderChainModal();
        };
        listEl.appendChild(row);
      });
    }

    // Селект для добавления новой резервной анкеты
    const alreadyInChain = new Set([chainModalAccountId, ...chain]);
    const available = accounts.filter(a => !alreadyInChain.has(a.id));

    const addRow = document.createElement("div");
    addRow.style.cssText = "display:flex;gap:8px;margin-top:12px;";
    addRow.innerHTML = `
      <select id="chainAddSelect" style="flex:1;padding:8px 10px;border-radius:var(--r);border:1px solid rgba(255,255,255,.12);background:rgba(5,8,16,.8);color:var(--text);font-size:13px;">
        <option value="">— добавить резерв —</option>
        ${available.map(a => `<option value="${a.id}">${a.name || a.id}</option>`).join("")}
      </select>
      <button id="chainAddBtn" class="sqBtn" style="padding:8px 14px;">+ Добавить</button>
    `;
    listEl.appendChild(addRow);

    document.getElementById("chainAddBtn").onclick = async () => {
      const sel = document.getElementById("chainAddSelect");
      const newId = sel.value;
      if (!newId) return;
      const newChain = [...chain, newId];
      await saveChain(newChain);
      renderChainModal();
    };

  } catch (err) {
    listEl.innerHTML = `<div class="result bad">Ошибка: ${err.message}</div>`;
  }
}

async function saveChain(chain) {
  const res = await fetch(WORKER_API + `/api/accounts/${encodeURIComponent(chainModalAccountId)}/chain`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
    body: JSON.stringify({ account_id: chainModalAccountId, chain }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok || !data.ok) {
    throw new Error(data.detail || data.error || "Цепочка резервов не сохранилась");
  }

  return data.chain || chain;
}

document.getElementById("chainModalClose")?.addEventListener("click", () => {
  document.getElementById("chainModal")?.classList.remove("open");
});

document.getElementById("chainModal")?.addEventListener("click", (e) => {
  if (e.target === document.getElementById("chainModal")) {
    document.getElementById("chainModal")?.classList.remove("open");
  }
});

checkAuthAndStart();

// ── Отчёт ─────────────────────────────────────────────────

var reportCurrentMonth = "";
var reportSummaryRows = [];
var reportShowAll = false;

function reportGetMonthTabs() {
  const months = [];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("ru", { month: "long", year: "numeric" });
    months.push({ key, label });
  }
  return months;
}


function reportGetToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
}

function reportRenderMonthTabs() {
  const container = document.getElementById("reportMonthTabs");
  if (!container) return;
  const months = reportGetMonthTabs();
  if (!reportCurrentMonth) reportCurrentMonth = months[0].key;
  container.innerHTML = months.map(m => `
    <button class="rMonthTab ${m.key === reportCurrentMonth ? "active" : ""}" data-month="${m.key}">
      ${m.label.charAt(0).toUpperCase() + m.label.slice(1)}
    </button>
  `).join("");
  container.querySelectorAll(".rMonthTab").forEach(btn => {
    btn.addEventListener("click", () => {
      reportCurrentMonth = btn.dataset.month;
      reportShowAll = false;
      reportRenderMonthTabs();
      reportLoad();
    });
  });
}
async function reportLoad() {
  const tbody = document.getElementById("reportTableBody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text2);">Загрузка...</td></tr>`;

  try {
    const res = await fetch(`/api/report/summary?month=${reportCurrentMonth}`);
    const data = await res.json();
    console.log("REPORT DATA:", data);
    reportSummaryRows = data.rows || [];
    console.log("ROWS:", reportSummaryRows.length);
    reportRenderTable();
  } catch (err) {
    console.error("REPORT ERROR:", err);
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--red);">Ошибка загрузки</td></tr>`;
  }
}

function reportRenderTable() {
  const tbody = document.getElementById("reportTableBody");
  const tfoot = document.getElementById("reportTableFoot");
  if (!tbody) return;

  if (!reportSummaryRows.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align:center;padding:32px;color:var(--text2);">Нет данных. Добавьте TG-аккаунт.</td></tr>`;
    if (tfoot) tfoot.innerHTML = "";
    return;
  }

  const today = reportGetToday();
  const rows = reportShowAll ? reportSummaryRows : reportSummaryRows.filter(r => r.date === today);
  
  let totalLeads = 0, totalVisits = 0, totalBookings = 0, totalCancels = 0;

  tbody.innerHTML = rows.map((row) => {
    const realIdx = reportSummaryRows.indexOf(row);
    totalLeads    += row.leads || 0;
    totalVisits   += row.visits || 0;
    totalBookings += row.bookings || 0;
    totalCancels  += row.cancels || 0;
    const conv = row.bookings > 0 ? "50%" : row.visits > 0 ? "100%" : "—";
    const dateLabel = row.date.slice(8, 10) + "." + row.date.slice(5, 7);
    return `
      <tr data-idx="${realIdx}">
        <td class="rTd">${dateLabel}</td>
        <td class="rTd" style="color:var(--cyan);">@${row.tg_account}${row.label ? " · " + row.label : ""}</td>
        <td class="rTd editable" data-field="leads" data-idx="${realIdx}">${row.leads || 0}</td>
        <td class="rTd editable" data-field="visits" data-idx="${realIdx}" style="color:var(--green);">${row.visits || 0}</td>
        <td class="rTd editable" data-field="bookings" data-idx="${realIdx}" style="color:#60a5fa;">${row.bookings || 0}</td>
        <td class="rTd editable" data-field="cancels" data-idx="${realIdx}" style="color:var(--red);">${row.cancels || 0}</td>
        <td class="rTd" style="color:var(--green);">${conv}</td>
        <td class="rTd"><button class="rDeleteBtn" data-username="${row.tg_account}" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:13px;opacity:0.5;" title="Удалить аккаунт">✕</button></td>
      </tr>
    `;
  }).join("");

  const totalConv = totalBookings > 0 ? "50%" : totalVisits > 0 ? "100%" : "—";
  if (tfoot) {
    tfoot.innerHTML = `
      <tr>
        <td class="rFootTd" colspan="2">Итого</td>
        <td class="rFootTd">${totalLeads}</td>
        <td class="rFootTd" style="color:var(--green);">${totalVisits}</td>
        <td class="rFootTd" style="color:#60a5fa;">${totalBookings}</td>
        <td class="rFootTd" style="color:var(--red);">${totalCancels}</td>
        <td class="rFootTd">${totalConv}</td>
      </tr>
    `;
  }

  // Inline редактирование
  tbody.querySelectorAll(".rTd.editable").forEach(cell => {
    cell.addEventListener("click", () => {
      if (cell.querySelector("input")) return;
      const idx = +cell.dataset.idx;
      const field = cell.dataset.field;
      const current = reportSummaryRows[idx][field] || 0;
      cell.innerHTML = `<input class="rInlineInput" type="number" min="0" value="${current}" />`;
      const input = cell.querySelector("input");
      input.focus();
      input.select();
      const save = async () => {
        const val = parseInt(input.value) || 0;
        reportSummaryRows[idx][field] = val;
        cell.textContent = val;
        const row = reportSummaryRows[idx];
        try {
          await fetch("/api/report/entries", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              tg_account: row.tg_account,
              date: row.date,
              visits: reportSummaryRows[idx].visits || 0,
              bookings: reportSummaryRows[idx].bookings || 0,
              cancels: reportSummaryRows[idx].cancels || 0,
            }),
          });
        } catch {}
        reportRenderTable();
      };
      input.addEventListener("blur", save);
      input.addEventListener("keydown", e => {
        if (e.key === "Enter") input.blur();
        if (e.key === "Escape") { cell.textContent = current; }
      });
    });
  });

  // Удаление TG-аккаунта
  tbody.querySelectorAll(".rDeleteBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const username = btn.dataset.username;
      const confirmed = await new Promise(resolve => {
        const backdrop = document.createElement("div");
        backdrop.className = "modalBackdrop open";
        backdrop.innerHTML = `
          <div class="modal" style="max-width:320px;">
            <div class="modalHead">
              <span>Удалить аккаунт</span>
            </div>
            <div class="modalBody">
              <p style="font:400 13px/1.6 'Space Grotesk',sans-serif;color:var(--text2);">
                Удалить <span style="color:var(--cyan);font-weight:600;">@${username}</span> из отчёта? Все данные по нему останутся в базе.
              </p>
              <div style="display:flex;gap:8px;margin-top:18px;">
                <button class="ghost" id="rDelCancel" style="flex:1;">Отмена</button>
                <button class="small danger" id="rDelConfirm" style="flex:1;padding:10px;">Удалить</button>
              </div>
            </div>
          </div>
        `;
        document.body.appendChild(backdrop);
        backdrop.querySelector("#rDelCancel").onclick = () => { backdrop.remove(); resolve(false); };
        backdrop.querySelector("#rDelConfirm").onclick = () => { backdrop.remove(); resolve(true); };
        backdrop.onclick = (e) => { if (e.target === backdrop) { backdrop.remove(); resolve(false); } };
      });
      if (!confirmed) return;
      try {
        const accRes = await fetch("/api/report/tg-accounts");
        const accData = await accRes.json();
        const acc = (accData.accounts || []).find(a => a.tg_username === username);
        if (!acc) return;
        await fetch(`/api/report/tg-accounts/${acc.id}`, { method: "DELETE" });
        reportLoad();
      } catch {}
    });
  });
}

function initReportPage() {
  if (window._reportInited) {
    reportRenderMonthTabs();
    reportLoad();
    return;
  }
  window._reportInited = true;

  reportRenderMonthTabs();
  reportLoad();

  // Кнопка обновить
  document.getElementById("reportRefreshBtn")?.addEventListener("click", reportLoad);
  document.getElementById("reportToggleBtn")?.addEventListener("click", () => {
    reportShowAll = !reportShowAll;
    reportRenderTable();
  });

  // Модалка добавления аккаунта
  const modal = document.getElementById("reportAddAccountModal");
  document.getElementById("reportAddAccountBtn")?.addEventListener("click", () => {
    document.getElementById("reportAddUsername").value = "";
    document.getElementById("reportAddLabel").value = "";
    document.getElementById("reportAddAccountResult").textContent = "";
    modal?.classList.add("open");
  });
  document.getElementById("reportAddAccountModalClose")?.addEventListener("click", () => modal?.classList.remove("open"));
  modal?.addEventListener("click", e => { if (e.target === modal) modal.classList.remove("open"); });

  document.getElementById("reportAddAccountSaveBtn")?.addEventListener("click", async () => {
    const username = document.getElementById("reportAddUsername").value.trim();
    const label = document.getElementById("reportAddLabel").value.trim();
    const resultEl = document.getElementById("reportAddAccountResult");
    if (!username) { resultEl.textContent = "Введите @username"; resultEl.className = "result bad"; return; }
    try {
      const res = await fetch("/api/report/tg-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tg_username: username, label }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Ошибка");
      resultEl.textContent = "Добавлено!";
      resultEl.className = "result good";
      modal?.classList.remove("open");
      reportLoad();
    } catch (err) {
      resultEl.textContent = err.message;
      resultEl.className = "result bad";
    }
  });
}

notificationsBell?.addEventListener(
  "click",
  () => {
    notificationsModal?.classList.add("open");
  }
);

notificationsModalClose?.addEventListener(
  "click",
  () => {
    notificationsModal?.classList.remove("open");
  }
);

teamInviteBtn?.addEventListener(
  "click",
  async () => {

    try {

      const res =
        await fetch(
          "/api/team/invite",
          {
            method:"POST",
            headers:{
              "Content-Type":"application/json"
            },
            body: JSON.stringify({
              email: teamInviteEmail.value,
              role: teamInviteRole.value
            })
          }
        );

      const data =
        await res.json();

      if (!res.ok)
        throw new Error(
          typeof data.detail === "string" 
            ? data.detail 
            : JSON.stringify(data.detail) || data.message || "Ошибка отправки"
        );

      teamInviteResult.textContent =
        "Приглашение отправлено";

      teamInviteResult.className =
        "result good";

      teamInviteEmail.value = "";

    } catch(err){
      teamInviteResult.textContent =
        err.message || err.detail || "Ошибка отправки приглашения";
      teamInviteResult.className =
        "result bad";
    }
  }
);

// ══════════════════════════════════════════════════════════
// ПРОКСИ НАСТРОЙКИ
// ══════════════════════════════════════════════════════════

const PROXY_PLATFORMS = [
  { id: "mamba",       label: "Mamba / Love Mail" },
  { id: "twinby",      label: "Twinby" },
];

async function loadProxySettings() {
  const list = document.getElementById("proxyList");
  if (!list) return;

  list.innerHTML = "<div style='color:var(--text-muted);font-size:13px;'>Загрузка...</div>";

  let rows = {};
  try {
    const res = await fetch("/api/proxy-settings");
    const data = await res.json();
    if (Array.isArray(data)) {
      data.forEach(r => { rows[r.id] = r; });
    }
  } catch (e) {
    list.innerHTML = "<div style='color:#fb7185;font-size:13px;'>Ошибка загрузки прокси</div>";
    return;
  }

  list.innerHTML = "";

  PROXY_PLATFORMS.forEach(platform => {
    const row = rows[platform.id] || {};

    const card = document.createElement("div");
    card.style.cssText = `
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
    `;

    const short = row.host ? `${row.host}:${row.port || ""}` : "не настроен";
    const dot = row.host && row.use_proxy !== false ? "#10f5a8" : "#64748b";

    card.innerHTML = `
      <div class="proxyHead" data-id="${platform.id}" style="display:flex;align-items:center;gap:10px;padding:12px 16px;cursor:pointer;user-select:none;">
        <span style="width:7px;height:7px;border-radius:50%;background:${dot};flex:none;"></span>
        <span style="font:700 12px 'Orbitron',sans-serif;color:var(--accent3);letter-spacing:0.06em;min-width:150px;">${platform.label}</span>
        <span style="font:400 12px 'JetBrains Mono',monospace;color:var(--text-muted);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${short}</span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;margin:0;" onclick="event.stopPropagation()">
          <span style="font-size:11px;color:var(--text-muted);">вкл</span>
          <input type="checkbox" class="proxyActive" data-id="${platform.id}" ${row.use_proxy !== false ? "checked" : ""} style="width:15px;height:15px;cursor:pointer;" />
        </label>
        <span class="proxyChevron" data-id="${platform.id}" style="color:var(--text-muted);font-size:11px;flex:none;">▼</span>
      </div>
      <div class="proxyBody" data-id="${platform.id}" style="display:none;padding:0 16px 14px;">
      <div style="display:grid;grid-template-columns:1fr 120px;gap:10px;margin-bottom:10px;">
        <div>
          <label style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:block;">HOST</label>
          <input class="proxyHost" data-id="${platform.id}" value="${row.host || ""}" placeholder="170.168.253.248" style="font-family:'JetBrains Mono',monospace;font-size:12px;" />
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:block;">PORT</label>
          <input class="proxyPort" data-id="${platform.id}" value="${row.port || ""}" placeholder="62508" style="font-family:'JetBrains Mono',monospace;font-size:12px;" />
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px;">
        <div>
          <label style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:block;">LOGIN</label>
          <input class="proxyUser" data-id="${platform.id}" value="${row.username || ""}" placeholder="username" style="font-family:'JetBrains Mono',monospace;font-size:12px;" />
        </div>
        <div>
          <label style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:block;">PASSWORD</label>
          <input class="proxyPass" data-id="${platform.id}" value="${row.password || ""}" placeholder="password" style="font-family:'JetBrains Mono',monospace;font-size:12px;" />
        </div>
      </div>
      <div style="margin-bottom:14px;">
        <label style="font-size:11px;color:var(--text-muted);margin-bottom:4px;display:block;">USER-AGENT</label>
        <input class="proxyUA" data-id="${platform.id}" value="${row.user_agent || ""}" placeholder="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" style="font-family:'JetBrains Mono',monospace;font-size:12px;" />
      </div>
      <button class="taskRunBtn proxySaveBtn" data-id="${platform.id}" style="width:100%;margin-top:0;">Сохранить</button>
      <div class="proxySaveMsg" data-id="${platform.id}" style="margin-top:8px;font-size:12px;min-height:18px;"></div>
      </div>
    `;

    list.appendChild(card);
  });

  // Разворачивание карточки по клику на шапку
  document.querySelectorAll(".proxyHead").forEach(head => {
    head.addEventListener("click", () => {
      const id = head.dataset.id;
      const body = document.querySelector(`.proxyBody[data-id="${id}"]`);
      const chev = document.querySelector(`.proxyChevron[data-id="${id}"]`);
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "block";
      if (chev) chev.textContent = open ? "▼" : "▲";
    });
  });

  // Навешиваем обработчики
  document.querySelectorAll(".proxySaveBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const host     = document.querySelector(`.proxyHost[data-id="${id}"]`).value.trim();
      const port     = parseInt(document.querySelector(`.proxyPort[data-id="${id}"]`).value.trim()) || 0;
      const username = document.querySelector(`.proxyUser[data-id="${id}"]`).value.trim();
      const password = document.querySelector(`.proxyPass[data-id="${id}"]`).value.trim();
      const use_proxy = document.querySelector(`.proxyActive[data-id="${id}"]`).checked;
      const user_agent = document.querySelector(`.proxyUA[data-id="${id}"]`).value.trim();
      const msg = document.querySelector(`.proxySaveMsg[data-id="${id}"]`);

      btn.disabled = true;
      btn.textContent = "Сохраняю...";
      msg.textContent = "";

      try {
        const res = await fetch("/api/proxy-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, host, port, username, password, use_proxy, user_agent }),
        });
        const data = await res.json();
        if (res.ok) {
          msg.style.color = "var(--green, #10f5a8)";
          msg.textContent = "✓ Сохранено";
        } else {
          msg.style.color = "#fb7185";
          msg.textContent = "✗ " + (data.error || "Ошибка");
        }
      } catch (e) {
        msg.style.color = "#fb7185";
        msg.textContent = "✗ Ошибка сети";
      }

      btn.disabled = false;
      btn.textContent = "Сохранить";
      setTimeout(() => { msg.textContent = ""; }, 3000);
    });
  });
}

// ── intCity UI ────────────────────────────────────────────

async function loadIntCityLeads() {
  const accounts = cachedAccounts.filter(a => (a.platform || "").toLowerCase() === "intcity");
  if (!accounts.length) return;
  const accountId = accounts[0].id;

  const tableEl = document.getElementById("intCityLeadsTable");
  const countEl = document.getElementById("intCityLeadsCount");
  if (!tableEl) return;

  try {
    const res = await fetch(`/api/intcity/leads?account_id=${accountId}`, { headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" } });
    const data = await res.json();
    const leads = data.leads || [];
    if (countEl) countEl.textContent = `(${leads.length})`;
    if (!leads.length) {
      tableEl.innerHTML = '<div style="color:var(--text2);">Email адресов пока нет. Нажми "Парсить".</div>';
      return;
    }
    tableEl.innerHTML = leads.map(l => `
      <div style="display:flex;gap:12px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.05);">
        <span style="color:var(--cyan);flex:1;">${l.email}</span>
        <span style="color:var(--text2);font-size:11px;">${l.sent_at ? "✓ отправлено" : "не отправлено"}</span>
        <a href="${l.ad_url}" target="_blank" style="color:var(--text2);font-size:11px;">объявление</a>
      </div>
    `).join("");
  } catch (e) {
    if (tableEl) tableEl.innerHTML = `<div style="color:#fb7185;">Ошибка: ${e.message}</div>`;
  }
}

document.getElementById("intCityParseBtn")?.addEventListener("click", async () => {
  const accounts = cachedAccounts.filter(a => (a.platform || "").toLowerCase() === "intcity");
  if (!accounts.length) { alert("Сначала подключи аккаунт intCity"); return; }
  const accountId = accounts[0].id;
  const pages = parseInt(document.getElementById("intCityPages")?.value) || 3;
  const resultEl = document.getElementById("intCityParseResult");
  const btn = document.getElementById("intCityParseBtn");

  btn.disabled = true;
  btn.textContent = "Парсю...";
  if (resultEl) { resultEl.textContent = "Парсю объявления..."; resultEl.className = "result"; }

  try {
    const res = await fetch("/api/intcity/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
      body: JSON.stringify({ account_id: accountId, pages }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || "Ошибка парсинга");
    if (resultEl) { resultEl.textContent = data.summary; resultEl.className = "result good"; }
    loadIntCityLeads();
  } catch (e) {
    if (resultEl) { resultEl.textContent = e.message; resultEl.className = "result bad"; }
  } finally {
    btn.disabled = false;
    btn.textContent = "🔍 Парсить";
  }
});

document.getElementById("intCityRefreshLeads")?.addEventListener("click", loadIntCityLeads);

document.getElementById("intCitySendBtn")?.addEventListener("click", async () => {
  const accounts = cachedAccounts.filter(a => (a.platform || "").toLowerCase() === "intcity");
  if (!accounts.length) { alert("Сначала подключи аккаунт intCity"); return; }
  const accountId = accounts[0].id;
  const subject = document.getElementById("intCitySubject")?.value.trim();
  const body = document.getElementById("intCityBody")?.value.trim();
  const limit = parseInt(document.getElementById("intCityLimit")?.value) || 50;
  const resultEl = document.getElementById("intCitySendResult");
  const btn = document.getElementById("intCitySendBtn");

  if (!subject) { alert("Введи тему письма"); return; }
  if (!body) { alert("Введи текст письма"); return; }

  btn.disabled = true;
  btn.textContent = "Отправляю...";
  if (resultEl) { resultEl.textContent = "Отправляю рассылку..."; resultEl.className = "result"; }

  try {
    const res = await fetch("/api/intcity/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": localStorage.getItem("claw_auth_token") || "" },
      body: JSON.stringify({ account_id: accountId, subject, body, limit }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || "Ошибка отправки");
    if (resultEl) { resultEl.textContent = data.summary; resultEl.className = "result good"; }
    loadIntCityLeads();
  } catch (e) {
    if (resultEl) { resultEl.textContent = e.message; resultEl.className = "result bad"; }
  } finally {
    btn.disabled = false;
    btn.textContent = "📨 Отправить рассылку";
  }
});

// ── КОНТАКТЫ ────────────────────────────────────────────

async function loadContacts() {
  const tableEl = document.getElementById("contactsTable");
  const countEl = document.getElementById("contactsTotalCount");
  const search = document.getElementById("contactsSearch")?.value.trim().toLowerCase() || "";
  const filter = document.getElementById("contactsFilter")?.value || "all";
  if (!tableEl) return;

  tableEl.innerHTML = '<div style="color:var(--text2);">Загрузка...</div>';

  try {
    const accounts = cachedAccounts.filter(a => (a.platform || "").toLowerCase() === "intcity");
    if (!accounts.length) {
      tableEl.innerHTML = '<div style="color:var(--text2);">Нет подключённых аккаунтов intCity.</div>';
      return;
    }
    const accountId = accounts[0].id;
    const res = await fetch(`/api/intcity/leads?account_id=${accountId}`, { headers: { "Authorization": localStorage.getItem("claw_auth_token") || "" } });
    const data = await res.json();
    let leads = data.leads || [];

    if (countEl) countEl.textContent = `(всего: ${leads.length})`;

    // Фильтрация
    if (filter === "sent") leads = leads.filter(l => l.sent_at);
    if (filter === "unsent") leads = leads.filter(l => !l.sent_at);
    if (search) leads = leads.filter(l => l.email.toLowerCase().includes(search));

    if (!leads.length) {
      tableEl.innerHTML = '<div style="color:var(--text2);">Нет контактов по фильтру.</div>';
      return;
    }

    tableEl.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 140px 1fr;gap:0;border:1px solid rgba(255,255,255,.08);border-radius:10px;overflow:hidden;">
        <div style="padding:8px 12px;background:rgba(255,255,255,.04);font-weight:600;color:var(--text2);font-size:11px;">EMAIL</div>
        <div style="padding:8px 12px;background:rgba(255,255,255,.04);font-weight:600;color:var(--text2);font-size:11px;">СТАТУС</div>
        <div style="padding:8px 12px;background:rgba(255,255,255,.04);font-weight:600;color:var(--text2);font-size:11px;">ИСТОЧНИК</div>
        ${leads.map(l => `
          <div style="padding:8px 12px;border-top:1px solid rgba(255,255,255,.05);color:var(--cyan);">${l.email}</div>
          <div style="padding:8px 12px;border-top:1px solid rgba(255,255,255,.05);color:${l.sent_at ? "var(--green)" : "var(--text2)"};">${l.sent_at ? "✓ отправлено" : "ожидает"}</div>
          <div style="padding:8px 12px;border-top:1px solid rgba(255,255,255,.05);"><a href="${l.ad_url}" target="_blank" style="color:var(--text2);text-decoration:none;font-size:11px;">объявление ↗</a></div>
        `).join("")}
      </div>
    `;
  } catch (e) {
    tableEl.innerHTML = `<div style="color:#fb7185;">Ошибка: ${e.message}</div>`;
  }
}

// ── Команда: контакты и назначения ─────────────────────────
async function initTeamNav() {
  try {
    const res = await fetch("/api/auth/me");
    const data = await res.json();
    const btn = document.getElementById("navTeamBtn");
    if (btn) btn.style.display = data.is_admin ? "" : "none";
    const cab = document.getElementById("navCabinetBtn");
    if (cab) cab.style.display = data.is_admin ? "" : "none";
  } catch {}
}

const ctState = { users: [], contacts: [], assignments: [], picked: new Set() };
const ctAttr = s => escapeHtml(String(s ?? "")).replace(/"/g, "&quot;");
const ctDate = d => {
  if (!d) return "—";
  const [y, m, dd] = String(d).slice(0, 10).split("-");
  return `${dd}.${m}.${y}`;
};

async function ctJson(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
  return data;
}

function ctUserName(email) {
  const u = ctState.users.find(x => x.email === email);
  return u?.username || (email || "").split("@")[0];
}

function ctSetResult(text, ok) {
  const el = document.getElementById("ctAssignResult");
  if (!el) return;
  el.style.display = "block";
  el.style.color = ok ? "var(--green)" : "#fb7185";
  el.textContent = text;
}

async function loadTeam() {
  const box = document.getElementById("teamAssignments");
  const dateEl = document.getElementById("ctDate");
  if (dateEl && !dateEl.value) dateEl.value = new Date().toLocaleDateString("sv-SE");
  try {
    const [u, c, a] = await Promise.all([
      ctJson("/api/admin/users"),
      ctJson("/api/admin/team-contacts"),
      ctJson("/api/admin/assignments"),
    ]);
    ctState.users = u.users || [];
    ctState.contacts = c.contacts || [];
    ctState.assignments = a.assignments || [];
    renderTeamUsersSelect();
    renderTeamContacts();
    renderTeamAssignments();
  } catch (e) {
    if (box) box.innerHTML = `<div style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function renderTeamUsersSelect() {
  const sel = document.getElementById("ctUserSelect");
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— кому назначить —</option>' + ctState.users.map(u =>
    `<option value="${ctAttr(u.email)}">${escapeHtml(u.username || u.email)}</option>`
  ).join("");
  sel.value = cur;
}

function updatePickedCount() {
  const el = document.getElementById("ctPickedCount");
  if (el) el.textContent = ctState.picked.size
    ? `Выбрано: ${ctState.picked.size}`
    : "Кликни по контактам ниже, чтобы выбрать их для назначения";
}

function renderTeamContacts() {
  const box = document.getElementById("ctContactsList");
  const count = document.getElementById("ctContactsCount");
  if (count) count.textContent = `(${ctState.contacts.length})`;
  if (!box) return;

  const names = new Set(ctState.contacts.map(c => c.tg_username));
  [...ctState.picked].forEach(n => { if (!names.has(n)) ctState.picked.delete(n); });

  box.innerHTML = ctState.contacts.length
    ? ctState.contacts.map(c => `
        <span class="ctChip pick ${ctState.picked.has(c.tg_username) ? "on" : ""}" data-name="${ctAttr(c.tg_username)}" title="${ctAttr(c.note)}">
          @${escapeHtml(c.tg_username)}<span class="ctChipX" data-id="${ctAttr(c.id)}">✕</span>
        </span>`).join("")
    : '<div style="color:var(--text2);">Контактов пока нет — добавь выше.</div>';

  box.querySelectorAll(".ctChip.pick").forEach(chip => chip.addEventListener("click", e => {
    if (e.target.classList.contains("ctChipX")) return;
    const n = chip.dataset.name;
    if (ctState.picked.has(n)) ctState.picked.delete(n); else ctState.picked.add(n);
    chip.classList.toggle("on");
    updatePickedCount();
  }));

  box.querySelectorAll(".ctChipX").forEach(x => x.addEventListener("click", async e => {
    e.stopPropagation();
    if (!(await ctConfirm("Удалить контакт?", "Контакт исчезнет из базы. Уже созданные назначения останутся."))) return;
    try {
      await ctJson(`/api/admin/team-contacts/${encodeURIComponent(x.dataset.id)}`, { method: "DELETE" });
      await loadTeam();
    } catch (err) { alert(err.message); }
  }));

  updatePickedCount();
}

const CT_ICON = {
  send:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg>',
  user:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0 1 6-6h4a6 6 0 0 1 6 6v1"/></svg>',
  task:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 14l2 2 4-4"/></svg>',
  calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="4" width="18" height="17" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>',
  copy:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  check:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M20 6L9 17l-5-5"/></svg>',
  trash:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>',
  note:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
};

function ctConfirm(title, text = "", okLabel = "Удалить") {
  if (!document.getElementById("ctConfirmStyle")) {
    const st = document.createElement("style");
    st.id = "ctConfirmStyle";
    st.textContent = `
      .ctcOverlay{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;background:rgba(5,6,10,.6);backdrop-filter:blur(6px);animation:ctcFade .15s ease-out;}
      .ctcBox{width:min(380px,calc(100vw - 32px));background:linear-gradient(165deg,#1b1c24,#121319);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:22px;box-shadow:0 24px 60px rgba(0,0,0,.55);animation:ctcPop .18s cubic-bezier(.2,.9,.3,1.2);}
      .ctcIcon{width:44px;height:44px;border-radius:13px;display:grid;place-items:center;background:rgba(251,113,133,.1);border:1px solid rgba(251,113,133,.3);color:#fb7185;margin-bottom:14px;}
      .ctcIcon svg{width:20px;height:20px;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
      .ctcTitle{font-weight:700;font-size:16px;color:var(--text,#fff);}
      .ctcText{font-size:13px;color:var(--text2,#9ca3af);margin-top:6px;line-height:1.5;}
      .ctcBtns{display:flex;gap:10px;margin-top:20px;}
      .ctcBtn{flex:1;height:40px;border-radius:11px;font-size:13px;font-weight:600;cursor:pointer;transition:all .15s;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04);color:var(--text,#fff);}
      .ctcBtn:hover{background:rgba(255,255,255,.08);}
      .ctcBtn.danger{background:rgba(251,113,133,.15);border-color:rgba(251,113,133,.45);color:#fb7185;}
      .ctcBtn.danger:hover{background:rgba(251,113,133,.25);box-shadow:0 0 16px rgba(251,113,133,.25);}
      @keyframes ctcFade{from{opacity:0}to{opacity:1}}
      @keyframes ctcPop{from{opacity:0;transform:scale(.94) translateY(6px)}to{opacity:1;transform:none}}`;
    document.head.appendChild(st);
  }

  return new Promise(resolve => {
    const ov = document.createElement("div");
    ov.className = "ctcOverlay";
    ov.innerHTML = `
      <div class="ctcBox" role="dialog" aria-modal="true">
        <div class="ctcIcon">${CT_ICON.trash}</div>
        <div class="ctcTitle">${escapeHtml(title)}</div>
        ${text ? `<div class="ctcText">${escapeHtml(text)}</div>` : ""}
        <div class="ctcBtns">
          <button class="ctcBtn" data-v="0">Отмена</button>
          <button class="ctcBtn danger" data-v="1">${escapeHtml(okLabel)}</button>
        </div>
      </div>`;

    let done = false;
    const close = v => {
      if (done) return;
      done = true;
      document.removeEventListener("keydown", onKey);
      ov.remove();
      resolve(v);
    };
    const onKey = e => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") { e.preventDefault(); close(true); }
    };

    ov.addEventListener("click", e => {
      if (e.target === ov) return close(false);
      const b = e.target.closest(".ctcBtn");
      if (b) close(b.dataset.v === "1");
    });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(ov);
    ov.querySelector(".ctcBtn.danger").focus();
  });
}

const ctPlural = n => {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return "контакт";
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return "контакта";
  return "контактов";
};

function ctNodeHtml(a, mode) {
  const done = a.status === "done";
  const list = a.contacts || [];
  const title = mode === "admin" ? escapeHtml(ctUserName(a.user_email)) : "Telegram-контакты";

  const rows = list.map(n => `
    <div class="ctRow">
      <span class="ctRowIco">${CT_ICON.send}</span>
      <a class="ctRowName" href="https://t.me/${encodeURIComponent(n)}" target="_blank" rel="noopener">@${escapeHtml(n)}</a>
      <button class="ctIconBtn ctCopyBtn" data-copy="@${ctAttr(n)}" title="Скопировать">${CT_ICON.copy}</button>
    </div>`).join("");

  const copyAll = list.length > 1
    ? `<button class="ctIconBtn ctCopyBtn" data-copy="${ctAttr(list.map(n => "@" + n).join("\n"))}" title="Скопировать все">${CT_ICON.copy}</button>`
    : "";

  const action = mode === "admin"
    ? `<button class="ctActBtn danger ctDelBtn" data-id="${ctAttr(a.id)}">${CT_ICON.trash}Удалить</button>`
    : (done ? "" : `<button class="ctActBtn ctDoneBtn" data-id="${ctAttr(a.id)}">${CT_ICON.check}Готово</button>`);

  return `
    <div class="ctCard ${done ? "done" : ""}">
      <div class="ctCardHead">
        <div class="ctIconBox">${mode === "admin" ? CT_ICON.user : CT_ICON.task}</div>
        <div>
          <div class="ctCardTitle">${title}</div>
          <div class="ctCardSub">${list.length} ${ctPlural(list.length)}${a.shift_start ? ` · ${a.shift_type === "night" ? "ночь" : "день"} ${String(a.shift_start).slice(0, 5)}–${String(a.shift_end).slice(0, 5)}` : ""}</div>
        </div>
        <span class="ctDatePill">${CT_ICON.calendar}${ctDate(a.work_date)}</span>
      </div>
      <div class="ctRows">${rows}</div>
      ${a.note ? `<div class="ctCardNote">${CT_ICON.note}<span>${escapeHtml(a.note)}</span></div>` : ""}
      <div class="ctCardFoot">
        <span class="ctStatusPill"><span class="ctDot"></span>${done ? "Выполнено" : "В работе"}</span>
        <span style="flex:1;"></span>
        ${copyAll}
        ${action}
      </div>
    </div>`;
}

// Копирование TG: одна кнопка на строке или «все» внизу карточки
document.addEventListener("click", async e => {
  const btn = e.target.closest(".ctCopyBtn");
  if (!btn) return;
  e.preventDefault();
  const text = btn.dataset.copy || "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
  if (btn.dataset.busy) return;
  btn.dataset.busy = "1";
  const old = btn.innerHTML;
  btn.classList.add("ok");
  btn.innerHTML = CT_ICON.check;
  setTimeout(() => {
    btn.classList.remove("ok");
    btn.innerHTML = old;
    delete btn.dataset.busy;
  }, 1200);
});

function renderTeamAssignments() {
  const box = document.getElementById("teamAssignments");
  if (!box) return;
  box.innerHTML = ctState.assignments.length
    ? `<div class="ctNodes">${ctState.assignments.map(a => ctNodeHtml(a, "admin")).join("")}</div>`
    : '<div style="color:var(--text2);margin-top:10px;">Назначений пока нет.</div>';
  box.querySelectorAll(".ctDelBtn").forEach(btn => btn.addEventListener("click", async () => {
    if (!(await ctConfirm("Удалить назначение?", "Сотрудник больше не увидит эти контакты у себя в МОИ TG."))) return;
    try {
      await ctJson(`/api/admin/assignments/${encodeURIComponent(btn.dataset.id)}`, { method: "DELETE" });
      await loadTeam();
    } catch (e) { alert(e.message); }
  }));
}

document.getElementById("ctAddContactBtn")?.addEventListener("click", async () => {
  const nameEl = document.getElementById("ctNewContact");
  const noteEl = document.getElementById("ctNewContactNote");
  const names = nameEl.value.trim().split(/[\s,]+/).filter(Boolean);
  if (!names.length) return;
  try {
    for (const n of names) {
      await ctJson("/api/admin/team-contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tg_username: n, note: noteEl.value.trim() }),
      });
    }
    nameEl.value = "";
    noteEl.value = "";
    await loadTeam();
  } catch (e) { alert(e.message); }
});

document.getElementById("ctAssignBtn")?.addEventListener("click", async () => {
  const email = document.getElementById("ctUserSelect").value;
  const date = document.getElementById("ctDate").value;
  const noteEl = document.getElementById("ctNote");
  if (!email || !date || !ctState.picked.size) {
    ctSetResult("Выбери человека, дату и хотя бы один контакт.", false);
    return;
  }
  try {
    await ctJson("/api/admin/assignments", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify((() => {
        const [shift_type = "", shift_start = "", shift_end = ""] = (document.getElementById("ctShift")?.value || "").split("|");
        return { user_email: email, work_date: date, contacts: [...ctState.picked], note: noteEl.value.trim(), shift_type, shift_start, shift_end };
      })()),
    });
    const cnt = ctState.picked.size;
    ctState.picked.clear();
    noteEl.value = "";
    ctSetResult(`✅ Назначено: ${ctUserName(email)}, ${ctDate(date)}, контактов: ${cnt}`, true);
    await loadTeam();
  } catch (e) { ctSetResult(e.message, false); }
});

document.getElementById("teamRefreshBtn")?.addEventListener("click", () => { loadTeam(); loadTeamEff(); });

// ── Эффективность команды ──────────────────────────────────
const eff = { month: new Date().toLocaleDateString("sv-SE").slice(0, 7) };

function effLife(h) {
  if (h == null) return "—";
  if (h < 24) return `${Math.round(h)} ч`;
  const d = Math.floor(h / 24);
  return `${d} д ${Math.round(h - d * 24)} ч`;
}

async function loadTeamEff() {
  const box = document.getElementById("teamEff");
  const monthEl = document.getElementById("effMonth");
  if (!box) return;
  const [y, m] = eff.month.split("-").map(Number);
  if (monthEl) monthEl.textContent = `${SCH_MONTHS[m - 1]} ${y}`;
  box.innerHTML = '<div style="color:var(--text2);margin-top:10px;">Загрузка...</div>';
  try {
    const data = await ctJson(`/api/admin/team-stats?month=${eff.month}`);
    const people = data.people || [];
    if (!people.length) {
      box.innerHTML = '<div style="color:var(--text2);margin-top:10px;">В этом месяце анкеты не подключали.</div>';
      return;
    }
    const rows = people.map(p => {
      const pct = p.total ? Math.round(p.blocked / p.total * 100) : 0;
      const plats = Object.entries(p.platforms).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `<span class="effChip">${escapeHtml(k)} × ${v}</span>`).join("");
      const tgs = Object.entries(p.tgs).sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `<span class="effChip tg">@${escapeHtml(k)} × ${v}</span>`).join("") || '<span style="color:var(--text2);">—</span>';
      return `
        <tr>
          <td><b>${escapeHtml(p.name)}</b><div style="font-size:11px;color:var(--text2);">${escapeHtml(p.email)}</div></td>
          <td><span class="effNum">${p.total}${p.deleted ? `<small>из них удалено ${p.deleted}</small>` : ""}</span></td>
          <td><div class="effChips">${plats}</div></td>
          <td><span class="effNum effGood">${p.alive}</span></td>
          <td><span class="effNum effBad">${p.blocked}<small>${pct}%</small></span></td>
          <td><span class="effNum">${effLife(p.avg_life_hours)}${p.life_samples ? `<small>по ${p.life_samples} анк.</small>` : ""}</span></td>
          <td><div class="effChips">${tgs}</div></td>
        </tr>`;
    }).join("");
    box.innerHTML = `
      <div class="effWrap">
        <table class="effTable">
          <thead><tr>
            <th>Сотрудник</th><th>Подключил</th><th>Платформы</th><th>Живые</th>
            <th>В блоке</th><th>Ср. жизнь до блока</th><th>TG в AI-менеджере</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  } catch (e) {
    box.innerHTML = `<div style="color:#fb7185;margin-top:10px;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

document.getElementById("effPrev")?.addEventListener("click", () => {
  const [y, m] = eff.month.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  eff.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  loadTeamEff();
});
document.getElementById("effNext")?.addEventListener("click", () => {
  const [y, m] = eff.month.split("-").map(Number);
  const d = new Date(y, m, 1);
  eff.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  loadTeamEff();
});

// ── Мои задания ────────────────────────────────────────────
async function updateMyTgBadge() {
  const badge = document.getElementById("myTgBadge");
  if (!badge) return;
  try {
    const data = await ctJson("/api/my/assignments/count");
    const n = data.count || 0;
    badge.textContent = n > 99 ? "99+" : n;
    badge.style.display = n ? "inline-flex" : "none";
  } catch {}
}

async function loadMyTasks() {
  updateMyTgBadge();
  const box = document.getElementById("myTasksList");
  if (!box) return;
  box.innerHTML = '<div style="color:var(--text2);">Загрузка...</div>';
  try {
    const data = await ctJson("/api/my/assignments");
    const list = data.assignments || [];
    box.innerHTML = list.length
      ? `<div class="ctNodes">${list.map(a => ctNodeHtml(a, "me")).join("")}</div>`
      : '<div style="color:var(--text2);margin-top:10px;">Назначений пока нет.</div>';
    box.querySelectorAll(".ctDoneBtn").forEach(btn => btn.addEventListener("click", async () => {
      try {
        await ctJson(`/api/my/assignments/${encodeURIComponent(btn.dataset.id)}/done`, { method: "POST" });
        await loadMyTasks();
      } catch (e) { alert(e.message); }
    }));
    loadNotifications();
    tgTodayLoad();
  } catch (e) {
    box.innerHTML = `<div style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
  tpLoad();
}

document.getElementById("myTasksRefreshBtn")?.addEventListener("click", loadMyTasks);

// ── Пул анкет: участники берут TG сами ─────────────────────
const tp = { date: "", shift: "day", data: null, busy: false };

function tpDayLabel(iso) {
  const today = new Date().toLocaleDateString("sv-SE");
  if (iso === today) return "Сегодня";
  const d = new Date(iso + "T12:00:00");
  return `Завтра, ${String(d.getDate()).padStart(2, "0")}.${String(d.getMonth() + 1).padStart(2, "0")}`;
}

async function tpLoad() {
  const body = document.getElementById("tpBody");
  if (!body) return;
  try {
    tp.data = await ctJson(`/api/tg-pool?shift=${tp.shift}` + (tp.date ? `&date=${tp.date}` : ""));
    tp.date = tp.data.date;
    tpRender();
  } catch (e) {
    body.innerHTML = `<div style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function tpRender() {
  const d = tp.data || {};
  const body = document.getElementById("tpBody");
  const days = document.getElementById("tpDays");
  const cnt = document.getElementById("tpCnt");
  const add = document.getElementById("tpAddBtn");
  if (!body) return;

  if (days) days.innerHTML = (d.dates || []).map(x =>
    `<button class="tpDay${x === d.date ? " on" : ""}" data-tpday="${ctAttr(x)}">${escapeHtml(tpDayLabel(x))}</button>`).join("") +
    `<span style="width:1px;background:rgba(255,255,255,.12);margin:0 4px;"></span>` +
    [["day", "☀ День"], ["night", "🌙 Ночь"]].map(([k, t]) =>
      `<button class="tpDay${tp.shift === k ? " on" : ""}" data-tpshift="${k}">${t}</button>`).join("");
  if (add) add.style.display = d.is_admin ? "" : "none";

  const items = (d.items || []).slice()
    .sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
  const free = items.filter(i => i.active && !i.owner_email).length;

  const prio = document.getElementById("tpPrio");
  if (prio) {
    const list = items.filter(i => i.priority && i.active);
    const warn = (!d.mine && free > 0)
      ? `<div class="tpWarn">Ты ещё не взял ни одной телеги на эту смену. Свободно ${free} — закрепи за собой.</div>`
      : "";
    prio.innerHTML = warn + `
      <div class="tpPrio">
        <div class="tpPrioT">★ Приоритет<span>крутить в первую очередь</span></div>
        <div class="tpPrioList">${list.length
          ? list.map(i => `<span class="tpPrioTag">@${escapeHtml(i.tg_username)}${
              i.pc_name ? ` <i>${escapeHtml(i.pc_name)}</i>` : ""}${
              i.owner_email ? ` <i>· ${escapeHtml(i.owner_name)}</i>` : ` <i>· свободна</i>`}</span>`).join("")
          : `<span class="tpPrioEmpty">Приоритетных телег нет${d.is_admin ? " — жми ★ на карточке" : "."}</span>`}</div>
      </div>`;
  }
  if (cnt) cnt.innerHTML = `свободно <b>${free}</b> из ${items.length} · у тебя <b>${d.mine || 0}</b>`;

  if (!items.length) {
    body.innerHTML = `<div style="color:var(--text2);">Анкет в пуле нет${d.is_admin ? ". Жми «+ Анкета»." : "."}</div>`;
    return;
  }

  body.innerHTML = `<div class="tpGrid">${items.map(i => {
    const mine = i.owner_email === d.me;
    const taken = !!i.owner_email;
    const cls = (!i.active ? "off" : mine ? "mine" : taken ? "" : "free") + (i.priority ? " prio" : "");
    const sub = !i.active ? "выведена из работы"
      : mine ? "закреплена за тобой"
      : taken ? `у: ${i.owner_name}`
      : (i.note || "свободна");
    const subCls = mine ? "own" : taken ? "taken" : "";
    const btn = !i.active ? ""
      : mine ? `<button class="tpBtn drop" data-tpdrop="${i.id}">Освободить</button>`
      : taken ? (d.is_admin ? `<button class="tpBtn drop" data-tpdrop="${i.id}">Снять</button>` : "")
      : `<button class="tpBtn take" data-tptake="${i.id}">Взять</button>`;
    return `<div class="tpCard ${cls}">
      ${i.pc_name ? `<span class="tpPc">${escapeHtml(i.pc_name)}</span>` : ""}
      <div class="tpInfo">
        <div class="tpNick">@${escapeHtml(i.tg_username)}</div>
        <div class="tpSub ${subCls}">${escapeHtml(sub)}</div>
      </div>
      ${btn}
      ${d.is_admin ? `<button class="tpIco star${i.priority ? " on" : ""}" data-tpstar="${i.id}" title="Приоритет">★</button>
        <button class="tpIco" data-tpedit="${i.id}" title="Изменить">✎</button>
        <button class="tpIco del" data-tpdel="${i.id}" title="Удалить">✕</button>` : ""}
    </div>`;
  }).join("")}</div>`;
}

async function tpAct(url, btn) {
  if (tp.busy) return;
  tp.busy = true;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    await ctJson(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: tp.date, shift: tp.shift }),
    });
    await tpLoad();
    updateMyTgBadge();
  } catch (e) {
    alert(e.message);
    await tpLoad();
  }
  tp.busy = false;
}

document.getElementById("myTasksPage")?.addEventListener("click", async e => {
  const day = e.target.closest("[data-tpday]");
  if (day) { tp.date = day.dataset.tpday; tpLoad(); return; }

  const sh = e.target.closest("[data-tpshift]");
  if (sh) { tp.shift = sh.dataset.tpshift; tpLoad(); return; }

  const take = e.target.closest("[data-tptake]");
  if (take) { tpAct(`/api/tg-pool/${encodeURIComponent(take.dataset.tptake)}/take`, take); return; }

  const drop = e.target.closest("[data-tpdrop]");
  if (drop) { tpAct(`/api/tg-pool/${encodeURIComponent(drop.dataset.tpdrop)}/release`, drop); return; }

  const star = e.target.closest("[data-tpstar]");
  if (star) {
    const it = (tp.data.items || []).find(x => x.id === star.dataset.tpstar);
    if (!it) return;
    try {
      await ctJson(`/api/tg-pool/${encodeURIComponent(it.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ priority: !it.priority }),
      });
      await tpLoad();
    } catch (err) { alert(err.message); }
    return;
  }

  const edit = e.target.closest("[data-tpedit]");
  if (edit) {
    const it = (tp.data.items || []).find(x => x.id === edit.dataset.tpedit);
    if (!it) return;
    const nick = prompt("Ник анкеты (без @):", it.tg_username);
    if (nick === null) return;
    const pc = prompt("ПК оператора:", it.pc_name || "");
    if (pc === null) return;
    try {
      await ctJson(`/api/tg-pool/${encodeURIComponent(it.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tg_username: nick.trim(), pc_name: pc.trim() }),
      });
      await tpLoad();
    } catch (err) { alert(err.message); }
    return;
  }

  const del = e.target.closest("[data-tpdel]");
  if (del) {
    const it = (tp.data.items || []).find(x => x.id === del.dataset.tpdel);
    if (!it || !confirm(`Удалить @${it.tg_username} из пула?`)) return;
    try {
      await ctJson(`/api/tg-pool/${encodeURIComponent(it.id)}`, { method: "DELETE" });
      await tpLoad();
    } catch (err) { alert(err.message); }
    return;
  }

  if (e.target.closest("#tpAddBtn")) {
    const raw = prompt("Ники через запятую или с новой строки (без @):", "");
    if (!raw) return;
    const pc = prompt("ПК для них (можно пусто):", "") || "";
    const list = raw.split(/[\s,;]+/).map(s => s.trim().replace(/^@/, "")).filter(Boolean);
    for (const n of list) {
      try {
        await ctJson("/api/tg-pool", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tg_username: n, pc_name: pc.trim() }),
        });
      } catch (err) { alert(`@${n}: ${err.message}`); }
    }
    await tpLoad();
  }
});

// ── Отчёт: лиды по TG ──────────────────────────────────────
const tlr = { month: new Date().toLocaleDateString("sv-SE").slice(0, 7), data: null, filter: "" };
const TLR_WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function tlrMonthTitle() {
  const [y, m] = tlr.month.split("-").map(Number);
  return `${SCH_MONTHS[m - 1]} ${y}`;
}

function tlrAgo(iso) {
  if (!iso) return "ещё не было";
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return "только что";
  if (min < 60) return `${min} мин назад`;
  return `${Math.floor(min / 60)} ч ${min % 60} мин назад`;
}

async function tlrLoad() {
  const box = document.getElementById("tlrBody");
  const monthEl = document.getElementById("tlrMonth");
  if (monthEl) monthEl.textContent = tlrMonthTitle();
  if (!box) return;
  if (!tlr.data) box.innerHTML = '<div style="color:var(--text2);">Загрузка...</div>';
  try {
    tlr.data = await ctJson(`/api/report/tg-leads?month=${tlr.month}`);
    tlrRender();
    tlmRender();
    tlkRender();
  } catch (e) {
    box.innerHTML = `<div style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function tlrRender() {
  const d = tlr.data || {};
  const box = document.getElementById("tlrBody");
  const syncEl = document.getElementById("tlrSync");
  const syncBtn = document.getElementById("tlrSyncBtn");
  const sel = document.getElementById("tlrFilter");

  if (syncEl) {
    syncEl.className = "tlrSync" + (d.sync_error ? " bad" : "");
    syncEl.textContent = d.sync_error
      ? `Последняя синхронизация с ботом упала: ${d.sync_error}`
      : `Данные бота обновлены: ${tlrAgo(d.last_sync)} · автообновление каждые 10 минут`;
  }
  if (syncBtn) syncBtn.style.display = d.is_admin ? "" : "none";

  const all = d.rows || [];
  if (sel) {
    sel.style.display = d.is_admin ? "" : "none";
    const people = [...new Map(all.map(r => [r.user_email, r.user_name])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1], "ru"));
    sel.innerHTML = '<option value="">Все участники</option>' +
      people.map(([e, n]) => `<option value="${ctAttr(e)}">${escapeHtml(n)}</option>`).join("");
    sel.value = tlr.filter;
  }

  const rows = tlr.filter ? all.filter(r => r.user_email === tlr.filter) : all;
  if (!rows.length) {
    box.innerHTML = '<div style="color:var(--text2);margin-top:10px;">За этот месяц назначений нет.</div>';
    return;
  }

  const today = new Date().toLocaleDateString("sv-SE");
  // Одна анкета может быть закреплена за несколькими людьми — лиды у них
  // общие, поэтому считаем по паре «анкета + смена», а не по назначениям.
  const _uniq = new Map();
  rows.forEach(r => {
    const slot = r.shift === "night" ? "night" : r.shift === "day" ? "day" : "all";
    (r.contacts || []).forEach(c => {
      const k = c.tg.toLowerCase() + "|" + r.day + "|" + slot;
      _uniq.set(k, Math.max(_uniq.get(k) || 0, c.leads || 0));
    });
  });
  const _g = tlmGrand();
  const total = tlr.filter ? [..._uniq.values()].reduce((s, v) => s + v, 0) : _g.leads;
  const todayTotal = [..._uniq.entries()]
    .filter(([k]) => k.split("|")[1] === today)
    .reduce((s, [, v]) => s + v, 0);
  const tgCount = new Set(rows.flatMap(r => r.contacts.map(c => c.tg.toLowerCase()))).size;
  const stats = `
    <div class="tlrStats">
      <div class="tlrStat" style="--c:var(--cyan)"><b>${total}</b><span>лидов за месяц</span></div>
      <div class="tlrStat" style="--c:#fbbf24"><b>${todayTotal}</b><span>лидов сегодня</span></div>
      <div class="tlrStat" style="--c:#a78bfa"><b>${tgCount}</b><span>TG в работе</span></div>
      <div class="tlrStat" style="--c:#22c55e"><b>${rows.reduce((s, r) => s + (r.out?.visits || 0), 0)}</b><span>заходов за месяц</span></div>
      <div class="tlrStat"><b>${rows.length}</b><span>назначений</span></div>
    </div>`;

  const days = [...new Set(rows.map(r => r.day))].sort().reverse();
  const groups = days.map(day => {
    const list = rows.filter(r => r.day === day);
    const sum = list.reduce((s, r) => s + r.total, 0);
    const wd = TLR_WD[new Date(day + "T12:00:00").getDay()];
    const cards = list.map(r => {
      const color = SCH_TYPES[r.shift]?.color || "var(--cyan)";
      const max = Math.max(1, ...r.contacts.map(c => c.leads));
      const shiftLabel = r.shift ? `${SCH_TYPES[r.shift]?.label || r.shift} · ${r.window}` : `без смены · ${r.window}`;
      const lines = r.contacts.map(c => `
        <div class="tlrRow">
          <a class="tlrTg" href="https://t.me/${encodeURIComponent(c.tg)}" target="_blank" rel="noopener">@${escapeHtml(c.tg)}</a>
          <span class="tlrNum ${c.leads ? "" : "zero"}">${c.leads}</span>
          <div class="tlrBar"><i style="width:${Math.round(c.leads / max * 100)}%"></i></div>
          ${tlrOut(c)}
          ${tlrPlats(c.platforms)}
        </div>`).join("");
      return `
        <div class="tlrCard" style="--c:${color}">
          <div class="tlrCardHead">
            <span class="tlrName">${d.is_admin ? escapeHtml(r.user_name) : "Мои TG"}</span>
            <span class="tlrShift">${escapeHtml(shiftLabel)}</span>
          </div>
          <div class="tlrRows">${lines}</div>
          ${r.note ? `<div class="tlrNote">${escapeHtml(r.note)}</div>` : ""}
          <div class="tlrBottom"><div class="tlrFoot"><span>Итого лидов</span><b>${r.total}</b></div>${tlrOutTotal(r)}${tlrEff(r.eff)}</div>
        </div>`;
    }).join("");
    return `
      <div class="tlrDay">
        <div class="tlrDayHead ${day === today ? "today" : ""}">${ctDate(day)}, ${wd}${day === today ? " · сегодня" : ""} <em>${sum} лидов</em></div>
        <div class="tlrCards">${cards}</div>
      </div>`;
  }).join("");

  box.innerHTML = stats + tlrChart(rows) + groups;
}

function tlrLife(h) {
  if (h == null) return "—";
  if (h < 24) return `${Math.round(h)} ч`;
  const d = Math.floor(h / 24);
  return `${d} д ${Math.round(h - d * 24)} ч`;
}

const TLR_OUT = [["visits", "заходы", "#22c55e"], ["bookings", "брони", "#22d3ee"], ["cancels", "развороты", "#fb7185"]];

function tlrOut(c) {
  return `<div class="tlrOut">${TLR_OUT.map(([k, label, color]) =>
    `<span class="${c[k] == null ? "no" : ""}" style="--c:${color}"><b>${c[k] == null ? "—" : c[k]}</b><small>${label}</small></span>`
  ).join("")}</div>`;
}

function tlrOutTotal(r) {
  if (!r.has_out) return "";
  return `<div class="tlrOutTotal">${TLR_OUT.map(([k, label, color]) =>
    `<span style="--c:${color}">${label}<b>${r.out[k]}</b></span>`
  ).join("")}</div>`;
}

function tlrPlats(p) {
  const list = Object.entries(p || {});
  if (!list.length) return "";
  return `<div class="tlrPlats">${list
    .sort((a, b) => (b[1].alive + b[1].blocked) - (a[1].alive + a[1].blocked))
    .map(([plat, v]) => `<span class="tlrPlat">${escapeHtml(plat)}${v.alive ? `<b>${v.alive}</b>` : ""}${v.blocked ? `<s>+${v.blocked} блок</s>` : ""}</span>`)
    .join("")}</div>`;
}

function tlrEff(e) {
  if (!e) return "";
  return `
    <div class="tlrEff">
      <div><b class="g">${e.alive}</b><span>живых</span></div>
      <div><b class="r">${e.blocked}</b><span>в блоке</span></div>
      <div><b>${e.month}</b><span>за месяц</span></div>
      <div><span>жизнь до блока</span><b>${tlrLife(e.avg_life_hours)}</b></div>
    </div>`;
}

function tlrChart(rows) {
  const [y, m] = tlr.month.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const today = new Date().toLocaleDateString("sv-SE");
  const sums = {};
  const seen = new Map();
  rows.forEach(r => {
    const slot = r.shift === "night" ? "night" : r.shift === "day" ? "day" : "all";
    (r.contacts || []).forEach(c => {
      const k = c.tg.toLowerCase() + "|" + r.day + "|" + slot;
      if (seen.has(k)) {
        const prev = seen.get(k);
        if ((c.leads || 0) > prev) { sums[r.day] += (c.leads || 0) - prev; seen.set(k, c.leads || 0); }
        return;
      }
      seen.set(k, c.leads || 0);
      sums[r.day] = (sums[r.day] || 0) + (c.leads || 0);
    });
  });

  const pts = [];
  for (let d = 1; d <= days; d++) {
    const iso = `${tlr.month}-${String(d).padStart(2, "0")}`;
    if (iso > today) break;
    pts.push({ d, iso, v: sums[iso] || 0 });
  }
  if (pts.length < 2) return "";

  const W = 1000, H = 230, PL = 34, PR = 14, PT = 18, PB = 30;
  const max = Math.max(5, ...pts.map(p => p.v));
  const x = d => PL + (d - 1) / (days - 1) * (W - PL - PR);
  const yv = v => PT + (1 - v / max) * (H - PT - PB);

  let line = `M ${x(pts[0].d)} ${yv(pts[0].v)}`;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i];
    const cx = (x(a.d) + x(b.d)) / 2;
    line += ` C ${cx} ${yv(a.v)}, ${cx} ${yv(b.v)}, ${x(b.d)} ${yv(b.v)}`;
  }
  const last = pts[pts.length - 1];
  const area = `${line} L ${x(last.d)} ${H - PB} L ${x(pts[0].d)} ${H - PB} Z`;

  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const val = Math.round(max * i / 4);
    const gy = yv(val);
    grid += `<line class="gl" x1="${PL}" x2="${W - PR}" y1="${gy}" y2="${gy}"/><text class="ax" x="${PL - 8}" y="${gy + 4}" text-anchor="end">${val}</text>`;
  }
  let xl = "";
  for (let d = 1; d <= days; d++) {
    const iso = `${tlr.month}-${String(d).padStart(2, "0")}`;
    if (days > 20 && d % 2 === 0 && iso !== today) continue;
    xl += `<text class="ax ${iso === today ? "today" : ""}" x="${x(d)}" y="${H - 8}" text-anchor="middle">${d}</text>`;
  }

  const dots = pts.map(p =>
    `<circle class="pt" cx="${x(p.d)}" cy="${yv(p.v)}" r="3.5"><title>${ctDate(p.iso)}: ${p.v} лидов</title></circle>`
  ).join("");
  const ring = last.iso === today ? `<circle class="ring" cx="${x(last.d)}" cy="${yv(last.v)}" r="5"/>` : "";
  const best = pts.reduce((a, b) => (b.v > a.v ? b : a), pts[0]);

  return `
    <div class="tlrChart">
      <div class="tlrChartHead"><b>Лиды по дням</b><span>пик: ${best.v} · ${ctDate(best.iso)}</span></div>
      <svg viewBox="0 0 ${W} ${H}">
        <defs>
          <linearGradient id="tlrFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="#22d3ee" stop-opacity=".35"/>
            <stop offset="100%" stop-color="#a78bfa" stop-opacity="0"/>
          </linearGradient>
          <linearGradient id="tlrStroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stop-color="#22d3ee"/>
            <stop offset="100%" stop-color="#a78bfa"/>
          </linearGradient>
        </defs>
        ${grid}
        <path d="${area}" fill="url(#tlrFill)"/>
        <path class="ln" d="${line}"/>
        ${ring}${dots}${xl}
      </svg>
    </div>`;
}

function tlrShiftMonth(delta) {
  const [y, m] = tlr.month.split("-").map(Number);
  const dt = new Date(y, m - 1 + delta, 1);
  tlr.month = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
  tlr.data = null;
  tlrLoad();
}

document.getElementById("tlrPrev")?.addEventListener("click", () => tlrShiftMonth(-1));
document.getElementById("tlrNext")?.addEventListener("click", () => tlrShiftMonth(1));
document.getElementById("tlrRefreshBtn")?.addEventListener("click", tlrLoad);
document.getElementById("tlrFilter")?.addEventListener("change", e => { tlr.filter = e.target.value; tlrRender(); tlmRender(); });
document.getElementById("tlrSyncBtn")?.addEventListener("click", async e => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = "Подтягиваю...";
  try {
    await ctJson("/api/report/tg-leads/sync", { method: "POST" });
    await tlrLoad();
  } catch (err) {
    alert("Не получилось: " + err.message);
  }
  btn.disabled = false;
  btn.textContent = "Подтянуть из бота сейчас";
});

setInterval(() => {
  if (document.getElementById("analyticsPage")?.style.display === "block") tlrLoad();
}, 60000);

// ── Отчёт: месячный лист ───────────────────────────────────
const tlm = { tab: "days", edit: null, showGone: false };

function tlmGoneCount() {
  const all = (tlr.data || {}).rows || [];
  return new Set(all.filter(r => r.user_active === false).map(r => r.user_email)).size;
}

function tlmGoneBox() {
  const n = tlmGoneCount();
  if (!n) return "";
  return `<label class="tlmGone"><input type="checkbox" class="tlmGoneChk"${tlm.showGone ? " checked" : ""}>показать уволенных (${n})</label>`;
}

function tlmSwitch(tab) {
  tlm.tab = (tab === "month" || tab === "rank") ? tab : "days";
  try { localStorage.setItem("tlrTab", tlm.tab); } catch {}
  document.querySelectorAll(".tlrTab").forEach(b => b.classList.toggle("active", b.dataset.tlrtab === tlm.tab));
  Object.entries({ days: "tlrBody", month: "tlmBody", rank: "tlkBody" }).forEach(([k, id]) => {
    const el = document.getElementById(id);
    if (el) el.style.display = k === tlm.tab ? "" : "none";
  });
  if (tlm.tab === "month") tlmRender();
  if (tlm.tab === "rank") tlkRender();
}

function tlmBuild() {
  const all = (tlr.data || {}).rows || [];
  let rows = tlr.filter ? all.filter(r => r.user_email === tlr.filter) : all;
  if (!tlm.showGone) rows = rows.filter(r => r.user_active !== false);
  const map = new Map();
  rows.forEach(r => {
    const slot = r.shift === "night" ? "night" : r.shift === "day" ? "day" : "all";
    (r.contacts || []).forEach(c => {
      const key = String(c.tg).toLowerCase();
      let t = map.get(key);
      if (!t) { t = { tg: c.tg, pc: "", merged: [], owners: new Set(), cells: {} }; map.set(key, t); }
      if (c.pc) t.pc = c.pc;
      (c.merged || []).forEach(m => { if (!t.merged.includes(m)) t.merged.push(m); });
      if (r.user_name) t.owners.add(r.user_name);
      const ck = r.day + "|" + slot;
      const cell = t.cells[ck] || (t.cells[ck] = {
        leads: 0, leadsAuto: 0, leadsManual: false, manual: false, owners: [],
        visits: null, bookings: null, cancels: null, shift: r.shift || "",
      });
      if (r.user_email && !cell.owners.some(o => o.email === r.user_email)) {
        cell.owners.push({ email: r.user_email, name: r.user_name || r.user_email });
      }
      // Одна TG может быть закреплена за несколькими людьми в один день.
      // Лиды и заходы у них общие — это одна и та же анкета, поэтому берём
      // максимум, а не сумму, иначе число множится на количество назначений.
      cell.leads = Math.max(cell.leads, c.leads || 0);
      cell.leadsAuto = Math.max(cell.leadsAuto, c.leads_auto == null ? (c.leads || 0) : c.leads_auto);
      if (c.leads_manual) cell.leadsManual = true;
      if (c.manual) cell.manual = true;
      ["visits", "bookings", "cancels"].forEach(k => {
        if (c[k] != null) cell[k] = Math.max(cell[k] == null ? 0 : cell[k], c[k]);
      });
    });
  });
  // Клетки, вписанные вручную там, где назначения не было
  if (!tlr.filter) ((tlr.data || {}).extras || []).forEach(x => {
    const key = String(x.tg).toLowerCase();
    let t = map.get(key);
    if (!t) { t = { tg: x.tg, pc: x.pc || "", merged: [], owners: new Set(), cells: {} }; map.set(key, t); }
    const slot = x.shift === "night" ? "night" : "day";
    const ck = x.day + "|" + slot;
    if (t.cells[ck]) return;
    t.cells[ck] = {
      owners: [],
      leads: x.leads || 0, leadsAuto: 0, leadsManual: !!x.leads_manual, manual: true,
      visits: x.visits == null ? null : x.visits,
      bookings: x.bookings == null ? null : x.bookings,
      cancels: x.cancels == null ? null : x.cancels,
      shift: x.shift || "", own: true,
    };
  });
  return [...map.values()].sort((x, y) => x.tg.localeCompare(y.tg, "ru"));
}

const TLM_COLORS = ["#2ad4ee", "#fbbf24", "#a78bfa", "#34d399", "#f472b6",
                    "#60a5fa", "#fb923c", "#4ade80", "#e879f9", "#facc15"];

function tlmColor(key) {
  let h = 0;
  for (let i = 0; i < String(key).length; i++) h = (h * 31 + String(key).charCodeAt(i)) >>> 0;
  return TLM_COLORS[h % TLM_COLORS.length];
}

function tlmWho(c) {
  return (c && c.owners || []).map(o => o.name).join(", ");
}

const TLM_SLOTS = { day: ["Д", "день"], night: ["Н", "ночь"], all: ["24", "сутки — смена не указана в Графике"] };

function tlmNode(t, is, slot) {
  const c = t.cells[is + "|" + slot];
  const L = (TLM_SLOTS[slot] || ["?", ""])[0];
  if (!c) {
    if (slot === "all") return "";
    return `<div class="tlmNode off" data-tg="${ctAttr(t.tg)}" data-day="${is}" data-slot="${slot}" data-shift="${slot}" title="Смены не было — клик, чтобы вписать вручную"><s>${L}</s><b>+</b></div>`;
  }
  const o = [c.visits, c.bookings, c.cancels].map(v => v == null ? "—" : v).join("·");
  const own = c.owners || [];
  const col = own.length ? tlmColor(own[0].email) : "transparent";
  const who = tlmWho(c) || "сотрудник не указан";
  return `<div class="tlmNode ${slot}${c.manual || c.leadsManual ? " man" : ""}" style="--o:${col}"` +
    ` data-tg="${ctAttr(t.tg)}" data-day="${is}" data-slot="${slot}" data-shift="${ctAttr(c.shift)}"` +
    ` title="${ctAttr(who)} · @${ctAttr(t.tg)} · ${is} · ${(TLM_SLOTS[slot] || ["", ""])[1]} — клик, чтобы вписать вручную">` +
    `<s>${L}</s><b>${c.leads}</b><i>${o}</i></div>`;
}

function tlmRender() {
  const box = document.getElementById("tlmBody");
  if (!box || tlm.tab !== "month") return;
  if (!tlr.data) { box.innerHTML = '<div style="color:var(--text2);">Загрузка...</div>'; return; }

  const [y, m] = tlr.month.split("-").map(Number);
  const dim = new Date(y, m, 0).getDate();
  const today = new Date().toLocaleDateString("sv-SE");
  const iso = dd => `${tlr.month}-${String(dd).padStart(2, "0")}`;
  const list = tlmBuild();
  if (!list.length) {
    box.innerHTML = '<div style="color:var(--text2);margin-top:10px;">За этот месяц данных нет.</div>';
    return;
  }

  const cols = `200px repeat(${dim}, 64px) 92px`;
  const sum = { leads: 0, visits: 0, bookings: 0, cancels: 0 };
  const byDay = {};

  const head = `<div class="tlmRow tlmHead" style="grid-template-columns:${cols}">` +
    `<div class="tlmCell tlmName"><b>TG</b><span>сотрудник</span></div>` +
    Array.from({ length: dim }, (_, i) => {
      const is = iso(i + 1);
      return `<div class="tlmCell tlmHd${is === today ? " now" : ""}"><b>${i + 1}</b><span>${TLR_WD[new Date(is + "T12:00:00").getDay()]}</span></div>`;
    }).join("") +
    `<div class="tlmCell tlmHd"><b>Итого</b><span>л / з·б·р</span></div></div>`;

  const body = list.map(t => {
    const tot = { leads: 0, visits: 0, bookings: 0, cancels: 0 };
    Object.entries(t.cells).forEach(([k, c]) => {
      tot.leads += c.leads; tot.visits += c.visits || 0;
      tot.bookings += c.bookings || 0; tot.cancels += c.cancels || 0;
      const day = k.split("|")[0];
      byDay[day] = (byDay[day] || 0) + c.leads;
    });
    sum.leads += tot.leads; sum.visits += tot.visits;
    sum.bookings += tot.bookings; sum.cancels += tot.cancels;
    const cells = Array.from({ length: dim }, (_, i) => {
      const is = iso(i + 1);
      return `<div class="tlmCell tlmDay${is === today ? " now" : ""}">${tlmNode(t, is, "day")}${tlmNode(t, is, "night")}${tlmNode(t, is, "all")}</div>`;
    }).join("");
    return `<div class="tlmRow" style="grid-template-columns:${cols}">` +
      `<div class="tlmCell tlmName" data-tgname="${ctAttr(t.tg)}" data-pc="${ctAttr(t.pc || "")}" title="Клик — указать ПК или заменить ник">
        <div class="tlmTop"><b>@${escapeHtml(t.tg)}</b><span class="tlmPc${t.pc ? "" : " none"}">${escapeHtml(t.pc || "ПК?")}</span></div>
        <span>${escapeHtml([...t.owners].join(", ") || "—")}${t.merged.length ? ` · был @${escapeHtml(t.merged.join(", @"))}` : ""}</span></div>` +
      cells +
      `<div class="tlmCell tlmTot"><b>${tot.leads}</b><i>${tot.visits}·${tot.bookings}·${tot.cancels}</i></div></div>`;
  }).join("");

  const foot = `<div class="tlmRow tlmFootRow" style="grid-template-columns:${cols}">` +
    `<div class="tlmCell tlmName"><b>Всего за день</b></div>` +
    Array.from({ length: dim }, (_, i) => {
      const v = byDay[iso(i + 1)] || 0;
      return `<div class="tlmCell tlmDaySum${v ? "" : " zero"}">${v}</div>`;
    }).join("") +
    `<div class="tlmCell tlmTot"><b>${sum.leads}</b><i>${sum.visits}·${sum.bookings}·${sum.cancels}</i></div></div>`;

  const per = tlmPeople(list);
  tlm.per = per;

  const who = [...per.entries()].sort((a, b) => b[1].leads - a[1].leads)
    .map(([e, p]) => `<span class="tlmWhoChip" data-email="${ctAttr(e)}" title="Клик — разбор по сменам">` +
      `<em style="background:${tlmColor(e)}"></em>${escapeHtml(p.name)}<b>${p.leads}</b>` +
      `${p.v || p.b || p.c ? `<i>${p.v}·${p.b}·${p.c}</i>` : ""}</span>`).join("");

  const g = tlmGrand();
  const onePerson = !!tlr.filter;
  const S = onePerson
    ? { leads: sum.leads, v: sum.visits, b: sum.bookings, c: sum.cancels, n: list.length }
    : { leads: g.leads, v: g.v, b: g.b, c: g.c, n: g.tgs.size };
  const gap = g.leads - sum.leads;
  const note = (!onePerson && gap > 0)
    ? `<div style="margin:-4px 0 14px;font-size:11.5px;color:var(--text2);line-height:1.5;">
         Всего пришло на анкеты — <b style="color:var(--text)">${g.leads}</b>.
         Закреплено за сотрудниками — <b style="color:var(--text)">${sum.leads}</b>,
         остальные <b style="color:var(--text)">${gap}</b> пришли в смены, которые никому не назначены${tlm.showGone ? "" : ", либо принадлежали уволенным"}.
       </div>`
    : "";

  box.innerHTML = `
    <div class="tlrStats" style="margin-bottom:14px;">
      <div class="tlrStat" style="--c:var(--cyan)"><b>${S.leads}</b><span>лидов${onePerson ? " у сотрудника" : " за месяц"}</span></div>
      <div class="tlrStat" style="--c:#22c55e"><b>${S.v}</b><span>заходов</span></div>
      <div class="tlrStat" style="--c:#22d3ee"><b>${S.b}</b><span>броней</span></div>
      <div class="tlrStat" style="--c:#fb7185"><b>${S.c}</b><span>разворотов</span></div>
      <div class="tlrStat" style="--c:#a78bfa"><b>${S.n}</b><span>TG в работе</span></div>
    </div>
    ${note}
    <div class="tlmLegend">
      <span><em class="d"></em>Д — день</span>
      <span><em class="n"></em>Н — ночь</span>
      <span><em class="m"></em>вписано вручную</span>
      <span>в ноде: лиды, справа заходы·брони·развороты</span>
    </div>
    <div class="tlmLegend tlmWho">${who || '<span style="opacity:.6;">сотрудники не определены</span>'}${tlmGoneBox()}</div>
    <div class="tlmWrap"><div class="tlmGrid">${head}${body}${foot}</div></div>`;
}

function tlmOpenEdit(n) {
  tlm.edit = { tg: n.dataset.tg, day: n.dataset.day, shift: n.dataset.shift || "", slot: n.dataset.slot };
  const t = tlmBuild().find(x => x.tg.toLowerCase() === tlm.edit.tg.toLowerCase());
  const c = t ? t.cells[tlm.edit.day + "|" + tlm.edit.slot] : null;
  const set = (id, v, ph) => {
    const el = document.getElementById(id);
    el.value = v == null ? "" : v;
    if (ph != null) el.placeholder = ph;
  };
  const w = tlmWho(c);
  document.getElementById("tlmEditTitle").textContent =
    `@${tlm.edit.tg} · ${ctDate(tlm.edit.day)} · ${(TLM_SLOTS[tlm.edit.slot] || ["", ""])[1]}` + (w ? ` · ${w}` : "");
  set("tlmEditLeads", c && c.leadsManual ? c.leads : null, c ? c.leadsAuto : 0);
  set("tlmEditVisits", c ? c.visits : null, "0");
  set("tlmEditBookings", c ? c.bookings : null, "0");
  set("tlmEditCancels", c ? c.cancels : null, "0");
  document.getElementById("tlmEditResult").textContent = "";
  document.getElementById("tlmEditModal")?.classList.add("open");
}

function tlmClose() { document.getElementById("tlmEditModal")?.classList.remove("open"); }

async function tlmSave(reset) {
  if (!tlm.edit) return;
  const num = id => {
    const v = (document.getElementById(id).value || "").trim();
    return v === "" ? null : Math.max(0, parseInt(v, 10) || 0);
  };
  const res = document.getElementById("tlmEditResult");
  res.style.color = "var(--text2)";
  res.textContent = "Сохраняю...";
  try {
    await ctJson("/api/report/tg-outcomes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tg_username: tlm.edit.tg,
        day: tlm.edit.day,
        shift: tlm.edit.shift,
        leads: reset ? null : num("tlmEditLeads"),
        visits: reset ? null : num("tlmEditVisits"),
        bookings: reset ? null : num("tlmEditBookings"),
        cancels: reset ? null : num("tlmEditCancels"),
      }),
    });
    tlmClose();
    await tlrLoad();
  } catch (err) {
    res.style.color = "#fb7185";
    res.textContent = "Ошибка: " + err.message;
  }
}

document.querySelectorAll(".tlrTab").forEach(b =>
  b.addEventListener("click", () => tlmSwitch(b.dataset.tlrtab)));
document.getElementById("tlmBody")?.addEventListener("click", e => {
  const chip = e.target.closest(".tlmWhoChip[data-email]");
  if (chip) { tlmOpenWho(chip.dataset.email); return; }
  const nm = e.target.closest(".tlmName[data-tgname]");
  if (nm) { tlmOpenTg(nm.dataset.tgname, nm.dataset.pc); return; }
  const n = e.target.closest(".tlmNode");
  if (n) tlmOpenEdit(n);
});

function tlmOpenTg(tg, pc) {
  tlm.tg = tg;
  document.getElementById("tlmTgTitle").textContent = "@" + tg;
  document.getElementById("tlmTgPc").value = pc || "";
  document.getElementById("tlmTgNext").value = "";
  document.getElementById("tlmTgResult").textContent = "";
  document.getElementById("tlmTgModal")?.classList.add("open");
}

async function tlmTgSave() {
  if (!tlm.tg) return;
  const res = document.getElementById("tlmTgResult");
  res.style.color = "var(--text2)";
  res.textContent = "Сохраняю...";
  try {
    await ctJson("/api/report/tg-registry", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tg_username: tlm.tg,
        label: tlm.tg,
        pc_name: document.getElementById("tlmTgPc").value.trim(),
        replaced_by: document.getElementById("tlmTgNext").value.trim() || null,
      }),
    });
    document.getElementById("tlmTgModal")?.classList.remove("open");
    await tlrLoad();
  } catch (err) {
    res.style.color = "#fb7185";
    res.textContent = "Ошибка: " + err.message;
  }
}

document.getElementById("tlmTgClose")?.addEventListener("click", () =>
  document.getElementById("tlmTgModal")?.classList.remove("open"));
document.getElementById("tlmTgModal")?.addEventListener("click", e => {
  if (e.target.id === "tlmTgModal") e.target.classList.remove("open");
});
document.getElementById("tlmTgSave")?.addEventListener("click", tlmTgSave);

function tlmOpenWho(email) {
  const p = tlm.per && tlm.per.get(email);
  if (!p) return;
  tlm.whoEmail = email;
  const rows = p.rows.slice().sort((a, b) =>
    a.day.localeCompare(b.day) || a.slot.localeCompare(b.slot) || a.tg.localeCompare(b.tg));
  const n = v => v == null ? "—" : v;
  document.getElementById("tlmWhoTitle").textContent = p.name;
  document.getElementById("tlmWhoBody").innerHTML = `
    <div class="tlmWhoSum">
      <span style="--c:var(--cyan)">лиды<b>${p.leads}</b></span>
      <span style="--c:#22c55e">заходы<b>${p.v}</b></span>
      <span style="--c:#22d3ee">брони<b>${p.b}</b></span>
      <span style="--c:#fb7185">развороты<b>${p.c}</b></span>
      <span>смен<b>${p.shifts.size}</b></span>
      <span>TG<b>${p.tgs.size}</b></span>
      <span>строк<b>${rows.length}</b></span>
    </div>
    <table class="tlmWhoTbl">
      <thead><tr><th>Дата</th><th>Смена</th><th>TG</th><th>ПК</th><th>Л</th><th>З</th><th>Б</th><th>Р</th></tr></thead>
      <tbody>${rows.map(r => `<tr>
        <td>${ctDate(r.day)}</td>
        <td>${(TLM_SLOTS[r.slot] || ["", ""])[1]}</td>
        <td class="m">@${escapeHtml(r.tg)}</td>
        <td class="m">${escapeHtml(r.pc || "—")}</td>
        <td class="n">${r.leads}</td><td class="n">${n(r.v)}</td>
        <td class="n">${n(r.b)}</td><td class="n">${n(r.c)}</td>
      </tr>`).join("")}</tbody>
    </table>`;
  document.getElementById("tlmWhoModal")?.classList.add("open");
}

function tlmWhoExport() {
  const p = tlm.per && tlm.per.get(tlm.whoEmail);
  if (!p) return;
  const rows = p.rows.slice().sort((a, b) =>
    a.day.localeCompare(b.day) || a.slot.localeCompare(b.slot) || a.tg.localeCompare(b.tg));
  const esc = v => {
    const s = String(v == null ? "" : v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const line = a => a.map(esc).join(";");
  const dmy = iso => iso.split("-").reverse().join(".");
  const n = v => v == null ? "" : v;

  const out = [
    line([`Отчёт по сотруднику: ${p.name}`]),
    line([`Период: ${tlrMonthTitle()}`]),
    line([`Выгружено: ${new Date().toLocaleString("ru-RU")}`]),
    "",
    line(["Лиды", "Заходы", "Брони", "Развороты", "Смен", "TG в работе"]),
    line([p.leads, p.v, p.b, p.c, p.shifts.size, p.tgs.size]),
    "",
    line(["Дата", "Смена", "TG", "ПК", "Лиды", "Заходы", "Брони", "Развороты"]),
    ...rows.map(r => line([
      dmy(r.day), (TLM_SLOTS[r.slot] || ["", ""])[1], "@" + r.tg, r.pc || "",
      r.leads, n(r.v), n(r.b), n(r.c),
    ])),
    "",
    line(["ИТОГО", "", "", "", p.leads, p.v, p.b, p.c]),
  ].join("\r\n");

  const name = `${p.name}_${tlr.month}.csv`.replace(/[\\/:*?"<>|]/g, "_");
  const url = URL.createObjectURL(new Blob(["\uFEFF" + out], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function tlmWhoPdf() {
  const p = tlm.per && tlm.per.get(tlm.whoEmail);
  if (!p) return;
  const e = escapeHtml;
  const dmy = iso => iso.split("-").reverse().join(".");
  const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const n = v => v == null ? "—" : v;
  const rows = p.rows.slice().sort((a, b) =>
    a.day.localeCompare(b.day) || a.slot.localeCompare(b.slot) || a.tg.localeCompare(b.tg));

  // Сводка по дням
  const byDay = new Map();
  rows.forEach(r => {
    const k = r.day + "|" + r.slot;
    let d = byDay.get(k);
    if (!d) byDay.set(k, d = { day: r.day, slot: r.slot, tgs: 0, leads: 0, v: 0, b: 0, c: 0 });
    d.tgs++; d.leads += r.leads;
    d.v += r.v || 0; d.b += r.b || 0; d.c += r.c || 0;
  });

  // Сводка по анкетам
  const byTg = new Map();
  rows.forEach(r => {
    let t = byTg.get(r.tg);
    if (!t) byTg.set(r.tg, t = { tg: r.tg, pc: r.pc, shifts: 0, leads: 0, v: 0, b: 0, c: 0 });
    t.shifts++; t.leads += r.leads;
    t.v += r.v || 0; t.b += r.b || 0; t.c += r.c || 0;
  });
  const tgList = [...byTg.values()].sort((a, b) => b.leads - a.leads);
  const maxTg = Math.max(1, ...tgList.map(t => t.leads));

  const kpi = [
    ["Лидов", p.leads, "#0a6fb5"],
    ["Заходов", p.v, "#128a4a"],
    ["Броней", p.b, "#0a7f8c"],
    ["Разворотов", p.c, "#b4304a"],
    ["Смен", p.shifts.size, "#444"],
    ["Анкет", p.tgs.size, "#444"],
    ["Лид / смена", p.shifts.size ? Math.round(p.leads / p.shifts.size * 10) / 10 : 0, "#444"],
  ];

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>${e(p.name)} — ${e(tlrMonthTitle())}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: "Segoe UI", Roboto, Arial, sans-serif; color:#15171c; background:#fff; font-size:11px; }
  .hd { border-bottom:2px solid #15171c; padding-bottom:12px; margin-bottom:16px; display:flex; align-items:flex-end; gap:16px; }
  .hd h1 { margin:0; font-size:13px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:#6b7280; }
  .hd .nm { font-size:26px; font-weight:700; line-height:1.1; margin-top:4px; }
  .hd .meta { margin-left:auto; text-align:right; font-size:10.5px; color:#6b7280; line-height:1.6; }
  .kpi { display:grid; grid-template-columns:repeat(7,1fr); gap:7px; margin-bottom:20px; }
  .kpi div { border:1px solid #dfe3e8; border-radius:7px; padding:9px 8px; text-align:center; }
  .kpi b { display:block; font-size:21px; line-height:1.15; color:var(--c); font-variant-numeric:tabular-nums; }
  .kpi span { font-size:8.5px; text-transform:uppercase; letter-spacing:.05em; color:#6b7280; }
  h2 { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:.1em; color:#6b7280;
       margin:20px 0 8px; padding-bottom:5px; border-bottom:1px solid #dfe3e8; }
  table { width:100%; border-collapse:collapse; }
  thead { display:table-header-group; }
  th { font-size:8.5px; text-transform:uppercase; letter-spacing:.05em; color:#6b7280; font-weight:700;
       text-align:right; padding:6px 7px; border-bottom:1px solid #c9ced6; white-space:nowrap; }
  th:first-child, th.l { text-align:left; }
  td { padding:5px 7px; border-bottom:1px solid #eef0f3; text-align:right;
       font-variant-numeric:tabular-nums; white-space:nowrap; }
  td.l { text-align:left; }
  tr { page-break-inside:avoid; }
  tbody tr:nth-child(even) td { background:#fafbfc; }
  .dim { color:#9aa1ab; }
  .sh { display:inline-block; min-width:46px; padding:1px 7px; border-radius:9px; font-size:9px; font-weight:700; }
  .sh.d { background:#fff3d6; color:#8a5a00; }
  .sh.n { background:#eae6ff; color:#4c35b0; }
  .sh.a { background:#eef0f3; color:#6b7280; }
  .bar { height:5px; background:#eef0f3; border-radius:3px; overflow:hidden; min-width:60px; }
  .bar i { display:block; height:100%; background:#0a6fb5; }
  tfoot td { font-weight:700; border-top:2px solid #15171c; border-bottom:none; padding-top:7px; }
  .ft { margin-top:22px; padding-top:9px; border-top:1px solid #dfe3e8;
        font-size:9px; color:#9aa1ab; display:flex; justify-content:space-between; }
  @media print { .noprint { display:none; } }
  .noprint { position:fixed; top:10px; right:10px; }
  .noprint button { font-size:13px; padding:8px 16px; cursor:pointer; }
</style></head><body>
<div class="noprint"><button onclick="window.print()">Печать / Сохранить в PDF</button></div>

<div class="hd">
  <div>
    <h1>Отчёт по сотруднику</h1>
    <div class="nm">${e(p.name)}</div>
  </div>
  <div class="meta">
    Период: <b>${e(tlrMonthTitle())}</b><br>
    Сформирован: ${new Date().toLocaleString("ru-RU")}<br>
    CLAW-AI
  </div>
</div>

<div class="kpi">${kpi.map(([l, v, c]) =>
  `<div style="--c:${c}"><b>${v}</b><span>${l}</span></div>`).join("")}</div>

<h2>По анкетам</h2>
<table>
  <thead><tr><th class="l">TG</th><th class="l">ПК</th><th>Смен</th><th>Лиды</th>
    <th>Заходы</th><th>Брони</th><th>Развороты</th><th class="l" style="width:90px;">Доля</th></tr></thead>
  <tbody>${tgList.map(t => `<tr>
    <td class="l"><b>@${e(t.tg)}</b></td><td class="l">${e(t.pc || "—")}</td>
    <td>${t.shifts}</td><td><b>${t.leads}</b></td>
    <td class="${t.v ? "" : "dim"}">${t.v}</td><td class="${t.b ? "" : "dim"}">${t.b}</td>
    <td class="${t.c ? "" : "dim"}">${t.c}</td>
    <td><div class="bar"><i style="width:${Math.round(t.leads / maxTg * 100)}%"></i></div></td>
  </tr>`).join("")}</tbody>
  <tfoot><tr><td class="l">Итого</td><td></td><td>${p.shifts.size}</td><td>${p.leads}</td>
    <td>${p.v}</td><td>${p.b}</td><td>${p.c}</td><td></td></tr></tfoot>
</table>

<h2>По сменам</h2>
<table>
  <thead><tr><th class="l">Дата</th><th class="l">Смена</th><th>Анкет</th><th>Лиды</th>
    <th>Заходы</th><th>Брони</th><th>Развороты</th></tr></thead>
  <tbody>${[...byDay.values()].map(d => {
    const cls = d.slot === "day" ? "d" : d.slot === "night" ? "n" : "a";
    const lbl = d.slot === "day" ? "день" : d.slot === "night" ? "ночь" : "сутки";
    return `<tr>
      <td class="l">${dmy(d.day)}, ${WD[new Date(d.day + "T12:00:00").getDay()]}</td>
      <td class="l"><span class="sh ${cls}">${lbl}</span></td>
      <td>${d.tgs}</td><td><b>${d.leads}</b></td>
      <td class="${d.v ? "" : "dim"}">${d.v}</td><td class="${d.b ? "" : "dim"}">${d.b}</td>
      <td class="${d.c ? "" : "dim"}">${d.c}</td></tr>`;
  }).join("")}</tbody>
</table>

<h2>Детализация</h2>
<table>
  <thead><tr><th class="l">Дата</th><th class="l">Смена</th><th class="l">TG</th><th class="l">ПК</th>
    <th>Лиды</th><th>Заходы</th><th>Брони</th><th>Развороты</th></tr></thead>
  <tbody>${rows.map(r => {
    const cls = r.slot === "day" ? "d" : r.slot === "night" ? "n" : "a";
    const lbl = r.slot === "day" ? "день" : r.slot === "night" ? "ночь" : "сутки";
    return `<tr>
      <td class="l">${dmy(r.day)}</td>
      <td class="l"><span class="sh ${cls}">${lbl}</span></td>
      <td class="l">@${e(r.tg)}</td><td class="l">${e(r.pc || "—")}</td>
      <td>${r.leads}</td><td>${n(r.v)}</td><td>${n(r.b)}</td><td>${n(r.c)}</td></tr>`;
  }).join("")}</tbody>
  <tfoot><tr><td class="l">Итого</td><td></td><td></td><td></td>
    <td>${p.leads}</td><td>${p.v}</td><td>${p.b}</td><td>${p.c}</td></tr></tfoot>
</table>

<div class="ft"><span>CLAW-AI · отчёт по сотруднику ${e(p.name)}</span>
  <span>Прочерк — показатель не вносился</span></div>
</body></html>`;

  const w = window.open("", "_blank");
  if (!w) { alert("Браузер заблокировал окно. Разреши всплывающие окна для этого сайта."); return; }
  w.document.write(html);
  w.document.close();
  w.onload = () => setTimeout(() => w.print(), 250);
}

document.getElementById("tlmWhoPdf")?.addEventListener("click", tlmWhoPdf);
document.getElementById("tlmWhoExport")?.addEventListener("click", tlmWhoExport);
document.getElementById("tlmWhoClose")?.addEventListener("click", () =>
  document.getElementById("tlmWhoModal")?.classList.remove("open"));
document.getElementById("tlmWhoModal")?.addEventListener("click", e => {
  if (e.target.id === "tlmWhoModal") e.target.classList.remove("open");
});

// ── Рейтинг сотрудников ────────────────────────────────────
function tlmPeople(list) {
  list = list || tlmBuild();
  const per = new Map();
  list.forEach(t => Object.entries(t.cells).forEach(([k, c]) => {
    const [cday, cslot] = k.split("|");
    (c.owners || []).forEach(o => {
      let p = per.get(o.email);
      if (!p) per.set(o.email, p = {
        email: o.email, name: o.name, leads: 0, v: 0, b: 0, c: 0,
        rows: [], shifts: new Set(), tgs: new Set(),
      });
      p.leads += c.leads;
      p.v += c.visits || 0; p.b += c.bookings || 0; p.c += c.cancels || 0;
      p.shifts.add(cday + "|" + cslot);
      p.tgs.add(t.tg.toLowerCase());
      p.rows.push({ day: cday, slot: cslot, tg: t.tg, pc: t.pc || "",
                    leads: c.leads, v: c.visits, b: c.bookings, c: c.cancels });
    });
  }));
  return per;
}

// Истинный итог по анкетам: что реально пришло, вне зависимости от того,
// была смена кому-то назначена или нет. Фильтры на него не влияют.
function tlmGrand() {
  const u = new Map();
  const add = (tg, day, slot, c) => {
    const k = String(tg).toLowerCase() + "|" + day + "|" + slot;
    const p = u.get(k) || { leads: 0, v: 0, b: 0, c: 0 };
    u.set(k, {
      leads: Math.max(p.leads, c.leads || 0),
      v: Math.max(p.v, c.visits || 0),
      b: Math.max(p.b, c.bookings || 0),
      c: Math.max(p.c, c.cancels || 0),
    });
  };
  const slotOf = s => s === "night" ? "night" : s === "day" ? "day" : "all";
  ((tlr.data || {}).rows || []).forEach(r =>
    (r.contacts || []).forEach(c => add(c.tg, r.day, slotOf(r.shift), c)));
  ((tlr.data || {}).extras || []).forEach(x =>
    add(x.tg, x.day, slotOf(x.shift), x));

  const g = { leads: 0, v: 0, b: 0, c: 0, tgs: new Set() };
  u.forEach((v, k) => {
    g.leads += v.leads; g.v += v.v; g.b += v.b; g.c += v.c;
    g.tgs.add(k.split("|")[0]);
  });
  return g;
}

const tlk = { sort: "leads" };
const TLK_COLS = [
  ["shifts", "Смен"], ["leads", "Лиды"], ["avg", "Лид/смена"],
  ["tgs", "TG"], ["v", "Заходы"], ["b", "Брони"], ["c", "Развороты"],
];

function tlkRender() {
  const box = document.getElementById("tlkBody");
  if (!box || tlm.tab !== "rank") return;
  if (!tlr.data) { box.innerHTML = '<div style="color:var(--text2);">Загрузка...</div>'; return; }

  const arr = [...tlmPeople().values()].map(p => ({
    ...p,
    shifts: p.shifts.size,
    tgs: p.tgs.size,
    avg: p.shifts.size ? Math.round(p.leads / p.shifts.size * 10) / 10 : 0,
  }));
  if (!arr.length) {
    box.innerHTML = '<div style="color:var(--text2);margin-top:10px;">За этот месяц данных нет.</div>';
    return;
  }

  const k = tlk.sort;
  arr.sort((a, b) => (b[k] || 0) - (a[k] || 0) || b.leads - a.leads);
  const max = Math.max(1, ...arr.map(x => x.leads));
  const best = [...arr].sort((a, b) => b.leads - a.leads)[0];
  const MED = ["🥇", "🥈", "🥉"];
  const z = v => v ? v : '<span class="tlkZero">0</span>';

  const hero = `
    <div class="tlkHero">
      <div class="tlkCrown">🏆</div>
      <div>
        <div class="tlkHeroName"><em style="background:${tlmColor(best.email)}"></em>${escapeHtml(best.name)}</div>
        <div class="tlkHeroSub">лучший за ${escapeHtml(tlrMonthTitle())} · ${best.tgs} TG в работе</div>
      </div>
      <div class="tlkHeroNums">
        <div style="--c:var(--cyan)"><b>${best.leads}</b><span>лидов</span></div>
        <div><b>${best.shifts}</b><span>смен</span></div>
        <div><b>${best.avg}</b><span>лид/смена</span></div>
        <div style="--c:#22c55e"><b>${best.v}</b><span>заходов</span></div>
        <div style="--c:#22d3ee"><b>${best.b}</b><span>броней</span></div>
      </div>
    </div>`;

  const head = `<tr><th></th><th>Сотрудник</th>` +
    TLK_COLS.map(([key, label]) =>
      `<th class="${k === key ? "on" : ""}" data-tlksort="${key}">${label}${k === key ? " ↓" : ""}</th>`).join("") +
    `<th style="width:110px;">Доля</th></tr>`;

  const body = arr.map((p, i) => `
    <tr class="${i < 3 ? "top" + (i + 1) : ""}">
      <td class="pos">${i < 3 ? MED[i] : i + 1}</td>
      <td class="nm" data-email="${ctAttr(p.email)}"><em style="background:${tlmColor(p.email)}"></em>${escapeHtml(p.name)}</td>
      <td>${p.shifts}</td>
      <td><b>${p.leads}</b></td>
      <td>${p.avg}</td>
      <td>${p.tgs}</td>
      <td>${z(p.v)}</td>
      <td>${z(p.b)}</td>
      <td>${z(p.c)}</td>
      <td><div class="tlkBar"><i style="width:${Math.round(p.leads / max * 100)}%"></i></div></td>
    </tr>`).join("");

  box.innerHTML = hero +
    `<div class="tlkWrap"><table class="tlkTbl"><thead>${head}</thead><tbody>${body}</tbody></table></div>
     <div style="margin-top:10px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;font-size:11.5px;color:var(--text2);">
       <span>Клик по заголовку столбца — сортировка. Клик по имени — разбор по сменам.</span>
       ${tlmGoneBox()}
     </div>`;
}

document.addEventListener("change", e => {
  if (!e.target.classList?.contains("tlmGoneChk")) return;
  tlm.showGone = e.target.checked;
  tlmRender();
  tlkRender();
});

document.getElementById("tlkBody")?.addEventListener("click", e => {
  const th = e.target.closest("[data-tlksort]");
  if (th) { tlk.sort = th.dataset.tlksort; tlkRender(); return; }
  const nm = e.target.closest(".nm[data-email]");
  if (nm) tlmOpenWho(nm.dataset.email);
});
document.getElementById("tlmEditClose")?.addEventListener("click", tlmClose);
document.getElementById("tlmEditModal")?.addEventListener("click", e => {
  if (e.target.id === "tlmEditModal") tlmClose();
});
document.getElementById("tlmEditSave")?.addEventListener("click", () => tlmSave(false));
document.getElementById("tlmEditReset")?.addEventListener("click", () => tlmSave(true));
try { if (localStorage.getItem("tlrTab") === "month") tlmSwitch("month"); } catch {}

// ── График смен ────────────────────────────────────────────
const SCH_TYPES = {
  day:   { short: "Д", label: "Дневная",  time: "09:00–21:00", color: "#fbbf24" },
  night: { short: "Н", label: "Ночная",   time: "21:00–09:00", color: "#a78bfa" },
  off:   { short: "В", label: "Выходной", time: "",            color: "#34d399" },
  training: { short: "С", label: "Стажировка", time: "",       color: "#f472b6" },
};
const SCH_ICON = {
  day:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  night: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>',
  off:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M17 8h1a4 4 0 0 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4z"/><path d="M6 2v3M10 2v3M14 2v3"/></svg>',
  training: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M22 10L12 5 2 10l10 5 10-5z"/><path d="M6 12v5c3 2 9 2 12 0v-5"/></svg>',
  next:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
};
const SCH_MONTHS = ["Январь", "Февраль", "Март", "Апрель", "Май", "Июнь", "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"];
const SCH_WD = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const sch = {
  month: new Date().toLocaleDateString("sv-SE").slice(0, 7),
  isAdmin: null, users: [], map: {}, tool: "day",
  painting: false, paintValue: "", pending: new Map(),
  att: {}, attPending: new Map(), paintMode: "shift",
};

const schDays = () => { const [y, m] = sch.month.split("-").map(Number); return new Date(y, m, 0).getDate(); };
const schIso = d => `${sch.month}-${String(d).padStart(2, "0")}`;
const schWday = d => { const [y, m] = sch.month.split("-").map(Number); return (new Date(y, m - 1, d).getDay() + 6) % 7; };
const schTitle = () => { const [y, m] = sch.month.split("-").map(Number); return `${SCH_MONTHS[m - 1]} ${y}`; };

function schStatus(text, color) {
  const st = document.getElementById("schSaveStatus");
  if (!st) return;
  st.style.color = color || "var(--text2)";
  st.textContent = text;
}

async function loadSchedule() {
  const box = document.getElementById("schBody");
  const titleEl = document.getElementById("schMonthTitle");
  if (titleEl) titleEl.textContent = schTitle();
  if (!box) return;
  if (sch.isAdmin === null) {
    try { sch.isAdmin = !!(await ctJson("/api/auth/me")).is_admin; } catch { sch.isAdmin = false; }
  }
  const tools = document.getElementById("schAdminTools");
  if (tools) tools.style.display = sch.isAdmin ? "" : "none";
  box.innerHTML = '<div style="color:var(--text2);">Загрузка...</div>';
  try {
    if (sch.isAdmin) {
      const data = await ctJson(`/api/admin/shifts?month=${sch.month}`);
      sch.allUsers = data.users || [];
      sch.users = sch.allUsers.filter(u => !u.schedule_hidden);
      sch.map = {};
      sch.att = {};
      (data.shifts || []).forEach(s => {
        const k = `${s.user_email}|${String(s.day).slice(0, 10)}`;
        sch.map[k] = s.shift;
        if (s.attendance) sch.att[k] = s.attendance;
      });
      renderScheduleGrid();
      schStatus("Смены: выбери тип и кликай или веди мышкой по клеткам. Явка: выбери «Вышел» или «Не вышел» и отмечай смены. Повторный клик тем же инструментом снимает отметку.");
    } else {
      const data = await ctJson(`/api/my/shifts?month=${sch.month}`);
      renderMySchedule(data.shifts || []);
      schStatus("");
      if (typeof loadNotifications === "function") loadNotifications();
    }
  } catch (e) {
    box.innerHTML = `<div style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function schSum(email) {
  let d = 0, n = 0;
  for (let i = 1; i <= schDays(); i++) {
    const t = sch.map[`${email}|${schIso(i)}`];
    if (t === "day") d++;
    if (t === "night") n++;
  }
  return `<span style="color:#fbbf24">${d}</span><span style="opacity:.35;margin:0 4px;">/</span><span style="color:#a78bfa">${n}</span>`;
}

function renderScheduleGrid() {
  const box = document.getElementById("schBody");
  const days = schDays();
  const today = new Date().toLocaleDateString("sv-SE");
  if (!sch.users.length) {
    box.innerHTML = '<div style="color:var(--text2);">Пользователей пока нет.</div>';
    return;
  }
  let head = '<div class="schCorner">Сотрудник</div>';
  for (let d = 1; d <= days; d++) {
    const wd = schWday(d);
    head += `<div class="schHead ${wd >= 5 ? "we" : ""} ${schIso(d) === today ? "today" : ""}" data-day="${schIso(d)}"><b>${d}</b><span>${SCH_WD[wd]}</span></div>`;
  }
  head += '<div class="schHead"><b>Смен</b><span>день/ночь</span></div>';

  const rows = sch.users.map(u => {
    let cells = "";
    for (let d = 1; d <= days; d++) {
      const iso = schIso(d);
      const t = sch.map[`${u.email}|${iso}`] || "";
      const a = sch.att[`${u.email}|${iso}`];
      cells += `<div class="schCell ${t ? "s-" + t : ""} ${a ? "att-" + a : ""} ${schWday(d) >= 5 ? "we" : ""} ${iso === today ? "today" : ""}" data-u="${ctAttr(u.email)}" data-d="${iso}">${t ? SCH_TYPES[t].short : ""}</div>`;
    }
    const tt = sch.map[`${u.email}|${today}`];
    const onToday = tt && tt !== "off";
    const nowLabel = { day: "день", night: "ночь", training: "стаж." }[tt] || "";
    return `<div class="schName ${onToday ? "onToday" : ""}" style="${onToday ? `--c:${SCH_TYPES[tt].color}` : ""}" title="${ctAttr(u.email)}"><span style="overflow:hidden;text-overflow:ellipsis;">${escapeHtml(u.username || u.email)}</span>${onToday ? `<span class="schNow">${nowLabel}</span>` : ""}<button class="schHideBtn" data-hide="${ctAttr(u.email)}" title="Убрать из графика">✕</button></div>${cells}<div class="schSumCell" data-sum="${ctAttr(u.email)}">${schSum(u.email)}</div>`;
  }).join("");

  const onShift = sch.users
    .map(u => ({ u, t: sch.map[`${u.email}|${today}`] }))
    .filter(x => x.t && x.t !== "off");
  const strip = today.startsWith(sch.month)
    ? `<div class="schToday"><span class="schTodayTitle">Сегодня на смене</span>${
        onShift.length
          ? onShift.map(x => `<span class="schTodayChip" style="--c:${SCH_TYPES[x.t].color}"><i></i>${escapeHtml(x.u.username || x.u.email)} · ${SCH_TYPES[x.t].label.toLowerCase()}</span>`).join("")
          : '<span style="color:var(--text2);font-size:13px;">никого</span>'
      }</div>`
    : "";
  const tDay = onShift.some(x => x.t === "day");
  const tNight = onShift.some(x => x.t === "night");
  const gapWarn = today.startsWith(sch.month) && (!tDay || !tNight)
    ? `<div class="schGapWarn"><i></i>Сегодня пустая ${!tDay && !tNight ? "дневная и ночная смена" : !tDay ? "дневная смена" : "ночная смена"}</div>`
    : "";
  const coverRow = (type, label, color) => {
    let html = `<div class="schCoverName" style="--c:${color}"><i></i>${label}</div>`;
    for (let d = 1; d <= days; d++) html += `<div class="schCover" data-cover="${type}|${schIso(d)}"></div>`;
    return html + '<div class="schCover"></div>';
  };
  const covers = coverRow("day", "Днём", SCH_TYPES.day.color) + coverRow("night", "Ночью", SCH_TYPES.night.color);
  const hiddenUsers = (sch.allUsers || []).filter(u => u.schedule_hidden);
  const hiddenHtml = hiddenUsers.length
    ? `<div class="schHidden">Скрыты из графика:${hiddenUsers.map(u => `<span class="schHiddenChip">${escapeHtml(u.username || u.email)}<button class="schUnhideBtn" data-unhide="${ctAttr(u.email)}">вернуть</button></span>`).join("")}</div>`
    : "";
  box.innerHTML = `${strip}${gapWarn}<div class="schGridWrap"><div class="schGrid" style="grid-template-columns:170px repeat(${days}, 34px) 80px;">${head}${rows}${covers}</div></div>${hiddenHtml}`;
  for (let d = 1; d <= days; d++) schUpdateCover(schIso(d));
}

function schUpdateCover(iso) {
  let dayN = 0, nightN = 0;
  sch.users.forEach(u => {
    const t = sch.map[`${u.email}|${iso}`];
    if (t === "day") dayN++;
    if (t === "night") nightN++;
  });
  [["day", dayN], ["night", nightN]].forEach(([type, n]) => {
    const el = document.querySelector(`.schCover[data-cover="${type}|${iso}"]`);
    if (!el) return;
    el.textContent = n ? n : "✕";
    el.className = `schCover ${n ? "ok-" + type : "schNone"}`;
  });
  const head = document.querySelector(`.schHead[data-day="${iso}"]`);
  if (head) head.classList.toggle("gap", !dayN || !nightN);
}

function schPaint(cell) {
  const key = `${cell.dataset.u}|${cell.dataset.d}`;
  const val = sch.paintValue;
  if ((sch.map[key] || "") === val) return;
  if (val) sch.map[key] = val; else delete sch.map[key];
  cell.className = cell.className.replace(/\bs-\w+/g, "").replace(/\s+/g, " ").trim() + (val ? ` s-${val}` : "");
  cell.textContent = val ? SCH_TYPES[val].short : "";
  sch.pending.set(key, { user_email: cell.dataset.u, day: cell.dataset.d, shift: val });
  const sum = document.querySelector(`.schSumCell[data-sum="${CSS.escape(cell.dataset.u)}"]`);
  if (sum) sum.innerHTML = schSum(cell.dataset.u);
  schUpdateCover(cell.dataset.d);
}

function schApply(cell) {
  if (sch.paintMode === "att") return schPaintAtt(cell);
  schPaint(cell);
  const key = `${cell.dataset.u}|${cell.dataset.d}`;
  if ((!sch.map[key] || sch.map[key] === "off") && sch.att[key]) {
    delete sch.att[key];
    cell.classList.remove("att-present", "att-absent");
  }
}

function schPaintAtt(cell) {
  const key = `${cell.dataset.u}|${cell.dataset.d}`;
  const shift = sch.map[key];
  if (!shift || shift === "off") return;
  const val = sch.paintValue;
  if ((sch.att[key] || "") === val) return;
  if (val) sch.att[key] = val; else delete sch.att[key];
  cell.classList.remove("att-present", "att-absent");
  if (val) cell.classList.add("att-" + val);
  sch.attPending.set(key, { user_email: cell.dataset.u, day: cell.dataset.d, attendance: val });
}

async function schFlush() {
  if (!sch.pending.size && !sch.attPending.size) return;
  const changes = [...sch.pending.values()];
  const att = [...sch.attPending.values()];
  sch.pending.clear();
  sch.attPending.clear();
  schStatus("Сохраняю...");
  try {
    if (changes.length) {
      await ctJson("/api/admin/shifts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes }),
      });
    }
    if (att.length) {
      await ctJson("/api/admin/shifts/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: att }),
      });
    }
    schStatus(`Сохранено (${changes.length + att.length})`, "var(--green)");
    const todayIso = new Date().toLocaleDateString("sv-SE");
    if (changes.some(c => c.day === todayIso)) renderScheduleGrid();
  } catch (e) {
    schStatus("Не сохранилось: " + e.message, "#fb7185");
    loadSchedule();
  }
}

function renderMySchedule(shifts) {
  const box = document.getElementById("schBody");
  const map = {};
  const att = {};
  shifts.forEach(s => {
    const k = String(s.day).slice(0, 10);
    map[k] = s.shift;
    if (s.attendance) att[k] = s.attendance;
  });
  const days = schDays();
  const today = new Date().toLocaleDateString("sv-SE");

  if (!Object.keys(map).length) {
    box.innerHTML = '<div style="color:var(--text2);margin-top:10px;">На этот месяц график ещё не составлен.</div>';
    return;
  }

  const cnt = { day: 0, night: 0, off: 0, training: 0 };
  Object.values(map).forEach(t => { if (t in cnt) cnt[t]++; });
  const next = Object.keys(map).sort().find(d => d >= today && map[d] !== "off");
  const stat = (t, big, small) =>
    `<div class="schStat" style="--c:${SCH_TYPES[t]?.color || "var(--cyan)"}"><div class="ic">${SCH_ICON[t] || SCH_ICON.next}</div><div><b>${big}</b><span>${small}</span></div></div>`;

  let cal = SCH_WD.map(w => `<div class="schWd">${w}</div>`).join("");
  for (let i = 0; i < schWday(1); i++) cal += '<div class="schDay schBlank"></div>';
  for (let d = 1; d <= days; d++) {
    const iso = schIso(d);
    const t = map[iso];
    const tag = t
      ? `<div class="schTag" style="--c:${SCH_TYPES[t].color}">${SCH_ICON[t]}<div>${SCH_TYPES[t].label}${SCH_TYPES[t].time ? `<small>${SCH_TYPES[t].time}</small>` : ""}</div></div>`
      : "";
    const a = att[iso];
    const attHtml = a === "present" ? '<div class="schAtt ok">Вышел</div>'
                  : a === "absent" ? '<div class="schAtt bad">Не вышел</div>' : "";
    cal += `<div class="schDay ${iso === today ? "today" : ""}"><div class="schDayNum ${schWday(d) >= 5 ? "we" : ""}">${d}</div>${tag}${attHtml}</div>`;
  }

  box.innerHTML = `
    <div class="schStats">
      ${stat("day", cnt.day, "дневных смен")}
      ${stat("night", cnt.night, "ночных смен")}
      ${stat("off", cnt.off, "выходных")}
      ${stat("training", cnt.training, "стажировок")}
      <div class="schStat" style="--c:var(--cyan)"><div class="ic">${SCH_ICON.next}</div><div>
        <b>${next ? ctDate(next) : "—"}</b>
        <span>${next ? `ближайшая: ${SCH_TYPES[map[next]].label.toLowerCase()} ${SCH_TYPES[map[next]].time}` : "ближайших смен нет"}</span>
      </div></div>
    </div>
    <div class="schCal">${cal}</div>`;
}

document.getElementById("schPrev")?.addEventListener("click", async () => {
  await schFlush();
  const [y, m] = sch.month.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  sch.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  loadSchedule();
});

document.getElementById("schNext")?.addEventListener("click", async () => {
  await schFlush();
  const [y, m] = sch.month.split("-").map(Number);
  const d = new Date(y, m, 1);
  sch.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  loadSchedule();
});

document.querySelectorAll(".schTool[data-tool]").forEach(btn => btn.addEventListener("click", () => {
  sch.tool = btn.dataset.tool;
  document.querySelectorAll(".schTool[data-tool]").forEach(b => b.classList.toggle("on", b === btn));
}));

document.getElementById("schBody")?.addEventListener("mousedown", e => {
  const cell = e.target.closest(".schCell");
  if (!cell || !sch.isAdmin) return;
  e.preventDefault();
  const key = `${cell.dataset.u}|${cell.dataset.d}`;
  if (sch.tool === "present" || sch.tool === "absent") {
    sch.paintMode = "att";
    sch.paintValue = sch.att[key] === sch.tool ? "" : sch.tool;
  } else {
    sch.paintMode = "shift";
    const cur = sch.map[key] || "";
    sch.paintValue = (sch.tool === "clear" || cur === sch.tool) ? "" : sch.tool;
  }
  sch.painting = true;
  schApply(cell);
});

document.getElementById("schBody")?.addEventListener("mouseover", e => {
  if (!sch.painting) return;
  const cell = e.target.closest(".schCell");
  if (cell) schApply(cell);
});

document.addEventListener("mouseup", () => {
  if (!sch.painting) return;
  sch.painting = false;
  schFlush();
});

document.getElementById("schBody")?.addEventListener("click", async e => {
  const hideBtn = e.target.closest(".schHideBtn");
  const unhideBtn = e.target.closest(".schUnhideBtn");
  if (!hideBtn && !unhideBtn) return;
  const email = (hideBtn || unhideBtn).dataset.hide || (hideBtn || unhideBtn).dataset.unhide;
  const hidden = !!hideBtn;
  if (hidden) {
    const u = (sch.allUsers || []).find(x => x.email === email);
    const ok = await ctConfirm(
      `Убрать ${u?.username || email} из графика?`,
      "Сотрудник пропадёт из таблицы и подсчёта смен. Аккаунт и история смен сохранятся, вернуть можно в любой момент.",
      "Убрать"
    );
    if (!ok) return;
  }
  try {
    await ctJson("/api/admin/shifts/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_email: email, hidden }),
    });
    await loadSchedule();
  } catch (err) {
    schStatus("Не получилось: " + err.message, "#fb7185");
  }
});

document.getElementById("schNotifyBtn")?.addEventListener("click", async () => {
  await schFlush();
  try {
    const data = await ctJson("/api/admin/shifts/notify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ month: sch.month }),
    });
    schStatus(data.notified ? `Уведомление отправлено: ${data.notified} чел.` : "В этом месяце ни у кого нет смен.", "var(--green)");
  } catch (e) {
    schStatus("Не отправилось: " + e.message, "#fb7185");
  }
});

document.addEventListener("click", e => {
  if (!e.target.closest(".openScheduleBtn")) return;
  document.getElementById("bellPanel")?.classList.remove("open");
  document.getElementById("notificationsModal")?.classList.remove("open");
  openPage("schedule");
});

// Кнопка «Открыть задания» в уведомлениях (работает и в колокольчике сверху)
document.addEventListener("click", e => {
  if (!e.target.closest(".openAssignmentBtn")) return;
  document.getElementById("bellPanel")?.classList.remove("open");
  document.getElementById("notificationsModal")?.classList.remove("open");
  openPage("myTasks");
});

document.getElementById("contactsRefreshBtn")?.addEventListener("click", loadContacts);

document.getElementById("contactsSearch")?.addEventListener("input", loadContacts);
document.getElementById("contactsFilter")?.addEventListener("change", loadContacts);

document.getElementById("contactsExportBtn")?.addEventListener("click", async () => {
  const accounts = cachedAccounts.filter(a => (a.platform || "").toLowerCase() === "intcity");
  if (!accounts.length) { alert("Нет аккаунтов intCity"); return; }
  const res = await fetch(`/api/intcity/leads?account_id=${accounts[0].id}`);
  const data = await res.json();
  const leads = data.leads || [];
  const csv = "email,status,ad_url\n" + leads.map(l =>
    `${l.email},${l.sent_at ? "sent" : "unsent"},${l.ad_url}`
  ).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "intcity_contacts.csv";
  a.click(); URL.revokeObjectURL(url);
});

window.loadProxySettings = loadProxySettings;

// ── Вкладки на странице настроек ──────────────────────────
document.addEventListener("click", (e) => {
  const btn = e.target.closest("#settingsTabs [data-stab]");
  if (!btn) return;
  const tab = btn.dataset.stab;
  document.querySelectorAll("#settingsTabs [data-stab]")
    .forEach(b => b.classList.toggle("active", b.dataset.stab === tab));
  document.querySelectorAll(".settingsTab")
    .forEach(d => { d.style.display = d.dataset.stab === tab ? "block" : "none"; });
});

// ══════════════════════════════════════════════════════════
// ПРОМТЫ ПЛАТФОРМ
// ══════════════════════════════════════════════════════════

const PROMPT_PLATFORMS = [
  { id: "mamba",   label: "Mamba"   },
  { id: "twinby",  label: "Twinby"  },
];

// Порядок блоков = порядок, в котором они склеиваются в промт для модели
const PROMPT_BLOCKS = [
  {
    id: "identity", title: "1. Кто ты",
    hint: "Самое начало промта. Имя, возраст, пол. Главное — запрет признаваться, что это бот.",
    tpl: "Ты живая {gender} на сайте знакомств, НЕ ИИ и не бот.\nТебя зовут {name}, тебе {age}.\nНикогда не говори что ты ИИ, не упоминай правила и ограничения, не пиши «я не могу это обсуждать»."
  },
  {
    id: "format", title: "2. Формат ответа",
    hint: "Длина, язык, род. Отвечает за то, чтобы модель не вываливала в чат свои рассуждения. Трогать осторожно.",
    tpl: "Пиши ТОЛЬКО по-русски. Ни одного слова по-английски.\nО СЕБЕ — женский род: рада, устала, написала, думала.\nО собеседнике — мужской: «ты устал?», «ты пришёл?».\nВыдавай ТОЛЬКО саму реплику в чат — без размышлений, без плана, без пересказа его сообщения, без объяснений почему ты так отвечаешь.\nЗапрещено начинать с «The user», «Let me», «Согласно инструкции», «Мне нужно».\nМаксимум 2 коротких предложения."
  },
  {
    id: "style", title: "3. Стиль общения",
    hint: "Как звучит переписка: тон, запрещённые слова, смайлики.",
    tpl: "1-2 коротких предложения, иногда одно слово. Строчные буквы. Тепло, с характером, живо.\nНИ ОДНОГО смайлика и эмодзи. Никаких списков и форматирования.\nНе начинай с его имени. Не задавай два вопроса подряд.\nЗапрещённые слова: конечно, разумеется, безусловно, замечательно, прекрасно.\nГрубят — отвечай так же коротко и холодно. Пошлый намёк — легко подыграй («может быть», «зависит от человека»)."
  },
  {
    id: "persona", title: "4. Характер",
    hint: "Подставляется из поля «Личность / стиль» карточки AI-менеджера. Оставь {persona} и допиши своё, если нужно.",
    tpl: "ХАРАКТЕР (чувствуется в каждом сообщении):\n{persona}"
  },
  {
    id: "location", title: "5. Локация",
    hint: "Что отвечать про город и район. {location} и {city} берутся из карточки.",
    tpl: "ЛОКАЦИЯ: {location}.\nСпросили город — просто «{city}». Спросили район или далеко ли — назови рандомный район, каждый раз разный.\nУлицу — «не скажу так сразу, давай в тг».\nСама локацию не упоминай и к другим ответам не приплетай.\nЕсли он назвал СВОЙ район — это не вопрос тебе: «о, близко» и дальше по теме."
  },
  {
    id: "goal", title: "6. Цель и воронка",
    hint: "Ради чего вообще диалог и в каком порядке к этому вести.",
    tpl: "ЦЕЛЬ: встреча за подарочек и перевод в телеграм.\nСначала живой разговор, отталкивайся от его слов. К теме встречи подводи плавно, не в лоб.\nКак только он проявил интерес, спросил условия или цену — пиши что всё в тг и следующим сообщением контакт.\nЕсли он САМ предложил встречу — не переспрашивай «а встретиться не хочешь?», это выдаёт бота. Подтверди и веди в тг.\nПосле 5-6 сообщений без темы встречи — спроси своими словами, он за встречи или просто пообщаться.\nЗапрещено говорить что ищешь отношения, любовь или семью."
  },
  {
    id: "money", title: "7. Деньги и цена",
    hint: "Жёсткий запрет называть суммы на площадке. Убирать не советую — из-за сумм в чате банят анкеты.",
    tpl: "ДЕНЬГИ — НИ ОДНОЙ ЦИФРЫ ЗДЕСЬ:\nЗапрещено называть сумму, диапазон, намекать на порядок цифр, торговаться.\nНа «сколько?», «какая сумма?», «что по чём?» — коротко: «тут это не обсуждаю, давай в тг» / «по условиям только в тг».\nИ следующим сообщением контакт.\nЧто входит — «всё обсудим в тг». Где — «могу к тебе». Фото — «фото в тг» и контакт."
  },
  {
    id: "contact", title: "8. Контакт и перевод в телеграм",
    hint: "{contacts} — это поле «Контакты» из карточки, целиком, вместе с текстом рядом с ником. Пиши именно {contacts}, а не ник руками — иначе потеряется шрифт.",
    tpl: "КОНТАКТ. Твой контактный блок целиком: {contacts}\nВсегда ДВА отдельных сообщения:\n1) короткая утвердительная фраза без контакта: «давай в телеге все обсудим, не тут» / «подробности в телеге» / «тут редко захожу, пиши в тг»\n2) контактный блок, скопированный ТОЧНО как написан выше, слово в слово: {contacts}\nВо втором сообщении копируй блок целиком — вместе с текстом рядом с ником. Ничего не сокращай и не дописывай своего.\nЗапрещено спрашивать разрешения («го в тг?») — ты сообщаешь и сразу даёшь контакт.\nЗапрещено класть контакт в одно сообщение с предложением, выдумывать другой ник, обещать написать первой.\nЕсли контакт уже есть в истории — больше не давай его: «жду» / «пиши там» / «увидимся»."
  },
  {
    id: "cantfind", title: "9. Не может найти в телеграме",
    hint: "Единственный случай, когда контакт отдаётся повторно. Отвечает за фразу «у тебя ник звёздочками».",
    tpl: "НЕ НАХОДИТ ТЕБЯ В ТГ / ПРОСИТ НАПИСАТЬ ПЕРВОЙ («не могу тебя найти», «нет такого ника», «напиши мне сама») — это НЕ отказ.\nОтвечай ДВУМЯ сообщениями, между ними перенос строки:\n1) сваливай на ЕГО ник — у него он звёздочками, поэтому ты сама написать не можешь: «у тебя ник звёздочками, я тебя так не найду, напиши мне сам». Речь именно про ЕГО ник, не про твой.\n2) контактный блок заново, слово в слово: {contacts}\nПервой ты не пишешь никогда. Номер телефона не даёшь.\nБольше двух раз за диалог не повторяй, дальше: «ник выше, перепиши его руками»."
  },
  {
    id: "refusal", title: "10. Отказ и «не отказ»",
    hint: "Чтобы бот не прощался с хорошим лидом. Самая частая потеря денег — здесь.",
    tpl: "ОТКАЗ (прощаешься — «ну тогда не по пути, удачи»): прямо говорит что не платит, «я не за деньги», «бесплатно только», прямо посылает.\nНЕ отказ, а лучший клиент (ни в коем случае не прощайся): «хочу любовницу», «на постоянке», «содержание», «готов помогать», «рассматриваю», вопрос про формат. Реагируй тепло и веди в тг.\nСлова «любовница» или «отношения» — это НЕ отказ, если он не отказался платить.\nСомневаешься — считай что НЕ отказ, лучше уточни."
  },
  {
    id: "norepeat", title: "11. Не повторяйся",
    hint: "Без этого блока бот здоровается по три раза и заново пересказывает условия.",
    tpl: "Перед ответом перечитай свои прошлые сообщения. Новый ответ не должен повторять ни одно из них — ни дословно, ни по смыслу.\nУже здоровалась — не здоровайся. Уже спрашивала «как дела» — не спрашивай.\nУже сказала что встречаешься за подарочек — он это знает, не повторяй и не спрашивай «а ты?».\nЕсли он согласился («давай», «ок», «а сколько») — он уже в теме, просто веди в тг."
  },
  {
    id: "situations", title: "12. Частые ситуации",
    hint: "Короткие ответы на типовые вопросы: бот ли ты, чужие фото, оскорбления, голосовые.",
    tpl: "Спросил бот ли ты — только если прямо про бота, робота или ИИ. Тогда с иронией: «серьёзно? я бот? ну ты насмешил». Никогда не говори «я не являюсь ботом».\nПРИСЛАЛ ССЫЛКУ ИЛИ ГОВОРИТ ЧТО ФОТО ЧУЖИЕ — это НЕ вопрос про бота, тему бота не поднимай. Спокойно: «по ссылкам не хожу» / «фото мои, но доказывать не собираюсь». И дальше по своей линии.\nОскорбляют — одна холодная фраза («удачи тебе») и больше не отвечаешь.\nПропал и вернулся — «о, вернулся», без упрёков.\nГолосовое или стикер — «голосовые тут не слушаю».\nПроверяет (2+2) — «ты тест мне устраиваешь что ли».\nСпросил как выглядишь — «лучше один раз увидеть».\nНе из города — «жаль, если будешь в Москве — пиши».\nДлинное сообщение — отвечай только на главное, 1-2 предложения."
  },
];

async function loadPlatformPrompts() {
  const list = document.getElementById("promptList");
  if (!list) return;

  list.innerHTML = "<div style='color:var(--text-muted);font-size:13px;'>Загрузка...</div>";

  const auth = localStorage.getItem("claw_auth_token") || "";
  let rows = {};
  try {
    const res = await fetch("/api/platform-prompts", { headers: { Authorization: auth } });
    const data = await res.json();
    if (Array.isArray(data)) data.forEach(r => { rows[r.platform] = r; });
  } catch (e) {
    list.innerHTML = "<div style='color:#fb7185;font-size:13px;'>Ошибка загрузки промтов</div>";
    return;
  }

  const esc = t => String(t || "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  list.innerHTML = "";

  PROMPT_PLATFORMS.forEach(p => {
    const row = rows[p.id] || {};
    const blocks = row.blocks || {};
    const filled = PROMPT_BLOCKS.filter(b => (blocks[b.id] || "").trim()).length;

    const card = document.createElement("div");
    card.style.cssText =
      "background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 18px;";

    card.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
        <div style="font:700 13px 'Orbitron',sans-serif;color:var(--accent3);letter-spacing:0.06em;">${p.label}</div>
        <div style="display:flex;align-items:center;gap:10px;">
          <span class="promptFilled" data-id="${p.id}" style="font-size:11px;color:var(--text-muted);">${filled} из ${PROMPT_BLOCKS.length} заполнено</span>
          <button class="ghost promptFillBtn" data-id="${p.id}" style="padding:5px 12px;font-size:12px;">Загрузить шаблон</button>
          <button class="ghost promptToggleBtn" data-id="${p.id}" style="padding:5px 12px;font-size:12px;">Развернуть</button>
        </div>
      </div>
      <p class="hint" style="margin:0 0 12px;">
        Пустой блок просто не попадёт в промт. Если пусты все — работает промт из кода воркера.
      </p>
      <div class="promptBlocks" data-id="${p.id}" style="display:none;flex-direction:column;gap:14px;">
        ${PROMPT_BLOCKS.map(b => `
          <div style="border-left:2px solid rgba(16,245,168,0.35);padding-left:12px;">
            <div style="font:600 12px 'Space Grotesk',sans-serif;color:var(--text);margin-bottom:3px;">${b.title}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;line-height:1.5;">${b.hint}</div>
            <textarea class="promptBlockText" data-id="${p.id}" data-block="${b.id}"
              placeholder="Пусто — блок не попадёт в промт"
              style="width:100%;min-height:96px;font-family:'JetBrains Mono',monospace;font-size:12px;line-height:1.55;resize:vertical;">${esc(blocks[b.id] || "")}</textarea>
          </div>
        `).join("")}
      </div>
      <button class="taskRunBtn promptSaveBtn" data-id="${p.id}" style="width:100%;margin-top:12px;">Сохранить</button>
      <div class="promptSaveMsg" data-id="${p.id}" style="margin-top:8px;font-size:12px;min-height:18px;"></div>
    `;
    list.appendChild(card);
  });

  const refreshFilled = id => {
    const n = [...document.querySelectorAll(`.promptBlockText[data-id="${id}"]`)]
      .filter(t => t.value.trim()).length;
    const el = document.querySelector(`.promptFilled[data-id="${id}"]`);
    if (el) el.textContent = `${n} из ${PROMPT_BLOCKS.length} заполнено`;
  };

  document.querySelectorAll(".promptBlockText").forEach(ta => {
    ta.addEventListener("input", () => refreshFilled(ta.dataset.id));
  });

  document.querySelectorAll(".promptToggleBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const box = document.querySelector(`.promptBlocks[data-id="${btn.dataset.id}"]`);
      const open = box.style.display !== "none";
      box.style.display = open ? "none" : "flex";
      btn.textContent = open ? "Развернуть" : "Свернуть";
    });
  });

  document.querySelectorAll(".promptFillBtn").forEach(btn => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      const box = document.querySelector(`.promptBlocks[data-id="${id}"]`);
      box.style.display = "flex";
      const tgl = document.querySelector(`.promptToggleBtn[data-id="${id}"]`);
      if (tgl) tgl.textContent = "Свернуть";
      let touched = 0;
      PROMPT_BLOCKS.forEach(b => {
        const ta = document.querySelector(`.promptBlockText[data-id="${id}"][data-block="${b.id}"]`);
        if (ta && !ta.value.trim()) { ta.value = b.tpl; touched++; }
      });
      refreshFilled(id);
      const msg = document.querySelector(`.promptSaveMsg[data-id="${id}"]`);
      msg.style.color = "var(--text-muted)";
      msg.textContent = touched
        ? `Заполнено пустых блоков: ${touched}. Проверь и нажми «Сохранить».`
        : "Все блоки уже заполнены — шаблон ничего не перезаписывает.";
    });
  });

  document.querySelectorAll(".promptSaveBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const blocks = {};
      PROMPT_BLOCKS.forEach(b => {
        const ta = document.querySelector(`.promptBlockText[data-id="${id}"][data-block="${b.id}"]`);
        blocks[b.id] = ta ? ta.value : "";
      });
      const msg = document.querySelector(`.promptSaveMsg[data-id="${id}"]`);

      btn.disabled = true;
      btn.textContent = "Сохраняю...";
      msg.textContent = "";

      try {
        const res = await fetch("/api/platform-prompts", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: localStorage.getItem("claw_auth_token") || "",
          },
          body: JSON.stringify({ platform: id, prompt: "", blocks }),
        });
        const data = await res.json();
        if (res.ok) {
          msg.style.color = "var(--green, #10f5a8)";
          msg.textContent = "✓ Сохранено — воркер подхватит в течение минуты";
        } else {
          msg.style.color = "#fb7185";
          msg.textContent = "✗ " + (data.detail || data.error || "Ошибка");
        }
      } catch (e) {
        msg.style.color = "#fb7185";
        msg.textContent = "✗ Ошибка сети";
      }

      btn.disabled = false;
      btn.textContent = "Сохранить";
      setTimeout(() => { msg.textContent = ""; }, 4000);
    });
  });
}

window.loadPlatformPrompts = loadPlatformPrompts;

// ── KPI на главной ──
const KPI_BASE_KEY = "claw_kpi_base";

function kpiBaseFor(platform, current) {
  let store = {};
  try { store = JSON.parse(localStorage.getItem(KPI_BASE_KEY) || "{}"); } catch {}
  const today = new Date().toISOString().slice(0, 10);
  const rec = store[platform];
  // Нет слепка или он со вчера — снимаем новый от текущих значений
  if (!rec || rec.date !== today) {
    store[platform] = { date: today, ...current };
    try { localStorage.setItem(KPI_BASE_KEY, JSON.stringify(store)); } catch {}
    return { ...current };
  }
  return rec;
}

function renderKpiTag(id, now, base) {
  const el = document.getElementById(id);
  if (!el) return;
  const diff = now - base;
  if (!diff) { el.style.display = "none"; return; }
  const pct = base > 0 ? Math.round((diff / base) * 1000) / 10 : null;
  el.style.display = "inline-block";
  el.className = "tag " + (diff > 0 ? "up" : "down");
  el.textContent = (diff > 0 ? "+" : "") + (pct !== null ? pct + "%" : diff);
}

function updateKpiRow() {
  const row = document.getElementById("kpiRow");
  if (!row) return;
  const cards = document.querySelectorAll("#accountsList .sqCard");
  let likes = 0, replies = 0, leads = 0;
  cards.forEach(c => {
    likes   += parseInt(c.querySelector(".sqLikesVal")?.textContent) || 0;
    replies += parseInt(c.querySelector(".sqMsgsVal")?.textContent) || 0;
    leads   += parseInt(c.querySelector(".sqContactsVal")?.textContent) || 0;
  });
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  set("kpiAccounts", cards.length);
  set("kpiLikes", likes);
  set("kpiReplies", replies);
  set("kpiLeads", leads);

  const platform = (typeof activePlatform !== "undefined" && activePlatform) ? activePlatform : "Mamba";
  const current = { accounts: cards.length, likes, replies, leads };
  const base = kpiBaseFor(platform, current);
  renderKpiTag("kpiAccountsTag", cards.length, base.accounts || 0);
  renderKpiTag("kpiLikesTag", likes, base.likes || 0);
  renderKpiTag("kpiRepliesTag", replies, base.replies || 0);
  renderKpiTag("kpiLeadsTag", leads, base.leads || 0);
}
setInterval(updateKpiRow, 2000);
updateKpiRow();

// ── Приветствие и дата ──
function updateGreeting() {
  const t = document.getElementById("greetTitle");
  const c = document.getElementById("greetCrumb");
  const d = document.getElementById("datePill");
  const h = new Date().getHours();
  const part = h < 6 ? "Доброй ночи" : h < 12 ? "Доброе утро" : h < 18 ? "Добрый день" : "Добрый вечер";
  const nameEl = document.getElementById("topUserName");
  const who = (nameEl?.textContent || "").trim();
  if (t) t.textContent = who && who !== "Аккаунт" ? `${part}, ${who}!` : `${part}!`;
  if (c) c.textContent = "Главная / " + (typeof activePlatform !== "undefined" ? activePlatform : "");
  if (d) d.textContent = "Сегодня, " + new Date().toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}
setInterval(updateGreeting, 3000);
updateGreeting();

// ══════════════════════════════════════════════════════════
// ПЛАНИРОВАНИЕ
// ══════════════════════════════════════════════════════════

let planTasks = [];
let planPeople = [];
let planNames = {};
let planMe = "";
let planFilter = "all";
let planAssigneeFilter = "";
let planEditId = null;
let planCommentsTaskId = null;

const PLAN_STATUS = { new: "Новая", doing: "В работе", done: "Сделано" };

function planShortName(email) {
  if (!email) return "—";
  return planNames[email] || email.split("@")[0];
}

function planEsc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

async function planLoadPeople() {
  try {
    const res = await fetch("/api/plan/people");
    const data = await res.json();
    planPeople = data.people || [];
    planNames = data.names || {};
    planMe = data.me || "";
  } catch (e) { console.error("plan people:", e); }

  const opts = '<option value="">Не назначен</option>' +
    planPeople.map(p => `<option value="${planEsc(p)}">${planEsc(planShortName(p))}</option>`).join("");
  const sel = document.getElementById("planAssignee");
  if (sel) sel.innerHTML = opts;

  const filt = document.getElementById("planAssigneeFilter");
  if (filt) {
    filt.innerHTML = '<option value="">Все исполнители</option>' +
      planPeople.map(p => `<option value="${planEsc(p)}">${planEsc(planShortName(p))}</option>`).join("");
  }
}

async function planLoadTasks() {
  try {
    const res = await fetch("/api/plan/tasks");
    const data = await res.json();
    planTasks = data.tasks || [];
    if (data.me) planMe = data.me;
  } catch (e) { console.error("plan tasks:", e); planTasks = []; }
  planRender();
}

function planRender() {
  const list = document.getElementById("planList");
  const counter = document.getElementById("planCounter");
  if (!list) return;

  let rows = planTasks.slice();
  if (planFilter === "mine") rows = rows.filter(t => t.assignee_email === planMe);
  else if (planFilter !== "all") rows = rows.filter(t => (t.status || "new") === planFilter);
  if (planAssigneeFilter) rows = rows.filter(t => t.assignee_email === planAssigneeFilter);

  if (counter) counter.textContent = `Задач: ${rows.length} из ${planTasks.length}`;

  if (!rows.length) {
    list.innerHTML = '<div class="planEmpty">Задач нет. Нажми «+ Новая задача».</div>';
    return;
  }

  const today = new Date().toISOString().slice(0, 10);

  list.innerHTML = rows.map(t => {
    const status = t.status || "new";
    const done = status === "done";
    const overdue = t.due_date && !done && t.due_date < today;
    const prioClass = t.priority === "high" ? "high" : t.priority === "low" ? "low" : "";
    const prioLabel = t.priority === "high" ? "Высокий" : t.priority === "low" ? "Низкий" : "Обычный";
    return `
      <div class="planTask ${done ? "isDone" : ""}" data-id="${t.id}">
        <button class="planCheck ${done ? "on" : ""}" data-act="toggle" data-id="${t.id}">✓</button>
        <div class="planTaskMain">
          <div class="planTaskTitle">${planEsc(t.title)}</div>
          ${t.description ? `<div class="planTaskDesc">${planEsc(t.description)}</div>` : ""}
          <div class="planMeta">
            <select class="planStatusSel st-${status}" data-act="status" data-id="${t.id}">
              ${Object.keys(PLAN_STATUS).map(k =>
                `<option value="${k}" ${k === status ? "selected" : ""}>${PLAN_STATUS[k]}</option>`).join("")}
            </select>
            <select class="planStatusSel who" data-act="assignee" data-id="${t.id}" title="Исполнитель">
              <option value="">Не назначен</option>
              ${planPeople.map(p =>
                `<option value="${planEsc(p)}" ${p === t.assignee_email ? "selected" : ""}>${planEsc(planShortName(p))}</option>`).join("")}
            </select>
            <select class="planStatusSel ${prioClass}" data-act="priority" data-id="${t.id}" title="Приоритет">
              <option value="low" ${t.priority === "low" ? "selected" : ""}>Низкий</option>
              <option value="normal" ${(!t.priority || t.priority === "normal") ? "selected" : ""}>Обычный</option>
              <option value="high" ${t.priority === "high" ? "selected" : ""}>Высокий</option>
            </select>
            <input type="date" class="planDateInp ${overdue ? "overdue" : ""}" data-act="due" data-id="${t.id}" value="${t.due_date || ""}" title="Срок" />
            <span class="planChip btn" data-act="comments" data-id="${t.id}">💬 ${t.comments_count || 0}</span>
            <span class="planChip btn" data-act="edit" data-id="${t.id}">Изменить</span>
            <button class="planDel" data-act="del" data-id="${t.id}" title="Удалить">✕</button>
          </div>
        </div>
      </div>
    `;
  }).join("");
}

async function planPatch(id, body) {
  try {
    await fetch(`/api/plan/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    await planLoadTasks();
  } catch (e) { alert("Не удалось сохранить: " + e.message); }
}

function planOpenModal(task) {
  planEditId = task ? task.id : null;
  document.getElementById("planModalTitle").textContent = task ? "Задача" : "Новая задача";
  document.getElementById("planTitle").value = task ? (task.title || "") : "";
  document.getElementById("planDesc").value = task ? (task.description || "") : "";
  document.getElementById("planAssignee").value = task ? (task.assignee_email || "") : "";
  document.getElementById("planPriority").value = task ? (task.priority || "normal") : "normal";
  document.getElementById("planDue").value = task ? (task.due_date || "") : "";
  const r = document.getElementById("planSaveResult");
  if (r) { r.textContent = ""; r.className = "result"; }
  document.getElementById("planTaskModal").classList.add("open");
}

async function planOpenComments(taskId) {
  planCommentsTaskId = taskId;
  const task = planTasks.find(t => t.id === taskId);
  document.getElementById("planCommentsTitle").textContent = task ? task.title : "Комментарии";
  document.getElementById("planCommentInput").value = "";
  document.getElementById("planCommentsModal").classList.add("open");

  const box = document.getElementById("planCommentsList");
  box.innerHTML = '<div class="planEmpty">Загружаю...</div>';
  try {
    const res = await fetch(`/api/plan/tasks/${encodeURIComponent(taskId)}/comments`);
    const data = await res.json();
    const list = data.comments || [];
    box.innerHTML = list.length ? list.map(c => `
      <div class="planComment">
        <div class="planCommentWho">${planEsc(c.author_name || planShortName(c.author_email))}</div>
        <div class="planCommentBody">${planEsc(c.body)}</div>
        <div class="planCommentDate">${new Date(c.created_at).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}</div>
      </div>
    `).join("") : '<div class="planEmpty">Пока нет комментариев.</div>';
    box.scrollTop = box.scrollHeight;
  } catch (e) {
    box.innerHTML = '<div class="planEmpty">Ошибка загрузки.</div>';
  }
}

async function planRenderTeam() {
  const box = document.getElementById("planTeamList");
  if (!box) return;
  box.innerHTML = '<div class="planEmpty" style="padding:12px;">Загружаю...</div>';
  try {
    await planLoadPeople();
    const res = await fetch("/api/team/members");
    const data = await res.json();
    const roles = {};
    (data.members || []).forEach(m => { roles[m.member_email] = m.role; });
    box.innerHTML = planPeople.map(p => `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">
        <span style="font:500 12.5px 'Inter',sans-serif;color:var(--text);">${planEsc(planShortName(p))}</span>
        <span style="font:600 10.5px 'Inter',sans-serif;color:var(--text3);">${p === planMe ? "это вы" : (roles[p] === "viewer" ? "наблюдатель" : "менеджер")}</span>
      </div>
    `).join("");
  } catch (e) {
    box.innerHTML = '<div class="planEmpty" style="padding:12px;">Не загрузилось.</div>';
  }
}

let _planInited = false;

function initPlanPage() {
  if (!_planInited) {
    _planInited = true;

    document.getElementById("planAddBtn")?.addEventListener("click", () => planOpenModal(null));

    document.getElementById("planInviteBtn")?.addEventListener("click", () => {
      document.getElementById("planInviteEmail").value = "";
      const r = document.getElementById("planInviteResult");
      r.textContent = ""; r.className = "result";
      planRenderTeam();
      document.getElementById("planInviteModal").classList.add("open");
    });

    document.getElementById("planInviteClose")?.addEventListener("click", () =>
      document.getElementById("planInviteModal").classList.remove("open"));

    document.getElementById("planInviteSend")?.addEventListener("click", async () => {
      const email = document.getElementById("planInviteEmail").value.trim();
      const role = document.getElementById("planInviteRole").value;
      const r = document.getElementById("planInviteResult");
      if (!email || !email.includes("@")) {
        r.textContent = "Впиши корректный email."; r.className = "result bad"; return;
      }
      r.textContent = "Отправляю..."; r.className = "result";
      try {
        const res = await fetch("/api/team/invite", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, role }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Ошибка отправки");
        r.textContent = "Приглашение отправлено. Оно придёт ему на колокольчик.";
        r.className = "result good";
        document.getElementById("planInviteEmail").value = "";
        planRenderTeam();
      } catch (err) {
        r.textContent = err.message || "Не отправилось.";
        r.className = "result bad";
      }
    });
    document.getElementById("planModalClose")?.addEventListener("click", () =>
      document.getElementById("planTaskModal").classList.remove("open"));
    document.getElementById("planCommentsClose")?.addEventListener("click", () =>
      document.getElementById("planCommentsModal").classList.remove("open"));

    document.querySelectorAll("[data-pfilter]").forEach(btn => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-pfilter]").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        planFilter = btn.dataset.pfilter;
        planRender();
      });
    });

    document.getElementById("planAssigneeFilter")?.addEventListener("change", (e) => {
      planAssigneeFilter = e.target.value;
      planRender();
    });

    document.getElementById("planList")?.addEventListener("click", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      const id = el.dataset.id;
      const act = el.dataset.act;
      if (act === "toggle") {
        const t = planTasks.find(x => x.id === id);
        planPatch(id, { status: (t?.status === "done") ? "new" : "done" });
      } else if (act === "edit") {
        planOpenModal(planTasks.find(x => x.id === id));
      } else if (act === "comments") {
        planOpenComments(id);
      } else if (act === "del") {
        if (!confirm("Удалить задачу?")) return;
        fetch(`/api/plan/tasks/${encodeURIComponent(id)}`, { method: "DELETE" })
          .then(() => planLoadTasks());
      }
    });

    document.getElementById("planList")?.addEventListener("change", (e) => {
      const el = e.target.closest("[data-act]");
      if (!el) return;
      const id = el.dataset.id;
      const map = { status: "status", assignee: "assignee_email", priority: "priority", due: "due_date" };
      const field = map[el.dataset.act];
      if (!field) return;
      planPatch(id, { [field]: el.value });
    });

    document.getElementById("planList")?.addEventListener("dblclick", (e) => {
      const el = e.target.closest(".planTaskTitle, .planTaskDesc");
      if (!el) return;
      const row = el.closest(".planTask");
      const id = row?.dataset.id;
      if (!id) return;
      const isTitle = el.classList.contains("planTaskTitle");
      const current = el.textContent.trim();
      const inp = document.createElement("input");
      inp.value = current;
      inp.className = "planInlineInp";
      el.replaceWith(inp);
      inp.focus();
      inp.select();
      let saved = false;
      const finish = async (commit) => {
        if (saved) return;
        saved = true;
        const val = inp.value.trim();
        if (commit && val && val !== current) {
          await planPatch(id, isTitle ? { title: val } : { description: val });
        } else {
          planRender();
        }
      };
      inp.addEventListener("blur", () => finish(true));
      inp.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") inp.blur();
        if (ev.key === "Escape") finish(false);
      });
    });

    document.getElementById("planSaveBtn")?.addEventListener("click", async () => {
      const body = {
        title: document.getElementById("planTitle").value.trim(),
        description: document.getElementById("planDesc").value.trim(),
        assignee_email: document.getElementById("planAssignee").value,
        priority: document.getElementById("planPriority").value,
        due_date: document.getElementById("planDue").value,
      };
      const r = document.getElementById("planSaveResult");
      if (!body.title) { r.textContent = "Впиши название."; r.className = "result bad"; return; }
      try {
        if (planEditId) {
          await fetch(`/api/plan/tasks/${encodeURIComponent(planEditId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        } else {
          const res = await fetch("/api/plan/tasks", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.detail || "Ошибка");
        }
        document.getElementById("planTaskModal").classList.remove("open");
        await planLoadTasks();
      } catch (err) {
        r.textContent = err.message || "Не сохранилось.";
        r.className = "result bad";
      }
    });

    document.getElementById("planCommentSend")?.addEventListener("click", async () => {
      const input = document.getElementById("planCommentInput");
      const text = input.value.trim();
      if (!text || !planCommentsTaskId) return;
      input.value = "";
      try {
        await fetch(`/api/plan/tasks/${encodeURIComponent(planCommentsTaskId)}/comments`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ body: text }),
        });
        await planOpenComments(planCommentsTaskId);
        planLoadTasks();
      } catch (e) { alert("Комментарий не отправился"); }
    });

    document.getElementById("planCommentInput")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("planCommentSend").click();
    });

    planLoadPeople().then(planRender);
  }
  planLoadTasks();
}

// ══════════════════════════════════════════════════════════
// КОМАНДНЫЙ ЧАТ
// ══════════════════════════════════════════════════════════

let tmRooms = [];
let tmRoomId = null;
let tmMe = "";
let tmLastAt = "";
let tmPollId = null;
let tmCreateKind = "group";
let tmPicked = new Set();
let tmSeen = new Set();   // id уже нарисованных сообщений
let tmLoading = false;    // защита от двух одновременных загрузок
let tmPending = [];       // файлы, выбранные к отправке

function tmTime(iso) {
  return new Date(iso).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function tmDayLabel(iso) {
  const d = new Date(iso), now = new Date();
  const same = d.toDateString() === now.toDateString();
  if (same) return "Сегодня";
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
}

async function tmLoadRooms() {
  try {
    const res = await fetch("/api/chat/rooms");
    const data = await res.json();
    const next = data.rooms || [];
    tmMe = data.me || "";
    const changed = JSON.stringify(next) !== JSON.stringify(tmRooms);
    tmRooms = next;
    tmUpdateNavBadge();
    if (!changed && document.getElementById("tmRooms")?.children.length) return;
  } catch (e) { console.error("chat rooms:", e); }
  tmRenderRooms();
}

function tmRenderRooms() {
  tmUpdateNavBadge();
  const box = document.getElementById("tmRooms");
  if (!box) return;
  if (!tmRooms.length) {
    box.innerHTML = '<div class="tmPlaceholder" style="padding:24px 10px;text-align:center;">Чатов пока нет</div>';
    return;
  }
  box.innerHTML = tmRooms.map(r => `
    <div class="tmRoom ${r.id === tmRoomId ? "active" : ""}" data-room="${r.id}">
      <div class="tmRoomTop">
        <span class="tmRoomName">${planEsc(r.title || "Без названия")}</span>
        ${r.unread ? `<span class="tmBadge">${r.unread}</span>` : ""}
      </div>
      <div class="tmRoomLast">${r.last_body ? planEsc((r.last_author ? r.last_author + ": " : "") + r.last_body).slice(0, 60) : "нет сообщений"}</div>
    </div>
  `).join("");
}

async function tmOpenRoom(roomId) {
  tmRoomId = roomId;
  tmLastAt = "";
  tmSeen.clear();
  tmLoading = false;
  tmPending = [];
  tmRenderPending();
  const room = tmRooms.find(r => r.id === roomId);
  document.getElementById("tmRoomTitle").textContent = room ? (room.title || "Чат") : "Чат";
  document.getElementById("tmRoomSub").textContent = room
    ? (room.kind === "dm" ? "Личный чат" : `Участников: ${(room.members || []).length}`) : "";
  document.getElementById("tmComposer").style.display = "flex";
  document.getElementById("tmRoomDelete").style.display = "grid";
  const addBox = document.getElementById("tmAddBox");
  if (addBox) {
    addBox.style.display = (room && room.kind === "group") ? "block" : "none";
    const inp = document.getElementById("tmAddEmail");
    if (inp) inp.value = "";
    document.getElementById("tmSuggest")?.classList.remove("open");
  }
  document.getElementById("tmMessages").innerHTML = '<div class="tmPlaceholder">Загружаю...</div>';
  tmRenderRooms();
  await tmLoadMessages(true);
  fetch(`/api/chat/rooms/${encodeURIComponent(roomId)}/read`, { method: "POST" }).then(() => tmLoadRooms());
}

async function tmLoadMessages(full) {
  if (!tmRoomId) return;
  // Пока идёт одна загрузка, вторую не пускаем: иначе поллинг успевает
  // запросить всю историю до того, как выставится tmLastAt, и дублирует её.
  if (tmLoading) return;
  if (!full && !tmLastAt) full = true;
  tmLoading = true;
  const _room = tmRoomId;
  try {
    const url = `/api/chat/rooms/${encodeURIComponent(tmRoomId)}/messages` + (!full && tmLastAt ? `?after=${encodeURIComponent(tmLastAt)}` : "");
    const res = await fetch(url);
    const data = await res.json();
    const msgs = data.messages || [];
    if (data.me) tmMe = data.me;
    const box = document.getElementById("tmMessages");
    if (_room !== tmRoomId) return;   // пока грузили, переключили комнату
    if (full) { box.innerHTML = ""; tmSeen.clear(); box.dataset.lastDay = ""; }
    if (full && !msgs.length) {
      box.innerHTML = '<div class="tmPlaceholder">Сообщений пока нет — напиши первым</div>';
      return;
    }
    if (msgs.length && box.querySelector(".tmPlaceholder")) box.innerHTML = "";
    let lastDay = box.dataset.lastDay || "";
    msgs.forEach(m => {
      if (m.id && tmSeen.has(m.id)) return;
      if (m.id) tmSeen.add(m.id);
      const day = tmDayLabel(m.created_at);
      if (day !== lastDay) {
        const d = document.createElement("div");
        d.className = "tmDay";
        d.textContent = day;
        box.appendChild(d);
        lastDay = day;
      }
      const mine = m.author_email === tmMe;
      const el = document.createElement("div");
      el.className = "tmMsg" + (mine ? " mine" : "");
      el.innerHTML =
        (mine ? "" : `<div class="tmMsgWho">${planEsc(m.author_name || "")}</div>`) +
        (m.body ? `<div class="tmMsgBody">${planEsc(m.body)}</div>` : "") +
        `<div class="tmMsgTime">${tmTime(m.created_at)}${mine ? `<span class="tmTick" data-at="${planEsc(m.created_at)}"></span>` : ""}</div>`;
      tmRenderAttachments(el, m.attachments || []);
      if (m.body) {
        const cp = document.createElement("button");
        cp.className = "tmCopy";
        cp.title = "Копировать";
        cp.textContent = "⧉";
        cp.onclick = () => tmCopy(m.body, cp);
        el.appendChild(cp);
      }
      box.appendChild(el);
      tmLastAt = m.created_at;
    });
    box.dataset.lastDay = lastDay;
    tmUpdateTicks(data.reads);
    if (!full && msgs.some(m => m.author_email !== tmMe)) {
      fetch(`/api/chat/rooms/${encodeURIComponent(_room)}/read`, { method: "POST" });
    }
    if (msgs.length) box.scrollTop = box.scrollHeight;
  } catch (e) {
    console.error("chat messages:", e);
  } finally {
    tmLoading = false;
  }
}

const TM_TICK1 = '<svg viewBox="0 0 18 12" width="15" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6.5l3 3L11 3"/></svg>';
const TM_TICK2 = '<svg viewBox="0 0 18 12" width="17" height="11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 6.5l3 3L10.5 3"/><path d="M8 8l1.5 1.5L16 3"/></svg>';

function tmUpdateTicks(reads) {
  const box = document.getElementById("tmMessages");
  if (!box) return;
  const times = (reads || []).map(t => new Date(t).getTime()).filter(Boolean);
  const lastRead = times.length ? Math.max(...times) : 0;
  box.querySelectorAll(".tmTick").forEach(t => {
    const read = !!lastRead && new Date(t.dataset.at).getTime() <= lastRead;
    const state = read ? "1" : "0";
    if (t.dataset.read === state) return;
    t.dataset.read = state;
    t.classList.toggle("read", read);
    t.innerHTML = read ? TM_TICK2 : TM_TICK1;
    t.title = read ? "Прочитано" : "Отправлено";
  });
}

function tmSize(n) {
  n = n || 0;
  if (n < 1024) return n + " Б";
  if (n < 1048576) return (n / 1024).toFixed(0) + " КБ";
  return (n / 1048576).toFixed(1) + " МБ";
}

function tmRenderAttachments(el, list) {
  if (!list.length) return;
  const wrap = document.createElement("div");
  wrap.className = "tmAtt";
  list.forEach(a => {
    if (!a.url) return;
    if ((a.mime || "").startsWith("image/")) {
      const img = document.createElement("img");
      img.src = a.url;
      img.alt = a.name || "";
      img.loading = "lazy";
      img.onclick = () => window.open(a.url, "_blank");
      img.onload = () => { const b = document.getElementById("tmMessages"); if (b) b.scrollTop = b.scrollHeight; };
      wrap.appendChild(img);
    } else {
      const link = document.createElement("a");
      link.className = "tmFileLink";
      link.href = a.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `📄 ${a.name || "файл"} · ${tmSize(a.size)}`;
      wrap.appendChild(link);
    }
  });
  el.insertBefore(wrap, el.querySelector(".tmMsgTime"));
}

async function tmCopy(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const t = document.createElement("textarea");
    t.value = text; document.body.appendChild(t); t.select();
    document.execCommand("copy"); t.remove();
  }
  if (btn) { btn.textContent = "✓"; setTimeout(() => btn.textContent = "⧉", 1000); }
}

function tmAddFiles(files) {
  for (const f of files) {
    if (f.size > 10 * 1024 * 1024) { alert(`«${f.name}» больше 10 МБ`); continue; }
    if (tmPending.length >= 10) break;
    tmPending.push(f);
  }
  tmRenderPending();
}

function tmRenderPending() {
  const box = document.getElementById("tmPending");
  if (!box) return;
  box.classList.toggle("open", tmPending.length > 0);
  box.innerHTML = "";
  tmPending.forEach((f, i) => {
    const item = document.createElement("div");
    item.className = "tmPendItem";
    if ((f.type || "").startsWith("image/")) {
      const img = document.createElement("img");
      img.src = URL.createObjectURL(f);
      item.appendChild(img);
    }
    const s = document.createElement("span");
    s.textContent = f.name || "картинка";
    item.appendChild(s);
    const del = document.createElement("button");
    del.className = "tmPendDel";
    del.textContent = "✕";
    del.onclick = () => { tmPending.splice(i, 1); tmRenderPending(); };
    item.appendChild(del);
    box.appendChild(item);
  });
}

function tmFileToB64(file) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(String(r.result).split(",")[1] || "");
    r.onerror = () => rej(new Error("Не прочитался файл"));
    r.readAsDataURL(file);
  });
}

async function tmCompressImage(file) {
  const type = file.type || "";
  if (!type.startsWith("image/") || type === "image/gif" || file.size < 300 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const MAX = 2000;
    const k = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * k);
    const h = Math.round(bmp.height * k);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d").drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(r => canvas.toBlob(r, "image/webp", 0.85));
    if (!blob || blob.size >= file.size) return file;
    const outType = blob.type || "image/webp";
    const ext = outType.split("/")[1] || "webp";
    const name = (file.name || "image").replace(/\.[^.]+$/, "") + "." + ext;
    return new File([blob], name, { type: outType });
  } catch {
    return file;
  }
}

async function tmUpload(file) {
  file = await tmCompressImage(file);
  const data = await tmFileToB64(file);
  const res = await fetch(`/api/chat/rooms/${encodeURIComponent(tmRoomId)}/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: file.name || "image.png", mime: file.type || "application/octet-stream", data }),
  });
  const out = await res.json();
  if (!res.ok || !out.ok) throw new Error(out.detail || "Файл не загрузился");
  return out.file;
}

async function tmSend() {
  const input = document.getElementById("tmInput");
  const text = input.value.trim();
  if ((!text && !tmPending.length) || !tmRoomId) return;
  const files = tmPending.slice();
  const attachments = [];
  if (files.length) {
    const btn = document.getElementById("tmSend");
    btn.disabled = true; btn.textContent = "Загружаю...";
    try {
      attachments.push(...(await Promise.all(files.map(tmUpload))));
    } catch (e) {
      alert(e.message || "Файл не загрузился");
      btn.disabled = false; btn.textContent = "Отправить";
      return;
    }
    btn.disabled = false; btn.textContent = "Отправить";
  }
  tmPending = [];
  tmRenderPending();
  input.value = "";
  input.style.height = "";
  // Собеседник обычно отвечает сразу — 15 секунд после отправки
  // проверяем чаще, потом возвращаемся к обычному ритму.
  for (let i = 1; i <= 15; i++) {
    setTimeout(() => { if (tmRoomId) tmLoadMessages(false); }, i * 900);
  }
  try {
    const res = await fetch(`/api/chat/rooms/${encodeURIComponent(tmRoomId)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: text, attachments }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.detail || `HTTP ${res.status}`);
    }
    await tmLoadMessages(false);
    tmLoadRooms();
  } catch (e) {
    input.value = text;
    alert("Сообщение не отправилось: " + (e.message || e));
  }
}

async function tmOpenCreate(kind) {
  tmCreateKind = kind;
  tmPicked = new Set();
  const isAdd = kind === "add";
  document.getElementById("tmCreateTitle").textContent =
    isAdd ? "Добавить участников" : (kind === "dm" ? "Личный чат" : "Новая группа");
  document.getElementById("tmTitleWrap").style.display = (kind === "group") ? "block" : "none";
  document.getElementById("tmPickLabel").textContent = kind === "dm" ? "С кем общаться" : "Кого добавить";
  document.getElementById("tmCreateSend").textContent = isAdd ? "Добавить" : "Создать";
  document.getElementById("tmGroupTitle").value = "";
  const r = document.getElementById("tmCreateResult");
  r.textContent = ""; r.className = "result";

  const box = document.getElementById("tmPeopleList");
  box.innerHTML = "Загружаю...";
  let allPeople = [];
  try {
    const res = await fetch("/api/chat/people");
    const data = await res.json();
    allPeople = data.people || [];
    planNames = { ...planNames, ...(data.names || {}) };
    if (data.me) planMe = data.me;
  } catch (e) { console.error("chat people:", e); }
  const inRoom = isAdd
    ? new Set((tmRooms.find(r => r.id === tmRoomId)?.members) || [])
    : new Set();
  const others = allPeople
    .filter(p => p !== planMe && !inRoom.has(p))
    .sort((a, b) => planShortName(a).localeCompare(planShortName(b), "ru"));

  const draw = (q) => {
    const term = (q || "").trim().toLowerCase();
    const rows = term
      ? others.filter(p => p.toLowerCase().includes(term) || planShortName(p).toLowerCase().includes(term))
      : others;
    if (!others.length) {
      box.innerHTML = '<div class="tmPlaceholder" style="padding:16px 0;">Кроме тебя, на сайте пока никто не зарегистрирован.</div>';
      return;
    }
    box.innerHTML = rows.length ? rows.map(p => `
      <label class="tmPerson">
        <input type="${kind === "dm" ? "radio" : "checkbox"}" name="tmPerson" value="${planEsc(p)}" ${tmPicked.has(p) ? "checked" : ""} />
        <span>${planEsc(planShortName(p))}</span>
        <small style="margin-left:auto;color:var(--text3);font:400 11px 'Inter',sans-serif;">${planEsc(p)}</small>
      </label>
    `).join("") : '<div class="tmPlaceholder" style="padding:16px 0;">Никого не найдено</div>';
  };

  draw("");

  const search = document.getElementById("tmPeopleSearch");
  if (search) {
    search.value = "";
    search.oninput = () => draw(search.value);
  }

  box.onchange = (e) => {
    const inp = e.target.closest("input");
    if (!inp) return;
    if (kind === "dm") { tmPicked.clear(); tmPicked.add(inp.value); }
    else if (inp.checked) tmPicked.add(inp.value);
    else tmPicked.delete(inp.value);
  };

  document.getElementById("tmCreateModal").classList.add("open");
}

function tmUpdateNavBadge() {
  const btn = document.querySelector('.navBtn[data-page="tasks"]');
  if (!btn) return;
  const total = tmRooms.reduce((s, r) => s + (r.unread || 0), 0);
  let b = btn.querySelector(".tmNavBadge");
  if (!b) {
    b = document.createElement("span");
    b.className = "tmBadge tmNavBadge";
    b.style.marginLeft = "auto";
    btn.appendChild(b);
  }
  b.textContent = total;
  b.style.display = total ? "" : "none";
}


const _tmBaseTitle = document.title;

function tmUpdateNavBadge() {
  const btn = document.querySelector('.navBtn[data-page="tasks"]');
  if (!btn) return;
  const total = tmRooms.reduce((s, r) => s + (r.unread || 0), 0);
  let b = btn.querySelector(".navBadge");
  if (!b) {
    b = document.createElement("span");
    b.className = "navBadge";
    btn.appendChild(b);
  }
  b.textContent = total > 99 ? "99+" : String(total);
  b.style.display = total ? "" : "none";
  document.title = total ? `(${total}) ${_tmBaseTitle}` : _tmBaseTitle;
}

setTimeout(tmLoadRooms, 1500);
setInterval(() => {
  const page = document.getElementById("tasksPage");
  if (page && page.classList.contains("activePage")) return;
  tmLoadRooms();
}, 5000);

let _tmInited = false;

function initChatPage() {
  if (!_tmInited) {
    _tmInited = true;

    document.getElementById("tmNewGroup")?.addEventListener("click", () => tmOpenCreate("group"));
    document.getElementById("tmNewDm")?.addEventListener("click", () => tmOpenCreate("dm"));
    const addInp = document.getElementById("tmAddEmail");
    const sugg = document.getElementById("tmSuggest");

    async function tmAddMember(email) {
      try {
        const res = await fetch(`/api/chat/rooms/${encodeURIComponent(tmRoomId)}/members`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ members: [email] }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.detail || "Ошибка");
        addInp.value = "";
        sugg.classList.remove("open");
        await tmLoadRooms();
        tmOpenRoom(tmRoomId);
      } catch (err) {
        sugg.innerHTML = `<div class="tmSuggestEmpty">${planEsc(err.message)}</div>`;
        sugg.classList.add("open");
      }
    }

    let _tmSearchT = null;
    addInp?.addEventListener("input", () => {
      const q = addInp.value.trim();
      clearTimeout(_tmSearchT);
      if (q.length < 2) { sugg.classList.remove("open"); return; }
      _tmSearchT = setTimeout(async () => {
        try {
          const res = await fetch("/api/chat/search-users?q=" + encodeURIComponent(q));
          const data = await res.json();
          const room = tmRooms.find(r => r.id === tmRoomId);
          const inRoom = new Set((room?.members) || []);
          const hits = (data.users || []).filter(u => !inRoom.has(u.email));
          sugg.innerHTML = hits.length
            ? hits.map(u => `
                <div class="tmSuggestItem" data-mail="${planEsc(u.email)}">
                  <div class="tmSuggestName">${planEsc(u.name)}</div>
                  <div class="tmSuggestMail">${planEsc(u.email)}</div>
                </div>`).join("")
            : '<div class="tmSuggestEmpty">Не найден среди зарегистрированных</div>';
          sugg.classList.add("open");
        } catch (e) {
          sugg.innerHTML = '<div class="tmSuggestEmpty">Ошибка поиска</div>';
          sugg.classList.add("open");
        }
      }, 250);
    });

    sugg?.addEventListener("click", (e) => {
      const item = e.target.closest("[data-mail]");
      if (item) tmAddMember(item.dataset.mail);
    });

    addInp?.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const first = sugg.querySelector("[data-mail]");
      if (first) tmAddMember(first.dataset.mail);
    });

    document.addEventListener("click", (e) => {
      if (!e.target.closest(".tmAddBox")) sugg?.classList.remove("open");
    });
    document.getElementById("tmCreateClose")?.addEventListener("click", () =>
      document.getElementById("tmCreateModal").classList.remove("open"));

    document.getElementById("tmRooms")?.addEventListener("click", (e) => {
      const el = e.target.closest("[data-room]");
      if (el) tmOpenRoom(el.dataset.room);
    });

    document.getElementById("tmSend")?.addEventListener("click", tmSend);
    const tmInp = document.getElementById("tmInput");
    tmInp?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); tmSend(); }
    });
    tmInp?.addEventListener("input", () => {
      tmInp.style.height = "auto";
      tmInp.style.height = Math.min(tmInp.scrollHeight, 140) + "px";
    });
    // Ctrl+V: скрин/картинка → во вложения; обычный текст вставляется как есть
    tmInp?.addEventListener("paste", (e) => {
      const files = [...(e.clipboardData?.files || [])];
      if (!files.length || e.clipboardData.getData("text/plain")) return;
      e.preventDefault();
      tmAddFiles(files);
    });
    document.getElementById("tmAttach")?.addEventListener("click", () => document.getElementById("tmFile").click());
    document.getElementById("tmFile")?.addEventListener("change", (e) => {
      tmAddFiles([...e.target.files]);
      e.target.value = "";
    });
    const tmDrop = document.getElementById("tmMessages");
    tmDrop?.addEventListener("dragover", (e) => { if (tmRoomId) { e.preventDefault(); tmDrop.classList.add("drag"); } });
    tmDrop?.addEventListener("dragleave", () => tmDrop.classList.remove("drag"));
    tmDrop?.addEventListener("drop", (e) => {
      tmDrop.classList.remove("drag");
      if (!tmRoomId) return;
      e.preventDefault();
      tmAddFiles([...(e.dataTransfer?.files || [])]);
    });

    document.getElementById("tmRoomDelete")?.addEventListener("click", async () => {
      if (!tmRoomId) return;
      if (!confirm("Удалить чат или выйти из него?")) return;
      await fetch(`/api/chat/rooms/${encodeURIComponent(tmRoomId)}`, { method: "DELETE" });
      tmRoomId = null;
      document.getElementById("tmMessages").innerHTML = '<div class="tmPlaceholder">Слева выбери диалог или создай новый</div>';
      document.getElementById("tmComposer").style.display = "none";
      document.getElementById("tmRoomDelete").style.display = "none";
      document.getElementById("tmRoomTitle").textContent = "Выбери чат";
      document.getElementById("tmRoomSub").textContent = "";
      tmLoadRooms();
    });

    document.getElementById("tmCreateSend")?.addEventListener("click", async () => {
      const picked = [...tmPicked];
      const title = document.getElementById("tmGroupTitle").value.trim();
      const r = document.getElementById("tmCreateResult");

      if (tmCreateKind === "add") {
        if (!picked.length) { r.textContent = "Выбери хотя бы одного."; r.className = "result bad"; return; }
        try {
          const res = await fetch(`/api/chat/rooms/${encodeURIComponent(tmRoomId)}/members`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ members: picked }),
          });
          const data = await res.json();
          if (!res.ok || !data.ok) throw new Error(data.detail || "Ошибка");
          document.getElementById("tmCreateModal").classList.remove("open");
          await tmLoadRooms();
          tmOpenRoom(tmRoomId);
        } catch (err) {
          r.textContent = err.message || "Не добавилось."; r.className = "result bad";
        }
        return;
      }
      if (tmCreateKind === "dm" && picked.length !== 1) {
        r.textContent = "Выбери одного собеседника."; r.className = "result bad"; return;
      }
      if (tmCreateKind === "group" && !title) {
        r.textContent = "Впиши название группы."; r.className = "result bad"; return;
      }
      try {
        const res = await fetch("/api/chat/rooms", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ kind: tmCreateKind, title, members: picked }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.detail || "Ошибка");
        document.getElementById("tmCreateModal").classList.remove("open");
        await tmLoadRooms();
        tmOpenRoom(data.room_id);
      } catch (err) {
        r.textContent = err.message || "Не создалось."; r.className = "result bad";
      }
    });
  }

  tmLoadRooms();
  clearInterval(tmPollId);
  tmPollId = setInterval(() => {
    const page = document.getElementById("tasksPage");
    if (!page || !page.classList.contains("activePage")) return;
    if (tmRoomId) tmLoadMessages(false);
    tmLoadRooms();
  }, 3000);
}

// ── Колокольчик в топбаре ──
(function () {
  const topBell = document.getElementById("topBell");
  const panel   = document.getElementById("bellPanel");
  const body    = document.getElementById("bellPanelBody");
  const list    = document.getElementById("notificationsList");
  if (!topBell || !panel || !body) return;

  function sync() {
    if (!list) return;
    const html = (list.innerHTML || "").trim();
    body.innerHTML = html || '<div class="bellEmpty">Уведомлений нет</div>';
    body.querySelectorAll(".acceptInviteBtn, .rejectInviteBtn").forEach(btn => {
      btn.onclick = () => {
        const orig = list.querySelector(
          "." + (btn.classList.contains("acceptInviteBtn") ? "acceptInviteBtn" : "rejectInviteBtn") +
          '[data-id="' + btn.dataset.id + '"]'
        );
        if (orig) orig.click();
        panel.classList.remove("open");
      };
    });
  }

  topBell.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = !panel.classList.contains("open");
    panel.classList.toggle("open", willOpen);
    if (willOpen) sync();
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".topBellWrap")) panel.classList.remove("open");
  });

  const oldCount = document.getElementById("notificationsCount");
  const newCount = document.getElementById("topBellCount");
  setInterval(() => {
    if (oldCount && newCount) {
      const v = (oldCount.textContent || "").trim();
      const show = oldCount.style.display !== "none" && v && v !== "0";
      newCount.textContent = v;
      newCount.style.display = show ? "grid" : "none";
    }
    if (panel.classList.contains("open")) sync();
  }, 1500);
})();

// ── Реестр почт ───────────────────────────────────────────
const ML_PLATFORMS = ["Mamba","Twinby"];
const ML_STATUSES = [["free","свободна"],["in_work","в работе"],
                     ["blocked","заблокирована"],["dead","мёртвая"]];
const ML_COLORS = { free:"#64748b", in_work:"#10f5a8", blocked:"#fb7185", dead:"#f43f5e" };

let mlRows = [], mlPeople = [], mlNames = {}, mlPwShown = new Set(), mlInited = false;
let mlMode = "list", mlGroupNotes = {}, mlIsAdmin = false, mlOpenGroups = new Set();
try { const _m = localStorage.getItem("mlMode"); mlMode = ["group","platform"].includes(_m) ? _m : "list"; } catch {}
let mlIsOwner = false, mlMe = "";

function mlName(email) {
  if (!email) return "— никому —";
  return mlNames[email] || email.split("@")[0];
}

async function loadMails() {
  const box = document.getElementById("mailTable");
  if (!box) return;
  try {
    const d = await ctJson("/api/mails");
    mlRows = d.mails || [];
    mlGroupNotes = d.group_notes || {};
    mlIsAdmin = !!d.is_admin;
    mlPeople = d.people || [];
    mlNames = d.names || {};
    mlIsOwner = !!d.is_owner;
    mlMe = d.me || "";
    document.getElementById("mailFilterPerson").style.display = mlIsOwner ? "" : "none";
    const _bw = document.getElementById("mailBulkPersonWrap");
    if (_bw) _bw.style.display = mlIsOwner ? "" : "none";
    const _tc = document.getElementById("mailTotalCount");
    if (_tc) _tc.textContent = mlRows.length ? `(${mlRows.length})` : "";
    mlFillSelects();
    if (!mlInited) { mlInited = true; mlBindEvents(); }
    mlRender();
  } catch (e) {
    box.innerHTML = `<div style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function mlFillSelects() {
  const peopleOpts = mlPeople.map(p =>
    `<option value="${escapeHtml(p)}">${escapeHtml(mlName(p))}</option>`).join("");
  const platOpts = ML_PLATFORMS.map(p =>
    `<option value="${p}">${p}</option>`).join("");

  const fp = document.getElementById("mailFilterPerson");
  const fpl = document.getElementById("mailFilterPlatform");
  const fs = document.getElementById("mailFilterStatus");
  const bp = document.getElementById("mailBulkPerson");
  const bpl = document.getElementById("mailBulkPlatforms");
  if (fp && !fp.dataset.filled) {
    fp.dataset.filled = "1";
    fp.innerHTML = `<option value="">Все сотрудники</option>` + peopleOpts;
  }
  if (fpl && !fpl.dataset.filled) {
    fpl.dataset.filled = "1";
    fpl.innerHTML = `<option value="">Все платформы</option><option value="__none">— без платформы —</option>` + platOpts;
  }
  if (fs && !fs.dataset.filled) {
    fs.dataset.filled = "1";
    fs.innerHTML = `<option value="">Все статусы</option>` +
      ML_STATUSES.map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  }
  if (bp) bp.innerHTML = `<option value="">— никому —</option>` + peopleOpts;
  if (bpl) bpl.innerHTML = ML_PLATFORMS.map(p =>
    `<label style="display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--text);cursor:pointer;">
       <input type="checkbox" class="mlBulkPlat" value="${p}"> ${p}
     </label>`).join("");
}

function mlFiltered() {
  const q = (document.getElementById("mailSearch")?.value || "").trim().toLowerCase();
  const fp = document.getElementById("mailFilterPerson")?.value || "";
  const fpl = document.getElementById("mailFilterPlatform")?.value || "";
  const fs = document.getElementById("mailFilterStatus")?.value || "";
  return mlRows.filter(r => {
    if (fp && (r.assigned_to || "") !== fp) return false;
    if (fpl === "__none" && (r.platform || "")) return false;
    if (fpl && fpl !== "__none" && (r.platform || "") !== fpl) return false;
    if (fs && (r.status || "free") !== fs) return false;
    if (q) {
      const hay = [r.email, r.phone, r.note, r.platform, mlName(r.assigned_to)]
        .join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function mlRender() {
  const box = document.getElementById("mailTable");
  const statsBox = document.getElementById("mailStats");
  if (!box) return;

  const counts = { free: 0, in_work: 0, blocked: 0, dead: 0 };
  mlRows.forEach(r => { counts[r.status || "free"] = (counts[r.status || "free"] || 0) + 1; });
  if (statsBox) {
    statsBox.innerHTML =
      `<span class="mlStat"><b>${mlRows.length}</b> всего</span>` +
      ML_STATUSES.map(([v, t]) =>
        `<span class="mlStat"><span class="mlDot" style="background:${ML_COLORS[v]}"></span><b>${counts[v] || 0}</b> ${t}</span>`
      ).join("");
  }

  document.querySelectorAll(".mlMode").forEach(b =>
    b.classList.toggle("on", b.dataset.mlmode === mlMode));

  const rows = mlFiltered();
  if (!rows.length) {
    box.innerHTML = `<div style="color:var(--text2);padding:20px 0;">Ничего не найдено. Жми «+ Добавить почты».</div>`;
    return;
  }

  if (mlMode === "group") { mlRenderGroups(rows); return; }
  if (mlMode === "platform") { mlRenderPlatforms(rows); return; }

  const peopleOpts = (sel) => `<option value="">— никому —</option>` +
    mlPeople.map(p => `<option value="${escapeHtml(p)}"${p === sel ? " selected" : ""}>${escapeHtml(mlName(p))}</option>`).join("");
  const platOpts = (sel) => `<option value="">—</option>` +
    ML_PLATFORMS.map(p => `<option value="${p}"${p === sel ? " selected" : ""}>${p}</option>`).join("");
  const statOpts = (sel) => ML_STATUSES.map(([v, t]) =>
    `<option value="${v}"${v === (sel || "free") ? " selected" : ""}>${t}</option>`).join("");

  box.innerHTML = mlTableHtml(rows);
}

function mlTableHtml(rows) {
  const peopleOpts = (sel) => `<option value="">— никому —</option>` +
    mlPeople.map(p => `<option value="${escapeHtml(p)}"${p === sel ? " selected" : ""}>${escapeHtml(mlName(p))}</option>`).join("");
  const platOpts = (sel) => `<option value="">—</option>` +
    ML_PLATFORMS.map(p => `<option value="${p}"${p === sel ? " selected" : ""}>${p}</option>`).join("");
  const statOpts = (sel) => ML_STATUSES.map(([v, t]) =>
    `<option value="${v}"${v === (sel || "free") ? " selected" : ""}>${t}</option>`).join("");

  return `
    <table class="mlTable">
      <thead><tr>
        <th style="width:230px;">Почта</th>
        <th style="width:150px;">Пароль</th>
        <th style="width:150px;">Телефон</th>
        ${mlIsOwner ? '<th style="width:160px;">Кому выдана</th>' : ""}
        <th style="width:140px;">Платформа</th>
        <th style="width:150px;">Статус</th>
        <th>Заметка</th>
        <th style="width:40px;"></th>
      </tr></thead>
      <tbody>${rows.map(r => `
        <tr data-id="${r.id}" style="box-shadow:inset 3px 0 0 ${ML_COLORS[r.status || "free"]};background:${ML_COLORS[r.status || "free"]}40;">
          <td><input class="mlMono mlF" data-f="email" value="${escapeHtml(r.email || "")}"${r.owner_email === mlMe ? "" : " readonly"} /></td>
          <td style="display:flex;align-items:center;">
            <input class="mlMono mlF" data-f="password" type="${mlPwShown.has(r.id) ? "text" : "password"}" value="${escapeHtml(r.password || "")}" />
            <button class="mlEye" data-eye="${r.id}">${mlPwShown.has(r.id) ? "🙈" : "👁"}</button>
          </td>
          <td><input class="mlMono mlF" data-f="phone" value="${escapeHtml(r.phone || "")}" /></td>
          ${mlIsOwner ? `<td><select class="mlF" data-f="assigned_to">${peopleOpts(r.assigned_to || "")}</select></td>` : ""}
          <td><select class="mlF" data-f="platform">${platOpts(r.platform || "")}</select></td>
          <td><select class="mlF" data-f="status">${statOpts(r.status)}</select></td>
          <td><input class="mlF" data-f="note" value="${escapeHtml(r.note || "")}" placeholder="—" /></td>
          <td>${r.owner_email === mlMe ? `<button class="mlDel" data-del="${r.id}">✕</button>` : ""}</td>
        </tr>`).join("")}
      </tbody>
    </table>`;
}

function mlPeopleGroupsHtml(rows, scope) {
  const groups = {};
  rows.forEach(r => { const k = r.assigned_to || ""; (groups[k] = groups[k] || []).push(r); });
  const order = Object.keys(groups).sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return mlName(a).localeCompare(mlName(b), "ru");
  });
  return order.map(who => {
    const list = groups[who];
    const c = { free: 0, in_work: 0, blocked: 0, dead: 0 };
    list.forEach(r => { c[r.status || "free"] = (c[r.status || "free"] || 0) + 1; });
    const gk = (scope ? scope + "|" : "") + who;
    const open = mlOpenGroups.has(gk);
    const label = mlGroupNotes[who] || "";
    return `
      <div class="mlGroup${open ? " open" : ""}" data-gk="${ctAttr(gk)}">
        <div class="mlGHead" data-gtoggle="${ctAttr(gk)}">
          <span class="mlGArrow">▶</span>
          <span class="mlGName">${escapeHtml(who ? mlName(who) : "— никому не выдано —")}</span>
          <span class="mlGTotal">${list.length}</span>
        </div>
        <input class="mlGLabel" data-glabel="${ctAttr(who)}"
               value="${escapeHtml(label)}"
               placeholder="${mlIsAdmin ? "что это за почты и для чего" : "—"}"
               ${mlIsAdmin ? "" : "readonly"} />
        <div class="mlGNums">
          ${ML_STATUSES.map(([v, t]) => c[v]
            ? `<span class="mlGNum"><span class="mlDot" style="background:${ML_COLORS[v]}"></span><b>${c[v]}</b> ${t}</span>`
            : "").join("")}
        </div>
        <div class="mlGBody">${open ? mlTableHtml(list) : ""}</div>
      </div>`;
  }).join("");
}

function mlRenderPlatforms(rows) {
  const box = document.getElementById("mailTable");
  const byPlat = {};
  rows.forEach(r => {
    const p = r.platform || "— без платформы —";
    (byPlat[p] = byPlat[p] || []).push(r);
  });
  const plats = Object.keys(byPlat).sort((a, b) => a.localeCompare(b, "ru"));

  box.innerHTML = `<div class="mlGrid">${plats.map(plat => {
    const list = byPlat[plat];
    const c = { free: 0, in_work: 0, blocked: 0, dead: 0 };
    list.forEach(r => { c[r.status || "free"] = (c[r.status || "free"] || 0) + 1; });
    const pk = "plat:" + plat;
    const open = mlOpenGroups.has(pk);
    return `
      <div class="mlGroup${open ? " open" : ""}" data-gk="${ctAttr(pk)}">
        <div class="mlGHead" data-gtoggle="${ctAttr(pk)}">
          <span class="mlGArrow">▶</span>
          <span class="mlGName">${escapeHtml(plat)}</span>
          <span class="mlGTotal">${list.length}</span>
        </div>
        <div class="mlGNums">
          ${ML_STATUSES.map(([v, t]) => c[v]
            ? `<span class="mlGNum"><span class="mlDot" style="background:${ML_COLORS[v]}"></span><b>${c[v]}</b> ${t}</span>`
            : "").join("")}
        </div>
        <div class="mlGBody">${open ? mlPeopleGroupsHtml(list, pk) : ""}</div>
      </div>`;
  }).join("")}</div>`;
}

function mlRenderGroups(rows) {
  const box = document.getElementById("mailTable");
  const groups = {};
  rows.forEach(r => {
    const k = r.assigned_to || "";
    (groups[k] = groups[k] || []).push(r);
  });
  const order = Object.keys(groups).sort((a, b) => {
    if (!a) return 1;
    if (!b) return -1;
    return mlName(a).localeCompare(mlName(b), "ru");
  });

  box.innerHTML = `<div class="mlGrid">${order.map(who => {
    const list = groups[who];
    const c = { free: 0, in_work: 0, blocked: 0, dead: 0 };
    list.forEach(r => { c[r.status || "free"] = (c[r.status || "free"] || 0) + 1; });
    const open = mlOpenGroups.has(who);
    const label = mlGroupNotes[who] || "";
    return `
      <div class="mlGroup${open ? " open" : ""}" data-gk="${ctAttr(who)}">
        <div class="mlGHead" data-gtoggle="${ctAttr(who)}">
          <span class="mlGArrow">▶</span>
          <span class="mlGName">${escapeHtml(who ? mlName(who) : "— никому не выдано —")}</span>
          <span class="mlGTotal">${list.length}</span>
        </div>
        <input class="mlGLabel" data-glabel="${ctAttr(who)}"
               value="${escapeHtml(label)}"
               placeholder="${mlIsAdmin ? "что это за почты и для чего" : "—"}"
               ${mlIsAdmin ? "" : "readonly"} />
        <div class="mlGNums">
          ${ML_STATUSES.map(([v, t]) => c[v]
            ? `<span class="mlGNum"><span class="mlDot" style="background:${ML_COLORS[v]}"></span><b>${c[v]}</b> ${t}</span>`
            : "").join("")}
        </div>
        <div class="mlGBody">${open ? mlTableHtml(list) : ""}</div>
      </div>`;
  }).join("")}</div>`;
}

async function mlSaveGroupLabel(who, label) {
  mlGroupNotes[who] = label;
  try {
    await ctJson("/api/mail-groups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assigned_to: who, label }),
    });
  } catch (e) { alert("Подпись не сохранилась: " + e.message); }
}

async function mlPatch(id, field, value) {
  try {
    await ctJson(`/api/mails/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    const row = mlRows.find(r => r.id === id);
    if (row) row[field] = value;
    if (field === "status") mlRender();
  } catch (e) {
    alert("Не сохранилось: " + e.message);
    loadMails();
  }
}

function mlBindEvents() {
  const pane = document.getElementById("resPane_mine") || document;
  pane.addEventListener("click", e => {
    const m = e.target.closest("[data-mlmode]");
    if (m) {
      mlMode = m.dataset.mlmode;
      try { localStorage.setItem("mlMode", mlMode); } catch {}
      mlRender();
      return;
    }
    const g = e.target.closest("[data-gtoggle]");
    if (g && !e.target.closest(".mlGLabel")) {
      const k = g.dataset.gtoggle;
      mlOpenGroups.has(k) ? mlOpenGroups.delete(k) : mlOpenGroups.add(k);
      mlRender();
    }
  });
  pane.addEventListener("change", e => {
    const l = e.target.closest("[data-glabel]");
    if (l) mlSaveGroupLabel(l.dataset.glabel, l.value.trim());
  });
  const box = document.getElementById("mailTable");

  box.addEventListener("change", (e) => {
    const el = e.target.closest(".mlF");
    if (!el) return;
    const id = el.closest("tr")?.dataset.id;
    if (id) mlPatch(id, el.dataset.f, el.value);
  });

  box.addEventListener("click", async (e) => {
    const eye = e.target.closest("[data-eye]");
    if (eye) {
      const id = eye.dataset.eye;
      mlPwShown.has(id) ? mlPwShown.delete(id) : mlPwShown.add(id);
      mlRender();
      return;
    }
    const del = e.target.closest("[data-del]");
    if (del) {
      const row = mlRows.find(r => r.id === del.dataset.del);
      if (!confirm(`Удалить ${row?.email || "почту"}?`)) return;
      try {
        await ctJson(`/api/mails/${encodeURIComponent(del.dataset.del)}`, { method: "DELETE" });
        mlRows = mlRows.filter(r => r.id !== del.dataset.del);
        mlRender();
      } catch (err) { alert("Не удалилось: " + err.message); }
    }
  });

  ["mailSearch", "mailFilterPerson", "mailFilterPlatform", "mailFilterStatus"].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("input", mlRender);
    if (el) el.addEventListener("change", mlRender);
  });

  document.getElementById("mailRefreshBtn")?.addEventListener("click", loadMails);

  document.getElementById("mailAddBtn")?.addEventListener("click", () => {
    document.getElementById("mailBulk").value = "";
    document.getElementById("mailAddModal").classList.add("open");
  });
  document.getElementById("mailAddCancel")?.addEventListener("click", () => {
    document.getElementById("mailAddModal").classList.remove("open");
  });
  document.getElementById("mailAddSave")?.addEventListener("click", async () => {
    const btn = document.getElementById("mailAddSave");
    const bulk = document.getElementById("mailBulk").value;
    if (!bulk.trim()) { alert("Вставь хотя бы одну почту"); return; }
    btn.disabled = true; btn.textContent = "Добавляю...";
    try {
      const d = await ctJson("/api/mails", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          bulk,
          assigned_to: document.getElementById("mailBulkPerson").value,
          platforms: Array.from(document.querySelectorAll(".mlBulkPlat:checked")).map(c => c.value),
        }),
      });
      document.getElementById("mailAddModal").classList.remove("open");
      await loadMails();
      if (!d.added) alert("Ничего не добавилось — похоже, такие почты уже есть в списке.");
      else if (d.skipped) alert(`Добавлено: ${d.added}. Пропущено дублей: ${d.skipped}`);
    } catch (e) {
      alert("Ошибка: " + e.message);
    } finally {
      btn.disabled = false; btn.textContent = "Добавить";
    }
  });
}

// ── Выгрузка отчёта по сотруднику ─────────────────────────
function tlrExport() {
  const d = tlr.data || {};
  const all = d.rows || [];
  const rows = (tlr.filter ? all.filter(r => r.user_email === tlr.filter) : all)
    .slice().sort((a, b) => a.day.localeCompare(b.day) || (a.shift || "").localeCompare(b.shift || ""));

  if (!rows.length) { alert("За этот месяц назначений нет."); return; }

  const who = tlr.filter
    ? (rows[0].user_name || tlr.filter)
    : "Вся команда";
  const period = tlrMonthTitle();

  const grand = rows.reduce((s, r) => s + r.total, 0);
  const shifts = rows.length;
  const visits = rows.reduce((s, r) => s + (r.out?.visits || 0), 0);
  const books  = rows.reduce((s, r) => s + (r.out?.bookings || 0), 0);
  const cancel = rows.reduce((s, r) => s + (r.out?.cancels || 0), 0);

  // Итог по каждому нику за весь период
  const byTg = {};
  rows.forEach(r => r.contacts.forEach(c => {
    const k = c.tg.toLowerCase();
    byTg[k] = (byTg[k] || 0) + (c.leads || 0);
  }));
  const tgTotals = Object.entries(byTg).sort((a, b) => b[1] - a[1]);

  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const WD = ["воскресенье","понедельник","вторник","среда","четверг","пятница","суббота"];
  const dayTitle = iso => {
    const dt = new Date(iso + "T12:00:00");
    return `${String(dt.getDate()).padStart(2,"0")}.${String(dt.getMonth()+1).padStart(2,"0")}.${dt.getFullYear()}, ${WD[dt.getDay()]}`;
  };
  const shiftName = s =>
    ({ day: "дневная", night: "ночная", morning: "утренняя", evening: "вечерняя" })[s] || (s || "смена");

  const blocks = rows.map(r => {
    const lines = (r.contacts || []).slice()
      .sort((a, b) => (b.leads || 0) - (a.leads || 0))
      .map(c => `
        <tr>
          <td class="tg">@${esc(c.tg)}</td>
          <td class="num">${c.leads || 0}</td>
          <td class="num dim">${c.visits == null ? "—" : c.visits}</td>
          <td class="num dim">${c.bookings == null ? "—" : c.bookings}</td>
          <td class="num dim">${c.cancels == null ? "—" : c.cancels}</td>
        </tr>`).join("");

    return `
      <section class="shift">
        <div class="shiftHead">
          <div>
            <div class="day">${esc(dayTitle(r.day))}</div>
            <div class="sub">${esc(shiftName(r.shift))} · ${esc(r.window || "")}</div>
          </div>
          <div class="shiftTotal"><b>${r.total}</b><span>лидов за смену</span></div>
        </div>
        ${r.note ? `<div class="note">${esc(r.note)}</div>` : ""}
        <table>
          <thead><tr><th>Telegram</th><th class="num">Лиды</th><th class="num">Заходы</th><th class="num">Брони</th><th class="num">Отмены</th></tr></thead>
          <tbody>${lines || '<tr><td colspan="5" class="dim">ники не назначены</td></tr>'}</tbody>
        </table>
      </section>`;
  }).join("");

  const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8">
<title>Отчёт — ${esc(who)} — ${esc(period)}</title>
<style>
  *{box-sizing:border-box;}
  body{margin:0;padding:32px;background:#f6f7f9;color:#14161a;
       font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;}
  .sheet{max-width:860px;margin:0 auto;background:#fff;border-radius:14px;
         box-shadow:0 2px 24px rgba(0,0,0,.08);padding:36px 40px;}
  h1{margin:0 0 4px;font-size:24px;letter-spacing:-.01em;}
  .period{color:#6b7280;font-size:14px;margin-bottom:26px;}
  .kpis{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:30px;}
  .kpi{flex:1;min-width:120px;border:1px solid #e5e7eb;border-radius:11px;padding:13px 15px;}
  .kpi b{display:block;font-size:26px;line-height:1.1;font-variant-numeric:tabular-nums;}
  .kpi span{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;}
  h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:#6b7280;
     margin:30px 0 12px;padding-bottom:7px;border-bottom:1px solid #e5e7eb;}
  table{width:100%;border-collapse:collapse;}
  th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;
     color:#9ca3af;font-weight:600;padding:7px 10px;border-bottom:1px solid #e5e7eb;}
  td{padding:8px 10px;border-bottom:1px solid #f1f2f4;}
  tr:last-child td{border-bottom:none;}
  .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
  .dim{color:#9ca3af;}
  .tg{font-family:ui-monospace,Menlo,Consolas,monospace;}
  .shift{border:1px solid #e5e7eb;border-radius:12px;padding:16px 18px;margin-bottom:14px;
         break-inside:avoid;}
  .shiftHead{display:flex;justify-content:space-between;align-items:flex-start;
             gap:16px;margin-bottom:12px;}
  .day{font-weight:700;font-size:15px;}
  .sub{color:#6b7280;font-size:12px;margin-top:2px;}
  .shiftTotal{text-align:right;}
  .shiftTotal b{display:block;font-size:22px;line-height:1;font-variant-numeric:tabular-nums;}
  .shiftTotal span{font-size:10px;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;}
  .note{background:#f9fafb;border-left:3px solid #d1d5db;padding:7px 11px;
        margin-bottom:11px;font-size:13px;color:#4b5563;}
  .foot{margin-top:28px;padding-top:14px;border-top:1px solid #e5e7eb;
        color:#9ca3af;font-size:12px;}
  @media print{body{background:#fff;padding:0;} .sheet{box-shadow:none;max-width:none;}}
</style></head>
<body><div class="sheet">
  <h1>${esc(who)}</h1>
  <div class="period">Отчёт по лидам · ${esc(period)}</div>

  <div class="kpis">
    <div class="kpi"><b>${grand}</b><span>лидов всего</span></div>
    <div class="kpi"><b>${shifts}</b><span>смен</span></div>
    <div class="kpi"><b>${shifts ? (grand / shifts).toFixed(1) : 0}</b><span>лидов за смену</span></div>
    <div class="kpi"><b>${visits}</b><span>заходов</span></div>
    <div class="kpi"><b>${books}</b><span>броней</span></div>
    <div class="kpi"><b>${cancel}</b><span>отмен</span></div>
  </div>

  <h2>Итого по Telegram-аккаунтам</h2>
  <table>
    <thead><tr><th>Telegram</th><th class="num">Лидов за период</th></tr></thead>
    <tbody>${tgTotals.map(([tg, n]) =>
      `<tr><td class="tg">@${esc(tg)}</td><td class="num">${n}</td></tr>`).join("")
      || '<tr><td colspan="2" class="dim">нет данных</td></tr>'}</tbody>
  </table>

  <h2>По сменам</h2>
  ${blocks}

  <div class="foot">Сформировано ${new Date().toLocaleString("ru-RU")} · CLAW-AI Manager</div>
</div></body></html>`;

  const safe = who.replace(/[^\wа-яёА-ЯЁ -]/gi, "").trim().replace(/\s+/g, "_");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  a.download = `Отчёт_${safe}_${tlr.month}.html`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

document.getElementById("tlrExportBtn")?.addEventListener("click", tlrExport);

// ── Вкладки раздела «Ресурсы» ─────────────────────────────
let resTab = "mine";

function resSwitch(tab) {
  resTab = tab;
  document.querySelectorAll(".resTab").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === tab));
  document.querySelectorAll(".resPane").forEach(p =>
    p.style.display = p.id === `resPane_${tab}` ? "" : "none");

  // Кнопки шапки относятся только к почтам
  const act = document.getElementById("mailActions");
  if (act) act.style.display = tab === "mine" ? "flex" : "none";

  try { localStorage.setItem("claw_res_tab", tab); } catch {}

  if (tab === "asset") assetLoad();
  if (tab === "proxy") proxyLoad();
  if (tab === "keys")  keysLoad();
  if (tab === "base")  baseLoad();
}

document.getElementById("resTabs")?.addEventListener("click", e => {
  const b = e.target.closest(".resTab");
  if (b) resSwitch(b.dataset.tab);
});

// Заглушки — наполним на следующих шагах
const AS_STATUSES = [["verif","ВЕРИФ"],["not_verif","НЕ ВЕРИФ"],["ban","БАН"]];
let asRows = [], asPeople = [], asNames = {}, asIsOwner = false, asMe = "";
let asPlat = "", asPwShown = new Set(), asInited = false;
let asPicked = "";
let asOwner = "";      // "" — все, "__me" — мои, "__none" — ничьи, иначе email
const AS_COLOR = { verif: "#2ee08a", ban: "#ff5c85", not_verif: "#646674" };
const AS_LABEL = { verif: "ВЕРИФ", ban: "БАН", not_verif: "НЕ ВЕРИФ" };

function asCols() {
  return "minmax(130px,.9fr) minmax(200px,1.7fr) 128px minmax(130px,1.1fr) 108px 106px"
    + (asIsOwner ? " 96px" : "") + " minmax(110px,1fr) 86px";
}

function asName(email) {
  if (!email) return "— никому —";
  return asNames[email] || email.split("@")[0];
}

async function assetLoad() {
  const pane = document.getElementById("resPane_asset");
  if (!pane) return;
  if (!asInited) {
    pane.innerHTML = `
      <div class="asBar" id="asBar"></div>
      <div class="asBar" id="asOwnerBar" style="margin-top:-4px;"></div>
      <div class="asStats" id="asStats"></div>
      <div id="asGrid"><div class="asEmpty">Загрузка...</div></div>`;
    // Панель только на body: .bigPanel с backdrop-filter обрезала бы position:fixed
    if (!document.getElementById("asDrawer")) {
      const dr = document.createElement("aside");
      dr.className = "asDrawer";
      dr.id = "asDrawer";
      document.body.appendChild(dr);
      dr.addEventListener("change", asOnChange);
      dr.addEventListener("click", asOnClick);
      document.addEventListener("keydown", ev => {
        if (ev.key === "Escape" && asPicked) { asPicked = ""; asDrawerRender(); asRender(); }
      });
    }
    asInited = true;
    pane.addEventListener("change", asOnChange);
    pane.addEventListener("click", asOnClick);
  }
  try {
    const d = await ctJson("/api/assets");
    asRows = d.assets || [];
    asPeople = d.people || [];
    asNames = d.names || {};
    asIsOwner = !!d.is_owner;
    asMe = d.me || "";
    asRender();
    asDrawerRender();
  } catch (e) {
    pane.querySelector("#asGrid").innerHTML =
      `<div class="asEmpty" style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function asRender() {
  const bar = document.getElementById("asBar");
  const grid = document.getElementById("asGrid");
  const stats = document.getElementById("asStats");
  const cnt = document.getElementById("assetCount");
  if (cnt) cnt.textContent = asRows.length ? asRows.length : "";

  const byPlat = {};
  asRows.forEach(r => { const p = r.platform || "—"; byPlat[p] = (byPlat[p] || 0) + 1; });

  bar.innerHTML =
    `<button class="asChip${asPlat ? "" : " on"}" data-plat="">Все <b>${asRows.length}</b></button>` +
    ML_PLATFORMS.map(p => {
      const n = byPlat[p] || 0;
      return `<button class="asChip${asPlat === p ? " on" : ""}" data-plat="${p}">${p}${n ? ` <b>${n}</b>` : ""}</button>`;
    }).join("") +
    `<button class="asChip" id="asAddBtn" style="margin-left:auto;background:rgba(34,211,238,.1);color:var(--cyan);border-color:rgba(34,211,238,.3);">+ Добавить ноду</button>`;

  let rows = asPlat ? asRows.filter(r => (r.platform || "") === asPlat) : asRows;

  // Чипы по владельцу — только у владельца команды, остальные и так видят своё
  const ownerBar = document.getElementById("asOwnerBar");
  if (ownerBar) {
    if (asIsOwner) {
      const cnt = e => rows.filter(r => (r.assigned_to || "") === e).length;
      const chip = (val, label, n) =>
        `<button class="asChip${asOwner === val ? " on" : ""}" data-owner="${val}">` +
        `${label}${n ? ` <b>${n}</b>` : ""}</button>`;
      const used = [...new Set(rows.map(r => r.assigned_to || "").filter(Boolean))]
        .sort((a, b) => asName(a).localeCompare(asName(b), "ru"));
      ownerBar.innerHTML =
        chip("", "Все", rows.length) +
        chip("__me", "Мои", cnt(asMe)) +
        used.filter(e => e !== asMe).map(e => chip(e, escapeHtml(asName(e)), cnt(e))).join("") +
        chip("__none", "Ничьи", cnt(""));
    } else {
      ownerBar.innerHTML = "";
    }
  }

  if (asOwner === "__me") rows = rows.filter(r => (r.assigned_to || "") === asMe);
  else if (asOwner === "__none") rows = rows.filter(r => !(r.assigned_to || "").trim());
  else if (asOwner) rows = rows.filter(r => (r.assigned_to || "") === asOwner);

  if (stats) {
    const by = {};
    rows.forEach(r => { const s = r.status || "not_verif"; by[s] = (by[s] || 0) + 1; });
    stats.innerHTML =
      `<div class="asStat"><i style="background:var(--cyan)"></i><b>${rows.length}</b><span>всего</span></div>` +
      AS_STATUSES.map(([v, t]) =>
        `<div class="asStat"><i style="background:${AS_COLOR[v]}"></i><b>${by[v] || 0}</b><span>${t.toLowerCase()}</span></div>`
      ).join("");
  }

  if (!rows.length) {
    grid.innerHTML = `<div class="asEmpty">Пусто. Жми «+ Добавить ноду».</div>`;
    return;
  }

  const cols = asCols();
  const cp = v => v ? `<button class="asCp" data-copy="${escapeHtml(v)}" title="Копировать">⧉</button>` : "";

  grid.innerHTML = `
    <div class="asTable"><div class="asScroll"><div class="asInner">
      <div class="asTh" style="--asCols:${cols}">
        <div>Нода</div><div>Почта</div><div>Пароль</div><div>Телеграм</div>
        <div>Платформа</div><div>Статус</div>${asIsOwner ? "<div>Чья</div>" : ""}
        <div>Заметка</div><div style="text-align:right">Телефон</div>
      </div>
      ${rows.map(r => {
        const st = r.status || "not_verif";
        const c = AS_COLOR[st];
        const pw = asPwShown.has(r.id) ? escapeHtml(r.password || "—") : "••••••••";
        return `
        <div class="asTr${asPicked === r.id ? " sel" : ""}" data-id="${r.id}" data-row="1" style="--asCols:${cols}">
          <div class="asCell asNode"><span class="asDot" style="background:${c}"></span>${escapeHtml(r.title || "без имени")}</div>
          <div class="asCell asMono">${escapeHtml(r.email || "—")}${cp(r.email)}</div>
          <div class="asCell asMono">${pw}<button class="asCp" data-eye="${r.id}" title="Показать">👁</button>${cp(r.password)}</div>
          <div class="asCell asMono" style="color:var(--blue)">${escapeHtml(r.telegram || "—")}${cp(r.telegram)}</div>
          <div class="asCell">${r.platform ? `<span class="asTag">${escapeHtml(r.platform)}</span>` : `<span class="asMuted">—</span>`}</div>
          <div class="asCell"><span class="asBadge" style="color:${c};background:${c}1f">${AS_LABEL[st]}</span></div>
          ${asIsOwner ? `<div class="asCell">${escapeHtml(asName(r.assigned_to))}</div>` : ""}
          <div class="asCell${r.note ? "" : " asMuted"}">${escapeHtml(r.note || "—")}</div>
          <div class="asCell asMono${r.phone ? "" : " asMuted"}" style="text-align:right;padding-right:0">${escapeHtml(r.phone || "—")}</div>
        </div>`;
      }).join("")}
    </div></div></div>`;
}

function asDrawerRender() {
  const dr = document.getElementById("asDrawer");
  if (!dr) return;
  const r = asRows.find(x => x.id === asPicked);
  if (!r) { dr.classList.remove("open"); dr.innerHTML = ""; delete dr.dataset.id; return; }

  dr.dataset.id = r.id;
  const st = r.status || "not_verif";
  const platOpts = `<option value="">— платформа —</option>` +
    ML_PLATFORMS.map(p => `<option value="${p}"${p === (r.platform || "") ? " selected" : ""}>${p}</option>`).join("");
  const peopleOpts = `<option value="">— никому —</option>` +
    asPeople.map(p => `<option value="${escapeHtml(p)}"${p === (r.assigned_to || "") ? " selected" : ""}>${escapeHtml(asName(p))}</option>`).join("");

  dr.innerHTML = `
    <div class="asDrHead">
      <input class="asDrTitle asF" data-f="title" value="${escapeHtml(r.title || "")}" placeholder="Имя ноды" />
      <button class="asIco" id="asDrClose" title="Закрыть">✕</button>
    </div>
    <div style="display:flex;align-items:center;gap:8px;margin:2px 0 6px;padding-left:7px;">
      <span class="asDot" style="background:${AS_COLOR[st]}"></span>
      <span style="font-size:11.5px;color:var(--text2)">${AS_LABEL[st]}</span>
      <span class="asSaved" id="asSaved">сохранено</span>
    </div>

    <div class="asFld"><label>Почта</label>
      <input class="asInp asF" data-f="email" value="${escapeHtml(r.email || "")}" placeholder="mail@..." /></div>
    <div class="asFld"><label>Пароль</label>
      <input class="asInp asF" data-f="password" value="${escapeHtml(r.password || "")}" placeholder="••••" /></div>
    <div class="asFld"><label>Телеграм</label>
      <input class="asInp asF" data-f="telegram" value="${escapeHtml(r.telegram || "")}" placeholder="@username" /></div>
    <div class="asFld"><label>Телефон</label>
      <input class="asInp asF" data-f="phone" value="${escapeHtml(r.phone || "")}" placeholder="+7..." /></div>
    <div class="asFld"><label>Платформа</label>
      <select class="asSel asF" data-f="platform">${platOpts}</select></div>
    ${asIsOwner ? `<div class="asFld"><label>Чья</label>
      <select class="asSel asF" data-f="assigned_to">${peopleOpts}</select></div>` : ""}
    <div class="asFld"><label>Статус</label>
      <div class="asStatRow">${AS_STATUSES.map(([v, t]) =>
        `<button class="asStatBtn" data-status="${v}"${v === st ? ` style="color:${AS_COLOR[v]};border-color:${AS_COLOR[v]}66;background:${AS_COLOR[v]}14"` : ""}>${t}</button>`
      ).join("")}</div></div>
    <div class="asFld"><label>Заметка</label>
      <input class="asInp asF" data-f="note" value="${escapeHtml(r.note || "")}" placeholder="—" /></div>

    <button class="asChip" data-del="${r.id}" style="width:100%;margin-top:22px;color:#fb7185;border-color:rgba(251,113,133,.3);">Удалить ноду</button>`;
  dr.classList.add("open");
}

async function asPatch(id, field, value) {
  try {
    await ctJson(`/api/assets/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    const row = asRows.find(r => r.id === id);
    if (row) row[field] = value;
    if (field === "status" || field === "platform") asRender();
    const sv = document.getElementById("asSaved");
    if (sv) { sv.classList.add("on"); setTimeout(() => sv.classList.remove("on"), 1200); }
  } catch (e) {
    alert("Не сохранилось: " + e.message);
    assetLoad();
  }
}

function asOnChange(e) {
  const el = e.target.closest(".asF");
  if (!el) return;
  const id = el.closest("[data-id]")?.dataset.id;
  if (id) asPatch(id, el.dataset.f, el.value);
}

async function asOnClick(e) {
  if (e.target.closest("#asDrClose")) {
    asPicked = ""; asDrawerRender(); asRender(); return;
  }

  const stBtn = e.target.closest("[data-status]");
  if (stBtn) {
    if (asPicked) { await asPatch(asPicked, "status", stBtn.dataset.status); asDrawerRender(); }
    return;
  }

  const rowEl = e.target.closest("[data-row]");
  if (rowEl && !e.target.closest("button")) {
    asPicked = asPicked === rowEl.dataset.id ? "" : rowEl.dataset.id;
    asRender(); asDrawerRender(); return;
  }

  const ownerChip = e.target.closest("[data-owner]");
  if (ownerChip) { asOwner = ownerChip.dataset.owner; asRender(); return; }

  const chip = e.target.closest("[data-plat]");
  if (chip) { asPlat = chip.dataset.plat; asRender(); return; }

  if (e.target.closest("#asAddBtn")) {
    try {
      await ctJson("/api/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platform: asPlat || "", title: "Новая нода" }),
      });
      await assetLoad();
    } catch (err) { alert("Не добавилось: " + err.message); }
    return;
  }

  const eye = e.target.closest("[data-eye]");
  if (eye) {
    const id = eye.dataset.eye;
    asPwShown.has(id) ? asPwShown.delete(id) : asPwShown.add(id);
    asRender();
    return;
  }

  const cp = e.target.closest("[data-copy]");
  if (cp) {
    const val = cp.dataset.copy || "";
    if (!val) return;
    try {
      await navigator.clipboard.writeText(val);
      const old = cp.textContent; cp.textContent = "✓";
      setTimeout(() => { cp.textContent = old; }, 900);
    } catch { alert(val); }
    return;
  }

  const del = e.target.closest("[data-del]");
  if (del) {
    const row = asRows.find(r => r.id === del.dataset.del);
    if (!confirm(`Удалить «${row?.title || "ноду"}»?`)) return;
    try {
      await ctJson(`/api/assets/${encodeURIComponent(del.dataset.del)}`, { method: "DELETE" });
      asRows = asRows.filter(r => r.id !== del.dataset.del);
      if (asPicked === del.dataset.del) asPicked = "";
      asRender(); asDrawerRender();
    } catch (err) { alert("Не удалилось: " + err.message); }
  }
}
let pxData = [], pxCanEdit = false, pxEditing = null, pxInited = false;

async function proxyLoad() {
  const pane = document.getElementById("resPane_proxy");
  if (!pane) return;
  if (!pxInited) {
    pane.innerHTML = '<div class="pxGrid" id="pxGrid"><div class="asEmpty">Загрузка...</div></div>';
    pxInited = true;
    pane.addEventListener("click", pxOnClick);
  }
  try {
    const d = await ctJson("/api/proxy-pool");
    pxData = d.sections || [];
    pxCanEdit = !!d.can_edit;
    pxRender();
  } catch (e) {
    document.getElementById("pxGrid").innerHTML =
      `<div class="asEmpty" style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function pxLines(body) {
  return (body || "").split("\n").map(s => s.trim()).filter(Boolean);
}

function pxRender() {
  const grid = document.getElementById("pxGrid");
  grid.innerHTML = pxData.map(s => {
    const lines = pxLines(s.body);
    const editing = pxEditing === s.section;

    const head = `
      <div class="pxHead">
        <input class="pxTitle" data-sec="${s.section}" value="${escapeHtml(s.title)}"
               ${pxCanEdit ? "" : "readonly"} />
        <span class="pxCnt">${lines.length}</span>
        ${lines.length ? `<button class="pxBtn" data-copyall="${s.section}">Копировать всё</button>` : ""}
        ${pxCanEdit ? `<button class="pxBtn" data-edit="${s.section}">${editing ? "Отмена" : "Править"}</button>` : ""}
      </div>`;

    if (editing) {
      return `<div class="pxCol">
        ${head}
        <textarea class="pxEdit" id="pxEdit_${s.section}"
          placeholder="По одному прокси в строке">${escapeHtml(s.body)}</textarea>
        <div class="pxFoot">
          <button class="pxBtn" data-cancel="${s.section}">Отмена</button>
          <button class="pxBtn" data-save="${s.section}"
                  style="color:var(--cyan);border-color:rgba(34,211,238,.45);">Сохранить</button>
        </div>
      </div>`;
    }

    const body = lines.length
      ? lines.map((l, i) => `
          <div class="pxLine" data-line="${escapeHtml(l)}">
            <span>${escapeHtml(l)}</span><em>копировать</em>
          </div>`).join("")
      : `<div class="asEmpty" style="padding:30px 0;font-size:13px;">
           ${pxCanEdit ? "Пусто. Жми «Править» и вставь список." : "Пусто"}
         </div>`;

    return `<div class="pxCol">${head}<div class="pxList">${body}</div></div>`;
  }).join("");
}

async function pxSave(section, body, title) {
  const s = pxData.find(x => x.section === section);
  try {
    await ctJson(`/api/proxy-pool/${encodeURIComponent(section)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: title ?? (s ? s.title : ""), body }),
    });
    if (s) { s.body = body; if (title != null) s.title = title; }
  } catch (e) {
    alert("Не сохранилось: " + e.message);
  }
}

async function pxOnClick(e) {
  const ed = e.target.closest("[data-edit]");
  if (ed) {
    pxEditing = pxEditing === ed.dataset.edit ? null : ed.dataset.edit;
    pxRender();
    return;
  }

  const cancel = e.target.closest("[data-cancel]");
  if (cancel) { pxEditing = null; pxRender(); return; }

  const save = e.target.closest("[data-save]");
  if (save) {
    const sec = save.dataset.save;
    const ta = document.getElementById(`pxEdit_${sec}`);
    await pxSave(sec, ta ? ta.value : "");
    pxEditing = null;
    pxRender();
    return;
  }

  const all = e.target.closest("[data-copyall]");
  if (all) {
    const s = pxData.find(x => x.section === all.dataset.copyall);
    const text = pxLines(s?.body).join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const old = all.textContent; all.textContent = "Скопировано ✓";
      setTimeout(() => { all.textContent = old; }, 1200);
    } catch { alert("Не вышло скопировать"); }
    return;
  }

  const line = e.target.closest("[data-line]");
  if (line) {
    try {
      await navigator.clipboard.writeText(line.dataset.line);
      line.classList.add("done");
      setTimeout(() => line.classList.remove("done"), 900);
    } catch { alert(line.dataset.line); }
  }
}

// Переименование секции — только админ
document.addEventListener("change", e => {
  const t = e.target.closest(".pxTitle");
  if (!t || t.hasAttribute("readonly")) return;
  const s = pxData.find(x => x.section === t.dataset.sec);
  pxSave(t.dataset.sec, s ? s.body : "", t.value.trim());
});
let gkRows = [], gkPeople = [], gkNames = {}, gkIsOwner = false, gkMe = "", gkInited = false;
let gkPicked = new Set(), gkUsed = {}, gkOnlyFree = false;

function gkSelBar() {
  const el = document.getElementById("gkSel");
  if (!el) return;
  const n = gkPicked.size;
  el.classList.toggle("hidden", !n);
  el.innerHTML = n
    ? `<b>${n}</b> выделено
       <button class="pxBtn" id="gkCopySel">Копировать</button>
       <button class="pxBtn" id="gkClearSel">Снять</button>`
    : "";
}

function gkName(email) {
  if (!email) return "— ничьи —";
  return gkNames[email] || email.split("@")[0];
}

async function keysLoad() {
  const pane = document.getElementById("resPane_keys");
  if (!pane) return;
  if (!gkInited) {
    pane.innerHTML = `
      <div class="gkBar" id="gkBar"></div>
      <div id="gkBody"><div class="asEmpty">Загрузка...</div></div>`;
    gkInited = true;
    pane.addEventListener("click", gkOnClick);
    pane.addEventListener("change", gkOnChange);
  }
  try {
    const d = await ctJson("/api/groq-pool");
    gkRows = d.keys || [];
    gkPeople = d.people || [];
    gkNames = d.names || {};
    gkIsOwner = !!d.is_owner;
    gkMe = d.me || "";
    gkUsed = d.used || {};
    gkRender();
  } catch (e) {
    document.getElementById("gkBody").innerHTML =
      `<div class="asEmpty" style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function gkRender() {
  const bar = document.getElementById("gkBar");
  const body = document.getElementById("gkBody");
  const cnt = document.getElementById("keysCount");
  if (cnt) cnt.textContent = gkRows.length ? gkRows.length : "";

  const usedN = gkRows.filter(r => gkUsed[r.api_key]).length;
  bar.innerHTML = `
    <button class="asChip" id="gkAddBtn"
      style="background:rgba(34,211,238,.1);color:var(--cyan);border-color:rgba(34,211,238,.3);">
      + Добавить ключи</button>
    <label class="gkFree"><input type="checkbox" id="gkOnlyFree"${gkOnlyFree ? " checked" : ""}>только свободные</label>
    <span style="color:var(--text2);font-size:12px;">в слотах: <b style="color:var(--text)">${usedN}</b> из ${gkRows.length}</span>
    <span style="color:var(--text2);font-size:12px;">Клик по ключу — копировать</span>
    <span id="gkSel" class="gkSelBar"></span>`;

  if (!gkRows.length) {
    body.innerHTML = `<div class="asEmpty">Ключей пока нет. Жми «+ Добавить ключи».</div>`;
    return;
  }

  // Группируем по сотруднику
  const groups = {};
  gkRows.filter(r => !gkOnlyFree || !gkUsed[r.api_key]).forEach(r => {
    const k = r.assigned_to || "";
    (groups[k] = groups[k] || []).push(r);
  });
  if (!Object.keys(groups).length) {
    body.innerHTML = `<div class="asEmpty">Свободных ключей нет — все уже стоят в слотах.</div>`;
    gkSelBar();
    return;
  }
  const order = Object.keys(groups).sort((a, b) => {
    if (a === gkMe) return -1;
    if (b === gkMe) return 1;
    return gkName(a).localeCompare(gkName(b), "ru");
  });

  const peopleOpts = sel => `<option value="">— ничьи —</option>` +
    gkPeople.map(p => `<option value="${escapeHtml(p)}"${p === sel ? " selected" : ""}>${escapeHtml(gkName(p))}</option>`).join("");

  body.innerHTML = order.map(who => {
    const list = groups[who];
    const free = list.filter(r => !gkUsed[r.api_key]).length;
    return `
      <div class="gkGroup">
        <div class="gkGroupHead">
          <span class="gkWho">${escapeHtml(gkName(who))}${who === gkMe ? " · это ты" : ""}</span>
          <span class="pxCnt">${list.length}</span>
          <span class="gkFreeCnt">свободно ${free}</span>
          <button class="pxBtn" data-gkpickall="${escapeHtml(who)}" style="margin-left:auto;">Выделить все</button>
          <button class="pxBtn" data-gkcopyall="${escapeHtml(who)}">Копировать все</button>
        </div>
        <div class="gkKeys">
          ${list.map(r => {
            const inSlot = gkUsed[r.api_key];
            return `
            <div class="gkRow${inSlot ? " used" : ""}${gkPicked.has(r.id) ? " sel" : ""}" data-id="${r.id}">
              <input type="checkbox" class="gkChk" data-gkpick="${r.id}"${gkPicked.has(r.id) ? " checked" : ""} />
              <span class="gkKey" data-gkcopy="${escapeHtml(r.api_key)}"
                    title="${escapeHtml(r.api_key)}">${escapeHtml(r.api_key)}</span>
              ${inSlot ? `<span class="gkUsedTag" title="Стоит в слотах: ${escapeHtml(inSlot.join(", "))}">в слоте</span>` : ""}
              <input class="gkNote gkF" data-f="note" value="${escapeHtml(r.note || "")}" placeholder="заметка" />
              ${gkIsOwner ? `<select class="asSel gkF" data-f="assigned_to" style="flex:0 0 auto;width:150px;">${peopleOpts(r.assigned_to || "")}</select>` : ""}
              ${(r.owner_email === gkMe || gkIsOwner)
                ? `<button class="asIco del" data-gkdel="${r.id}" title="Удалить">✕</button>` : ""}
            </div>`;
          }).join("")}
        </div>
      </div>`;
  }).join("");
  gkSelBar();
}

async function gkOnClick(e) {
  const pick = e.target.closest("[data-gkpick]");
  if (pick) {
    const id = pick.dataset.gkpick;
    pick.checked ? gkPicked.add(id) : gkPicked.delete(id);
    pick.closest(".gkRow")?.classList.toggle("sel", pick.checked);
    gkSelBar();
    return;
  }

  if (e.target.closest("#gkClearSel")) {
    gkPicked.clear();
    gkRender();
    return;
  }

  const pickAll = e.target.closest("[data-gkpickall]");
  if (pickAll) {
    const who = pickAll.dataset.gkpickall;
    const list = gkRows.filter(r => (r.assigned_to || "") === who
                                 && (!gkOnlyFree || !gkUsed[r.api_key]));
    const allOn = list.every(r => gkPicked.has(r.id));
    list.forEach(r => allOn ? gkPicked.delete(r.id) : gkPicked.add(r.id));
    gkRender();
    return;
  }

  if (e.target.closest("#gkCopySel")) {
    const keys = gkRows.filter(r => gkPicked.has(r.id)).map(r => r.api_key);
    if (!keys.length) return;
    const btn = e.target.closest("#gkCopySel");
    try {
      await navigator.clipboard.writeText(keys.join("\n"));
      btn.textContent = `✓ ${keys.length} скопировано`;
      setTimeout(() => gkSelBar(), 1200);
    } catch {
      prompt("Скопируй вручную:", keys.join("\n"));
    }
    return;
  }

  if (e.target.closest("#gkAddBtn")) {
    const who = document.getElementById("gkWho");
    if (who) {
      who.innerHTML = `<option value="">— себе —</option>` +
        gkPeople.filter(p => p !== gkMe)
          .map(p => `<option value="${escapeHtml(p)}">${escapeHtml(gkName(p))}</option>`).join("");
    }
    const wrap = document.getElementById("gkWhoWrap");
    if (wrap) wrap.style.display = gkIsOwner ? "" : "none";
    document.getElementById("gkBulk").value = "";
    document.getElementById("gkNoteNew").value = "";
    document.getElementById("gkAddModal").classList.add("open");
    setTimeout(() => document.getElementById("gkBulk")?.focus(), 50);
    return;
  }

  const one = e.target.closest("[data-gkcopy]");
  if (one) {
    try {
      await navigator.clipboard.writeText(one.dataset.gkcopy);
      const old = one.textContent;
      one.textContent = "скопировано ✓";
      one.style.color = "var(--green)";
      setTimeout(() => { one.textContent = old; one.style.color = ""; }, 900);
    } catch { alert(one.dataset.gkcopy); }
    return;
  }

  const allBtn = e.target.closest("[data-gkcopyall]");
  if (allBtn) {
    const who = allBtn.dataset.gkcopyall;
    const text = gkRows.filter(r => (r.assigned_to || "") === who)
                       .map(r => r.api_key).join("\n");
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      const old = allBtn.textContent; allBtn.textContent = "Скопировано ✓";
      setTimeout(() => { allBtn.textContent = old; }, 1200);
    } catch { alert("Не вышло скопировать"); }
    return;
  }

  const del = e.target.closest("[data-gkdel]");
  if (del) {
    if (!confirm("Удалить ключ?")) return;
    try {
      await ctJson(`/api/groq-pool/${encodeURIComponent(del.dataset.gkdel)}`, { method: "DELETE" });
      gkRows = gkRows.filter(r => r.id !== del.dataset.gkdel);
      gkRender();
    } catch (err) { alert("Не удалилось: " + err.message); }
  }
}

async function gkOnChange(e) {
  if (e.target.id === "gkOnlyFree") {
    gkOnlyFree = e.target.checked;
    gkRender();
    return;
  }
  const el = e.target.closest(".gkF");
  if (!el) return;
  const id = el.closest(".gkRow")?.dataset.id;
  if (!id) return;
  try {
    await ctJson(`/api/groq-pool/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [el.dataset.f]: el.value }),
    });
    const row = gkRows.find(r => r.id === id);
    if (row) row[el.dataset.f] = el.value;
    if (el.dataset.f === "assigned_to") gkRender();
  } catch (err) {
    alert("Не сохранилось: " + err.message);
    keysLoad();
  }
}
const WB_MONTHS = ["январь","февраль","март","апрель","май","июнь",
                   "июль","август","сентябрь","октябрь","ноябрь","декабрь"];
let wbRows = [], wbMonth = "", wbList = [], wbNames = {}, wbMe = "", wbIsOwner = false, wbInited = false;

function wbMonthName(m) {
  const [y, mm] = m.split("-").map(Number);
  const now = new Date();
  const cur = y === now.getFullYear();
  return WB_MONTHS[mm - 1] + (cur ? "" : ` ${y}`);
}
function wbName(email) { return wbNames[email] || (email || "").split("@")[0]; }

async function baseLoad() {
  const pane = document.getElementById("resPane_base");
  if (!pane) return;
  if (!wbInited) {
    pane.innerHTML = `
      <div class="wbTop" id="wbTop"></div>
      <div class="wbStats" id="wbStats"></div>
      <div id="wbPeople"></div>
      <div id="wbBody"><div class="asEmpty">Загрузка...</div></div>`;
    wbInited = true;
    pane.addEventListener("click", wbOnClick);
  }
  try {
    const d = await ctJson(`/api/work-base?month=${encodeURIComponent(wbMonth)}`);
    wbRows = d.rows || [];
    wbMonth = d.month || wbMonth;
    wbList = d.months || [wbMonth];
    wbNames = d.names || {};
    wbMe = d.me || "";
    wbIsOwner = !!d.is_owner;
    wbRender();
  } catch (e) {
    document.getElementById("wbBody").innerHTML =
      `<div class="asEmpty" style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function wbStatusInfo(s) {
  if (s === "in_work") return { label: "жив", color: "#10f5a8" };
  if (s === "blocked" || s === "dead") return { label: "бан", color: "#fb7185" };
  return null;
}

function wbStatusInfo(s) {
  if (s === "in_work") return { label: "жив", color: "#10f5a8" };
  if (s === "blocked" || s === "dead") return { label: "бан", color: "#fb7185" };
  return null;
}

function wbRender() {
  const top = document.getElementById("wbTop");
  const stats = document.getElementById("wbStats");
  const body = document.getElementById("wbBody");
  const tag = document.getElementById("baseMonth");
  if (tag) tag.textContent = wbMonthName(wbMonth);

  top.innerHTML = `
    <div class="wbMonths">
      ${wbList.slice().reverse().map(m =>
        `<button class="wbM${m === wbMonth ? " on" : ""}" data-m="${m}">${wbMonthName(m)}</button>`).join("")}
    </div>
    <button class="asChip" id="wbAddBtn"
      style="margin-left:auto;background:rgba(34,211,238,.1);color:var(--cyan);border-color:rgba(34,211,238,.3);">
      + Внести работу</button>`;

  const byPlat = {};
  wbRows.forEach(r => { const p = r.platform || "—"; byPlat[p] = (byPlat[p] || 0) + 1; });
  const days = new Set(wbRows.map(r => String(r.work_date).slice(0, 10)));

  let _tAlive = 0, _tBan = 0;
  wbRows.forEach(r => { const si = wbStatusInfo(r.status); if (si && si.label === "жив") _tAlive++; else if (si && si.label === "бан") _tBan++; });
  stats.innerHTML =
    `<span class="mlStat"><b>${wbRows.length}</b> всего за месяц</span>` +
    `<span class="mlStat"><b>${days.size}</b> смен</span>` +
    `<span class="mlStat"><span class="mlDot" style="background:#10f5a8"></span><b>${_tAlive}</b> жив</span>` +
    `<span class="mlStat"><span class="mlDot" style="background:#fb7185"></span><b>${_tBan}</b> бан</span>` +
    Object.entries(byPlat).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([p, n]) => `<span class="mlStat"><b>${n}</b> ${escapeHtml(p)}</span>`).join("");

  // Свод по сотрудникам — только для админа
  const sumBox = document.getElementById("wbPeople");
  if (sumBox) {
    if (!wbIsOwner || !wbRows.length) {
      sumBox.innerHTML = "";
    } else {
      const per = {};
      wbRows.forEach(r => {
        const k = r.author_email || "";
        const s = per[k] = per[k] || { n: 0, days: new Set(), plats: {}, alive: 0, ban: 0 };
        s.n++;
        s.days.add(String(r.work_date).slice(0, 10));
        const p = r.platform || "—";
        s.plats[p] = (s.plats[p] || 0) + 1;
        const si = wbStatusInfo(r.status);
        if (si && si.label === "жив") s.alive++;
        else if (si && si.label === "бан") s.ban++;
      });
      const list = Object.entries(per).sort((a, b) => b[1].n - a[1].n);
      sumBox.innerHTML = `
        <div class="wbDay">
          <div class="wbDayHead">
            <span class="wbDate">Итого по сотрудникам</span>
            <button class="pxBtn" id="wbExportBtn" style="margin-left:auto;">⬇ Скачать отчёт</button>
          </div>
          ${list.map(([who, s]) => `
            <div class="wbRow">
              <span class="wbMail" style="font-family:inherit;font-weight:600;">${escapeHtml(wbName(who))}</span>
              <span class="wbPlat" style="width:auto;flex:1;color:var(--text2);font-size:11.5px;">
                ${Object.entries(s.plats).sort((a, b) => b[1] - a[1])
                   .map(([p, n]) => `${escapeHtml(p)} ${n}`).join(" · ")}
              </span>
              <span style="color:#10f5a8;font-size:12px;font-weight:600;white-space:nowrap;">${s.alive} жив</span>
              <span style="color:#fb7185;font-size:12px;font-weight:600;white-space:nowrap;">${s.ban} бан</span>
              <span style="color:var(--text2);font-size:12px;white-space:nowrap;">${s.days.size} смен</span>
              <span class="wbTot" style="margin-left:0;min-width:60px;text-align:right;">${s.n} шт</span>
            </div>`).join("")}
        </div>`;
    }
  }

  if (!wbRows.length) {
    body.innerHTML = `<div class="asEmpty">За этот месяц записей нет. Жми «+ Внести работу».</div>`;
    return;
  }

  // Группируем по дню, внутри — по сотруднику
  const groups = {};
  wbRows.forEach(r => {
    const d = String(r.work_date).slice(0, 10);
    const k = `${d}|${r.author_email}`;
    (groups[k] = groups[k] || []).push(r);
  });

  body.innerHTML = Object.keys(groups).sort().reverse().map(k => {
    const [day, who] = k.split("|");
    const list = groups[k];
    const dt = new Date(day + "T12:00:00");
    const title = `${String(dt.getDate()).padStart(2, "0")}.${String(dt.getMonth() + 1).padStart(2, "0")}`;
    return `
      <div class="wbDay">
        <div class="wbDayHead">
          <span class="wbDate">${title}</span>
          ${wbIsOwner || who !== wbMe ? `<span class="wbWho">${escapeHtml(wbName(who))}</span>` : ""}
          <span class="wbTot">${list.length} шт</span>
        </div>
        ${list.map((r, i) => `
          <div class="wbRow">
            <span class="wbNum">${i + 1}</span>
            <span class="wbMail">${escapeHtml(r.email || "")}</span>
            <span class="wbMail" style="flex:0 0 auto;width:140px;color:var(--text2);">${escapeHtml(r.password || "—")}</span>
            <button class="asIco" data-copy="${escapeHtml((r.email || "") + ":" + (r.password || ""))}" title="Копировать почту:пароль">⧉</button>
            ${r.phone ? `<span class="wbPlat" style="width:120px;color:var(--text2);">${escapeHtml(r.phone)}</span>` : ""}
            <span class="wbPlat">${escapeHtml(r.platform || "—")}</span>
            ${(() => { const si = wbStatusInfo(r.status); return si
              ? `<span style="min-width:48px;font-size:11.5px;font-weight:600;color:${si.color};">${si.label}</span>` : ""; })()}
            ${(r.author_email === wbMe || wbIsOwner)
              ? `<button class="asIco del" data-wbdel="${r.id}" title="Удалить">✕</button>` : ""}
          </div>`).join("")}
      </div>`;
  }).join("");
}

async function wbOnClick(e) {
  if (e.target.closest("#wbExportBtn")) { wbExport(); return; }

  const cp = e.target.closest("[data-copy]");
  if (cp) {
    const val = cp.dataset.copy || "";
    if (!val || val === ":") return;
    try {
      await navigator.clipboard.writeText(val);
      const old = cp.textContent; cp.textContent = "✓";
      setTimeout(() => { cp.textContent = old; }, 900);
    } catch { alert(val); }
    return;
  }

  const m = e.target.closest("[data-m]");
  if (m) { wbMonth = m.dataset.m; baseLoad(); return; }

  if (e.target.closest("#wbAddBtn")) {
    document.getElementById("wbDate").value = new Date().toLocaleDateString("sv-SE");
    const ps = document.getElementById("wbPlat");
    if (ps) ps.innerHTML = `<option value="">— без платформы —</option>` +
      ML_PLATFORMS.map(p => `<option value="${p}">${p}</option>`).join("");
    document.getElementById("wbEmails").value = "";
    document.getElementById("wbPwds").value = "";
    document.getElementById("wbMatch").textContent = "";
    document.getElementById("wbNoteNew").value = "";
    document.getElementById("wbAddModal").classList.add("open");
    setTimeout(() => document.getElementById("wbEmails")?.focus(), 50);
    return;
  }

  const del = e.target.closest("[data-wbdel]");
  if (del) {
    if (!confirm("Удалить запись?")) return;
    try {
      await ctJson(`/api/work-base/${encodeURIComponent(del.dataset.wbdel)}`, { method: "DELETE" });
      wbRows = wbRows.filter(r => r.id !== del.dataset.wbdel);
      wbRender();
    } catch (err) { alert("Не удалилось: " + err.message); }
  }
}

// ── Модалка добавления Groq-ключей ────────────────────────
document.getElementById("gkAddCancel")?.addEventListener("click", () => {
  document.getElementById("gkAddModal").classList.remove("open");
});

document.getElementById("gkAddSave")?.addEventListener("click", async () => {
  const btn = document.getElementById("gkAddSave");
  const bulk = document.getElementById("gkBulk").value;
  if (!bulk.trim()) { alert("Вставь хотя бы один ключ"); return; }
  btn.disabled = true; btn.textContent = "Добавляю...";
  try {
    const d = await ctJson("/api/groq-pool", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bulk,
        assigned_to: document.getElementById("gkWho")?.value || "",
        note: document.getElementById("gkNoteNew")?.value || "",
      }),
    });
    document.getElementById("gkAddModal").classList.remove("open");
    await keysLoad();
    if (!d.added) alert("Ничего не добавилось — проверь формат ключей.");
    else if (d.skipped) alert(`Добавлено: ${d.added}. Пропущено: ${d.skipped}`);
  } catch (err) {
    alert("Не добавилось: " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Добавить";
  }
});

// ── Модалка внесения работы ───────────────────────────────
document.getElementById("wbAddCancel")?.addEventListener("click", () => {
  document.getElementById("wbAddModal").classList.remove("open");
});

document.getElementById("wbAddSave")?.addEventListener("click", async () => {
  const btn = document.getElementById("wbAddSave");
  const day = document.getElementById("wbDate").value;
  const emails = document.getElementById("wbEmails").value;
  const passwords = document.getElementById("wbPwds").value;
  if (!day) { alert("Укажи дату смены"); return; }
  if (!emails.trim()) { alert("Вставь хотя бы одну почту"); return; }

  const nM = emails.split("\n").filter(s => s.trim()).length;
  const nP = passwords.split("\n").filter(s => s.trim()).length;
  if (nP && nM !== nP &&
      !confirm(`Почт ${nM}, паролей ${nP} — не сходится. Всё равно внести?`)) return;
  btn.disabled = true; btn.textContent = "Вношу...";
  try {
    const d = await ctJson("/api/work-base", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        emails, passwords, work_date: day,
        platform: document.getElementById("wbPlat")?.value || "",
        note: document.getElementById("wbNoteNew")?.value || "",
      }),
    });
    document.getElementById("wbAddModal").classList.remove("open");
    wbMonth = day.slice(0, 7);
    await baseLoad();
    if (!d.added) alert("Ничего не добавилось — проверь формат строк.");
  } catch (err) {
    alert("Не добавилось: " + err.message);
  } finally {
    btn.disabled = false; btn.textContent = "Внести";
  }
});

// Подсказка: сходятся ли почты с паролями
["wbEmails", "wbPwds"].forEach(id => {
  document.getElementById(id)?.addEventListener("input", () => {
    const nM = (document.getElementById("wbEmails").value || "").split("\n").filter(s => s.trim()).length;
    const nP = (document.getElementById("wbPwds").value || "").split("\n").filter(s => s.trim()).length;
    const el = document.getElementById("wbMatch");
    if (!el) return;
    if (!nM && !nP) { el.textContent = ""; return; }
    const ok = !nP || nM === nP;
    el.textContent = `Почт: ${nM} · Паролей: ${nP}` + (ok ? "" : " — не сходится");
    el.style.color = ok ? "var(--text2)" : "#fb7185";
  });
});

// ── Выгрузка отчёта «База» за месяц ───────────────────────
function wbExport() {
  if (!wbRows.length) { alert("За этот месяц записей нет."); return; }
  const esc = s => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const per = {};
  wbRows.forEach(r => {
    const k = r.author_email || "";
    const s = per[k] = per[k] || { n: 0, days: new Set(), plats: {}, rows: [] };
    s.n++;
    s.days.add(String(r.work_date).slice(0, 10));
    const p = r.platform || "—";
    s.plats[p] = (s.plats[p] || 0) + 1;
    s.rows.push(r);
  });
  const list = Object.entries(per).sort((a, b) => b[1].n - a[1].n);
  const total = wbRows.length;

  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>База — ${esc(wbMonthName(wbMonth))}</title>
<style>
 *{box-sizing:border-box;}
 body{margin:0;padding:32px;background:#f6f7f9;color:#14161a;
      font:14px/1.5 -apple-system,"Segoe UI",Roboto,sans-serif;}
 .sheet{max-width:900px;margin:0 auto;background:#fff;border-radius:14px;
        box-shadow:0 2px 24px rgba(0,0,0,.08);padding:36px 40px;}
 h1{margin:0 0 4px;font-size:24px;}
 .period{color:#6b7280;margin-bottom:26px;}
 h2{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:#6b7280;
    margin:28px 0 12px;padding-bottom:7px;border-bottom:1px solid #e5e7eb;}
 table{width:100%;border-collapse:collapse;}
 th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.05em;
    color:#9ca3af;font-weight:600;padding:7px 10px;border-bottom:1px solid #e5e7eb;}
 td{padding:8px 10px;border-bottom:1px solid #f1f2f4;}
 .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;}
 .mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:12.5px;}
 .dim{color:#9ca3af;}
 .big{font-size:17px;font-weight:700;}
 .foot{margin-top:26px;padding-top:14px;border-top:1px solid #e5e7eb;color:#9ca3af;font-size:12px;}
 @media print{body{background:#fff;padding:0;} .sheet{box-shadow:none;max-width:none;}}
</style></head><body><div class="sheet">
 <h1>База — проделанная работа</h1>
 <div class="period">${esc(wbMonthName(wbMonth))} · всего ${total} шт</div>

 <h2>Итого по сотрудникам</h2>
 <table>
  <thead><tr><th>Сотрудник</th><th>Платформы</th><th class="num">Смен</th><th class="num">Сделано</th></tr></thead>
  <tbody>${list.map(([who, s]) => `
    <tr>
      <td><b>${esc(wbName(who))}</b></td>
      <td class="dim">${Object.entries(s.plats).sort((a,b)=>b[1]-a[1])
          .map(([p,n]) => `${esc(p)} — ${n}`).join(", ")}</td>
      <td class="num">${s.days.size}</td>
      <td class="num big">${s.n}</td>
    </tr>`).join("")}</tbody>
 </table>

 ${list.map(([who, s]) => `
  <h2>${esc(wbName(who))} — ${s.n} шт</h2>
  <table>
   <thead><tr><th>Дата</th><th>Почта</th><th>Пароль</th><th>Платформа</th></tr></thead>
   <tbody>${s.rows.slice().sort((a,b)=>String(a.work_date).localeCompare(String(b.work_date)))
     .map(r => `<tr>
        <td class="dim">${esc(String(r.work_date).slice(0,10))}</td>
        <td class="mono">${esc(r.email || "")}</td>
        <td class="mono dim">${esc(r.password || "—")}</td>
        <td>${esc(r.platform || "—")}</td>
      </tr>`).join("")}</tbody>
  </table>`).join("")}

 <div class="foot">Сформировано ${new Date().toLocaleString("ru-RU")} · CLAW-AI Manager</div>
</div></body></html>`;

  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  a.download = `База_${wbMonth}.html`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

// ── Кабинет: пользователи системы ─────────────────────────
let cbRows = [], cbMe = "", cbInited = false;

// ── Технические работы ─────────────────────────────────────
let mtState = { maintenance: false, message: "", is_admin: false };

function mtApply() {
  document.getElementById("mtOverlay")?.remove();
  document.getElementById("mtBanner")?.remove();
  if (!mtState.maintenance) return;

  if (mtState.is_admin) {
    const b = document.createElement("div");
    b.id = "mtBanner";
    b.className = "mtBanner";
    b.textContent = "⚠ Сайт в режиме техработ — участники видят заглушку";
    document.body.appendChild(b);
    return;
  }

  const o = document.createElement("div");
  o.id = "mtOverlay";
  o.className = "mtOverlay";
  o.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
      <circle cx="12" cy="12" r="3.2"/>
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1"/>
    </svg>
    <h1>Идут технические работы</h1>
    <p>${escapeHtml(mtState.message || "Скоро всё заработает. Пожалуйста, подожди немного.")}</p>
    <small>Страница обновится сама, как только работы закончатся</small>`;
  document.body.appendChild(o);
}

async function mtCheck() {
  try {
    const d = await ctJson("/api/maintenance");
    const was = mtState.maintenance;
    mtState = d;
    mtApply();
    const t = document.getElementById("mtToggle");
    const m = document.getElementById("mtMessage");
    const s = document.getElementById("mtState");
    if (t) t.checked = !!d.maintenance;
    if (m && document.activeElement !== m) m.value = d.message || "";
    if (s) s.textContent = d.maintenance ? "Сейчас включено" : "Сейчас выключено";
    if (was && !d.maintenance && !d.is_admin) location.reload();
  } catch {}
}

async function mtSave() {
  const t = document.getElementById("mtToggle");
  const m = document.getElementById("mtMessage");
  try {
    await ctJson("/api/maintenance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maintenance: !!t?.checked, message: m?.value || "" }),
    });
    await mtCheck();
  } catch (e) {
    alert("Не сохранилось: " + e.message);
    await mtCheck();
  }
}

document.addEventListener("change", e => {
  if (e.target.id === "mtToggle") mtSave();
});
document.addEventListener("blur", e => {
  if (e.target.id === "mtMessage") mtSave();
}, true);

mtCheck();
setInterval(mtCheck, 30000);

// ── Режим редактора: платформы «в разработке» ──────────────
let devState = { dev_platforms: [], is_admin: false };
let editorMode = false;
try { editorMode = localStorage.getItem("editorMode") === "1"; } catch {}

function devApplyTabs() {
  document.querySelectorAll('.platformBtn[data-platform]').forEach(btn => {
    const p = btn.dataset.platform;
    const inDev = devState.dev_platforms.includes(p);
    btn.classList.toggle("platformDev", inDev);
    let badge = btn.querySelector(".devBadge");
    if (inDev && !badge) {
      badge = document.createElement("span");
      badge.className = "devBadge";
      badge.textContent = "в разработке";
      btn.appendChild(badge);
    } else if (!inDev && badge) {
      badge.remove();
    }
    btn.classList.toggle("editorPick", editorMode && devState.is_admin);
  });
}

async function devCheck() {
  try {
    const d = await ctJson("/api/dev-platforms");
    devState = d;
    if (!d.is_admin) editorMode = false;
    devApplyTabs();
    const t = document.getElementById("edToggle");
    const s = document.getElementById("edState");
    if (t) t.checked = editorMode;
    if (s) s.textContent = editorMode ? "Режим редактора включён" : "Режим редактора выключен";
  } catch {}
}

async function devSave() {
  try {
    await ctJson("/api/dev-platforms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dev_platforms: devState.dev_platforms }),
    });
  } catch (e) {
    alert("Не сохранилось: " + e.message);
  }
}

document.addEventListener("change", e => {
  if (e.target.id === "edToggle") {
    editorMode = !!e.target.checked;
    try { localStorage.setItem("editorMode", editorMode ? "1" : "0"); } catch {}
    const s = document.getElementById("edState");
    if (s) s.textContent = editorMode ? "Режим редактора включён" : "Режим редактора выключен";
    devApplyTabs();
  }
});

document.addEventListener("click", e => {
  if (!editorMode || !devState.is_admin) return;
  const btn = e.target.closest('.platformBtn[data-platform]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const p = btn.dataset.platform;
  const i = devState.dev_platforms.indexOf(p);
  if (i >= 0) devState.dev_platforms.splice(i, 1);
  else devState.dev_platforms.push(p);
  devApplyTabs();
  devSave();
}, true);

devCheck();
setInterval(devCheck, 30000);

async function cbLoad() {
  const box = document.getElementById("cbTable");
  if (!box) return;
  if (!cbInited) {
    cbInited = true;
    box.addEventListener("click", cbOnClick);
    document.getElementById("cbRefreshBtn")?.addEventListener("click", cbLoad);
    document.getElementById("cbSearch")?.addEventListener("input", cbRender);
  }
  try {
    const d = await ctJson("/api/admin/cabinet");
    cbRows = d.users || [];
    cbMe = d.me || "";
    cbRender();
    mtCheck();
  } catch (e) {
    box.innerHTML = `<div style="color:#fb7185;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function cbRender() {
  const box = document.getElementById("cbTable");
  const cnt = document.getElementById("cbCount");
  const q = (document.getElementById("cbSearch")?.value || "").trim().toLowerCase();
  if (cnt) cnt.textContent = cbRows.length ? `(${cbRows.length})` : "";

  const rows = q
    ? cbRows.filter(u => `${u.email} ${u.username || ""}`.toLowerCase().includes(q))
    : cbRows;

  if (!rows.length) { box.innerHTML = '<div style="color:var(--text2);">Никого не найдено.</div>'; return; }

  box.innerHTML = `
    <table class="cbTable">
      <thead><tr>
        <th>Имя</th><th>Почта</th><th style="width:90px;">Анкет</th>
        <th style="width:120px;">Статус</th><th style="width:130px;">Регистрация</th>
        <th style="width:210px;"></th>
      </tr></thead>
      <tbody>${rows.map(u => {
        const mine = (u.email || "").toLowerCase() === (cbMe || "").toLowerCase();
        return `
        <tr data-id="${u.id}" data-email="${escapeHtml(u.email || "")}">
          <td><b>${escapeHtml(u.username || (u.email || "").split("@")[0])}</b></td>
          <td class="cbMail">${escapeHtml(u.email || "")}</td>
          <td>${u.accounts || 0}</td>
          <td>
            ${u.is_admin ? '<span class="cbTag adm">админ</span>' : ""}
            ${u.has_session ? '<span class="cbTag on">в сети</span>' : ""}
          </td>
          <td style="color:var(--text2);font-size:12px;">${(u.created_at || "").slice(0, 10)}</td>
          <td style="text-align:right;">
            ${u.is_admin || mine ? '<span style="color:var(--text2);font-size:11px;">нельзя удалить</span>' : `
              <button class="cbDel" data-del="${u.id}">Удалить</button>
              <button class="cbDel" data-purge="${u.id}">Удалить с анкетами</button>`}
          </td>
        </tr>`;
      }).join("")}</tbody>
    </table>`;
}

async function cbOnClick(e) {
  const btn = e.target.closest("[data-del], [data-purge]");
  if (!btn) return;
  const purge = btn.hasAttribute("data-purge");
  const id = btn.dataset.del || btn.dataset.purge;
  const tr = btn.closest("tr");
  const email = tr?.dataset.email || "";
  const accs = cbRows.find(u => u.id === id)?.accounts || 0;

  const warn = purge
    ? `Удалить ${email} ВМЕСТЕ с анкетами (${accs} шт)?\n\nБудут стёрты его анкеты, их настройки, логи и очередь. Это необратимо.`
    : `Удалить пользователя ${email}?\n\nДоступ пропадёт, личные данные сотрутся.` +
      (accs ? `\nЕго ${accs} анкет останутся в системе.` : "");
  if (!confirm(warn)) return;
  if (purge && !confirm("Точно? Анкеты восстановить будет нельзя.")) return;

  btn.disabled = true; btn.textContent = "Удаляю...";
  try {
    await ctJson(`/api/admin/users/${encodeURIComponent(id)}?purge=${purge ? 1 : 0}`,
                 { method: "DELETE" });
    cbRows = cbRows.filter(u => u.id !== id);
    cbRender();
  } catch (err) {
    alert("Не удалилось: " + err.message);
    btn.disabled = false; btn.textContent = purge ? "Удалить с анкетами" : "Удалить";
  }
}

// ── Мои TG на сегодня — в боковой панели ──────────────────
async function tgTodayLoad() {
  const box = document.getElementById("tgToday");
  if (!box) return;
  try {
    const d = await ctJson("/api/my/assignments");
    const today = new Date().toLocaleDateString("sv-SE");
    const mine = (d.assignments || []).filter(a =>
      String(a.work_date || "").slice(0, 10) === today);

    const tgs = [...new Set(mine.flatMap(a =>
      (a.contacts || []).map(c => String(c).replace(/^@/, ""))))];

    if (!tgs.length) {
      box.style.display = "";
      box.innerHTML = `
        <div class="ttHead"><span class="ttTitle">TG на сегодня</span></div>
        <div class="ttEmpty">Назначений на сегодня нет</div>`;
      return;
    }

    let pmap = {};
    try {
      pmap = (await ctJson("/api/my/tg-platforms")).map || {};
    } catch {}

    const PSHORT = {
      Mamba: "МБ", Badanga: "БД", Soderzhanka: "СД",
      Lovelaz: "ЛВ", LovePlanet: "ЛП",
      Twinby: "ТВ", Vznakomstve: "ВЗ",
    };

    box.style.display = "";
    box.innerHTML = `
      <div class="ttHead">
        <span class="ttTitle">TG на сегодня</span>
        <span class="ttCnt">${tgs.length}</span>
      </div>
      <div class="ttList">
        ${tgs.map(t => {
          const plats = pmap[t.toLowerCase()] || {};
          const chips = Object.entries(plats)
            .sort((a, b) => (b[1].alive + b[1].blocked) - (a[1].alive + a[1].blocked))
            .map(([p, s]) => {
              const live = s.alive || 0, ban = s.blocked || 0;
              const name = PSHORT[p] || p.slice(0, 2).toUpperCase();
              const cls = (!live && ban) ? "ttP ban" : "ttP";
              const num = live || ban;
              return `<span class="${cls}" title="${escapeHtml(p)}: ${live} живых, ${ban} забанено">`
                   + `${escapeHtml(name)}&nbsp;${num}</span>`;
            }).join("");
          return `
            <div class="ttRow" data-tt="${escapeHtml(t)}" title="@${escapeHtml(t)}">
              <span class="ttNick">@${escapeHtml(t)}</span>
              ${chips ? `<span class="ttPlats">${chips}</span>`
                      : `<span class="ttNone">—</span>`}
            </div>`;
        }).join("")}
      </div>`;
  } catch {
    box.style.display = "none";
  }
}

document.getElementById("tgToday")?.addEventListener("click", async e => {
  const it = e.target.closest("[data-tt]");
  if (!it) return;
  try {
    await navigator.clipboard.writeText("@" + it.dataset.tt);
    it.classList.add("done");
    setTimeout(() => it.classList.remove("done"), 900);
  } catch { alert("@" + it.dataset.tt); }
});

tgTodayLoad();
setInterval(tgTodayLoad, 5 * 60 * 1000);

// ── Видео обучение ────────────────────────────────────────

let tvItems = [], tvIsAdmin = false, tvInited = false;

function tvSize(n) {
  n = Number(n) || 0;
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`;
}

async function tvLoad() {
  const grid = document.getElementById("tvGrid");
  if (!grid) return;
  if (!tvInited) {
    tvInited = true;
    grid.addEventListener("click", tvOnClick);
    document.getElementById("tvAddBtn")?.addEventListener("click", () => {
      document.getElementById("tvAddStatus").textContent = "";
      document.getElementById("tvAddModal").classList.add("open");
    });
    document.getElementById("tvAddCancel")?.addEventListener("click", () =>
      document.getElementById("tvAddModal").classList.remove("open"));
    document.getElementById("tvAddSave")?.addEventListener("click", tvUpload);
    document.getElementById("tvViewerClose")?.addEventListener("click", tvCloseViewer);
    document.getElementById("tvViewer")?.addEventListener("click", e => {
      if (e.target.id === "tvViewer") tvCloseViewer();
    });
  }
  try {
    const d = await ctJson("/api/training");
    tvItems = d.items || [];
    tvIsAdmin = !!d.is_admin;
    const btn = document.getElementById("tvAddBtn");
    if (btn) btn.style.display = tvIsAdmin ? "inline-flex" : "none";
    tvRender();
  } catch (e) {
    grid.innerHTML = `<div class="tvEmpty" style="color:#ff5c85;">Ошибка: ${escapeHtml(e.message)}</div>`;
  }
}

function tvRender() {
  const grid = document.getElementById("tvGrid");
  if (!grid) return;
  if (!tvItems.length) {
    grid.innerHTML = `<div class="tvEmpty">${tvIsAdmin
      ? "Пока пусто. Жми «+ Загрузить»."
      : "材料 пока не добавлены."}</div>`;
    return;
  }
  grid.innerHTML = tvItems.map(it => {
    const url = it.play_url || "";
    const media = it.kind === "photo"
      ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(it.title || "")}" loading="lazy" />`
      : `<video src="${escapeHtml(url)}" preload="metadata" muted></video>
         <span class="tvPlay"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span>`;
    const date = (it.created_at || "").slice(0, 10).split("-").reverse().join(".");
    return `
      <div class="tvCard" data-id="${it.id}">
        <div class="tvMedia" data-open="${it.id}">${media}</div>
        <div class="tvBody">
          <div class="tvTitle">${escapeHtml(it.title || "Без названия")}</div>
          ${it.description ? `<div class="tvDesc">${escapeHtml(it.description)}</div>` : ""}
          <div class="tvMeta">
            <span>${date}</span>
            <span>${tvSize(it.size_bytes)}</span>
            ${tvIsAdmin ? `<button class="tvDel" data-del="${it.id}">Удалить</button>` : ""}
          </div>
        </div>
      </div>`;
  }).join("");
}

function tvCloseViewer() {
  const v = document.getElementById("tvViewer");
  if (!v) return;
  v.classList.remove("open");
  document.getElementById("tvViewerBody").innerHTML = "";   // гасим звук
}

async function tvOnClick(e) {
  const del = e.target.closest("[data-del]");
  if (del) {
    const it = tvItems.find(x => x.id === del.dataset.del);
    if (!confirm(`Удалить «${it?.title || "материал"}»?`)) return;
    try {
      await ctJson(`/api/training/${encodeURIComponent(del.dataset.del)}`, { method: "DELETE" });
      tvItems = tvItems.filter(x => x.id !== del.dataset.del);
      tvRender();
    } catch (err) { alert("Не удалилось: " + err.message); }
    return;
  }

  const open = e.target.closest("[data-open]");
  if (open) {
    const it = tvItems.find(x => x.id === open.dataset.open);
    if (!it || !it.play_url) return;
    document.getElementById("tvViewerBody").innerHTML = it.kind === "photo"
      ? `<img src="${escapeHtml(it.play_url)}" alt="${escapeHtml(it.title || "")}" />`
      : `<video src="${escapeHtml(it.play_url)}" controls autoplay playsinline></video>`;
    document.getElementById("tvViewer").classList.add("open");
  }
}

async function tvUpload() {
  const fileEl = document.getElementById("tvFile");
  const status = document.getElementById("tvAddStatus");
  const btn = document.getElementById("tvAddSave");
  const file = fileEl?.files?.[0];
  if (!file) { status.textContent = "Выбери файл"; return; }
  if (file.size > 45 * 1024 * 1024) {
    status.textContent = `Файл ${(file.size / 1024 / 1024).toFixed(1)} МБ — предел 45 МБ`;
    return;
  }

  const fd = new FormData();
  fd.append("file", file);
  fd.append("title", document.getElementById("tvTitle").value.trim());
  fd.append("description", document.getElementById("tvDesc").value.trim());

  btn.disabled = true;
  status.textContent = "Загружаю...";
  try {
    const r = await fetch("/api/training", { method: "POST", body: fd });
    if (!r.ok) throw new Error((await r.text()).slice(0, 200));
    document.getElementById("tvAddModal").classList.remove("open");
    document.getElementById("tvTitle").value = "";
    document.getElementById("tvDesc").value = "";
    fileEl.value = "";
    await tvLoad();
  } catch (e) {
    status.textContent = "Не вышло: " + e.message;
  } finally {
    btn.disabled = false;
  }
}
