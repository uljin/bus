// 울진 버스 — 화면 쪽 코드
// 이 파일은 우리 Worker의 /api/... 만 부르고, TAGO는 직접 안 불러. (키 노출 없음)

const $ = (id) => document.getElementById(id);
const REFRESH_SEC = 30;      // 도착정보 자동 새로고침 간격
let current = null;          // 지금 보고 있는 정류장 {id, name, no, city}
let timer = null;

// ── API 호출 ─────────────────────────────────────────
async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({ error: "응답을 읽을 수 없어요" }));
  if (!res.ok || data.error) throw new Error(data.error || `오류 ${res.status}`);
  return data;
}

// ── 즐겨찾기 (이 브라우저에만 저장) ─────────────────────
function loadFavs() {
  try { return JSON.parse(localStorage.getItem("favs") || "[]"); } catch { return []; }
}
function saveFavs(favs) {
  try { localStorage.setItem("favs", JSON.stringify(favs)); } catch { /* 저장 불가 환경이면 무시 */ }
}
const isFav = (s) => loadFavs().some(f => f.id === s.id);

function toggleFav() {
  if (!current) return;
  let favs = loadFavs();
  favs = isFav(current) ? favs.filter(f => f.id !== current.id) : [...favs, current];
  saveFavs(favs);
  renderFavs();
  $("favBtn").textContent = isFav(current) ? "★" : "☆";
}

// ── 화면 그리기 ───────────────────────────────────────
// API에서 온 글자는 항상 esc()를 거쳐서 넣음 (HTML 주입 방지)
const esc = (s) => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function stopItem(s) {
  const li = document.createElement("li");
  const meta = [s.no && `#${s.no}`, s.dist != null && `${s.dist}m`].filter(Boolean).join(" · ");
  li.innerHTML = `<span>${esc(s.name)}</span><span class="meta">${esc(meta)}</span>`;
  li.onclick = () => openStop(s);
  return li;
}

function renderFavs() {
  const favs = loadFavs();
  $("favSection").hidden = favs.length === 0;
  $("favList").replaceChildren(...favs.map(stopItem));
}

function renderStops(title, stops) {
  $("resultTitle").textContent = title;
  $("resultSection").hidden = false;
  if (stops.length === 0) {
    $("resultList").innerHTML = `<li class="meta">찾은 정류장이 없어요</li>`;
  } else {
    $("resultList").replaceChildren(...stops.map(stopItem));
  }
}

// 초 → "곧 도착" / "7분" 같은 글자 + 색 등급
function formatTime(sec) {
  if (!isFinite(sec)) return { text: "-", cls: "" };
  if (sec < 60) return { text: "곧 도착", cls: "soon" };
  const min = Math.round(sec / 60);
  return { text: `${min}분`, cls: min <= 3 ? "soon" : min <= 10 ? "near" : "" };
}

function renderArrivals(data) {
  const list = $("arrivalList");
  if (data.arrivals.length === 0) {
    list.innerHTML = `<li><span></span><span class="detail">지금 다가오는 버스 정보가 없어요</span><span></span></li>`;
  } else {
    list.innerHTML = data.arrivals.map(a => {
      const t = formatTime(a.seconds);
      const detail = [isFinite(a.stopsAway) && `${a.stopsAway}정류장 전`, a.vehicleType].filter(Boolean).join(" · ");
      return `<li class="${t.cls}">
        <span class="route">${esc(a.route)}</span>
        <span class="detail">${esc(detail)}</span>
        <span class="time">${esc(t.text)}</span>
      </li>`;
    }).join("");
  }
  const d = new Date(data.updated);
  $("updated").textContent = `${d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 기준`;
}

function showMsg(text) {
  $("msg").textContent = text;
  $("msg").hidden = !text;
}

// ── 동작 ──────────────────────────────────────────────
async function search(q) {
  showMsg("찾는 중…");
  try {
    const data = await api(`/api/stops?q=${encodeURIComponent(q)}`);
    renderStops(`'${q}' 검색 결과`, data.stops);
    showMsg("");
  } catch (e) { showMsg(e.message); }
}

function nearby() {
  if (!navigator.geolocation) return showMsg("이 브라우저는 위치를 지원하지 않아요");
  showMsg("위치 확인 중…");
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      const { latitude: lat, longitude: lng } = pos.coords;
      const data = await api(`/api/nearby?lat=${lat}&lng=${lng}`);
      renderStops("내 주변 정류장", data.stops);
      showMsg("");
    } catch (e) { showMsg(e.message); }
  }, () => showMsg("위치 권한이 없어서 주변 정류장을 못 찾았어요"), { timeout: 10000 });
}

async function openStop(s) {
  current = { id: s.id, name: s.name, no: s.no, city: s.city };
  // 주소 뒤에 정류장 정보를 붙여서, 이 링크를 공유하거나 홈 화면에 추가하면 바로 열리게
  history.replaceState(null, "", `#${encodeURIComponent(JSON.stringify(current))}`);
  $("arrivalSection").hidden = false;
  $("stopName").textContent = s.name;
  $("stopMeta").textContent = s.no ? `정류장 번호 ${s.no}` : "";
  $("favBtn").textContent = isFav(current) ? "★" : "☆";
  $("arrivalList").innerHTML = `<li><span></span><span class="detail">불러오는 중…</span><span></span></li>`;
  $("arrivalSection").scrollIntoView({ behavior: "smooth" });
  await refresh();
  clearInterval(timer);
  timer = setInterval(() => { if (!document.hidden) refresh(); }, REFRESH_SEC * 1000);
}

async function refresh() {
  if (!current) return;
  try {
    const data = await api(`/api/arrivals?city=${encodeURIComponent(current.city)}&node=${encodeURIComponent(current.id)}`);
    renderArrivals(data);
    showMsg("");
  } catch (e) { showMsg(e.message); }
}

// ── 시작 ──────────────────────────────────────────────
$("searchForm").onsubmit = (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (q) search(q);
};
$("nearbyBtn").onclick = nearby;
$("favBtn").onclick = toggleFav;
$("refreshBtn").onclick = refresh;
// 다른 앱 갔다 돌아오면 바로 새로고침
document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });

renderFavs();
// 주소에 정류장 정보가 있으면 바로 열기
try {
  const s = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  if (s && s.id && s.city) openStop(s);
} catch { /* 해시 없음 */ }
