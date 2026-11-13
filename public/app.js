// 울진 버스 — 화면 쪽 코드
// 이 파일은 우리 Worker의 /api/... 만 부르고, TAGO는 직접 안 불러. (키 노출 없음)
//
// 화면은 세 개. 주소 뒤의 # 부분으로 어느 화면인지 정해 (뒤로가기, 공유, 홈화면 추가가 다 됨)
//   #                         처음 화면 (검색, 즐겨찾기, 최근 본 정류장)
//   #s/도시코드/정류장ID/이름    정류장 화면 (도착정보, 지나는 노선)
//   #r/도시코드/노선ID/정류장ID  노선 화면 (전체 경로, 버스 위치)

const $ = (id) => document.getElementById(id);
const REFRESH_SEC = 30;     // 실시간 정보 자동 새로고침 간격
const ALERT_SEC = 180;      // 알림: 이 시간(초) 안으로 들어오면 알려줌

const state = {
  stop: null,          // 지금 보는 정류장 {city, id, name, no}
  stopInfo: null,      // /api/stop 결과 (노선별 방면, 첫막차)
  arrivals: null,      // 마지막 도착정보
  fetchedAt: 0,        // 도착정보 받은 시각 (카운트다운 계산용)
  route: null,         // 지금 보는 노선 {city, id, node}
  watches: new Set(),  // 알림 걸어둔 것들 "정류장ID:노선ID"
  alerted: new Set(),  // 이미 알린 것 (같은 버스로 두 번 안 울리게)
};
let refreshTimer = null, tickTimer = null;

// ── 공통 도우미 ───────────────────────────────────────────

async function api(path) {
  const res = await fetch(path);
  const data = await res.json().catch(() => ({ error: "응답을 읽을 수 없어요" }));
  if (!res.ok || data.error) throw new Error(data.error || `오류 ${res.status}`);
  return data;
}

// API에서 온 글자는 항상 esc()를 거쳐서 넣음 (HTML 주입 방지)
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function showMsg(text) {
  $("msg").textContent = text || "";
  $("msg").hidden = !text;
}

function toast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 8000);
}

// 브라우저 저장소 (막혀 있는 환경에서도 안 죽게)
const store = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 무시 */ } },
};

// ── 방면 정보 (목록에 "→ ○○ 방면" 붙이기) ─────────────────
// /api/stop 결과를 정류장별로 기억해두고, 목록에 늦게라도 채워 넣음

const headingCache = new Map();
async function getHeading(s) {
  const key = `${s.city}:${s.id}`;
  if (!headingCache.has(key)) {
    headingCache.set(key, api(`/api/stop?city=${enc(s.city)}&node=${enc(s.id)}`)
      .then(d => d.heading)
      .catch(() => null));
  }
  return headingCache.get(key);
}
const enc = encodeURIComponent;
const nb = (s) => String(s).replace(/ /g, "\u00a0"); // 띄어쓰기에서 줄 안 바뀌게

// 목록의 각 정류장에 방면을 3개씩 차례로 채움 (한꺼번에 몰아서 부르지 않게)
async function fillHeadings(items) {
  const queue = items.slice(0, 20);
  const run = async () => {
    while (queue.length) {
      const { stop, el } = queue.shift();
      const h = stop.heading ?? await getHeading(stop);
      if (h) el.textContent = `→ ${h} 방면`;
    }
  };
  await Promise.all([run(), run(), run()]);
}

// ── 정류장 목록 (검색 결과, 주변, 즐겨찾기, 최근) ─────────────

function renderStopList(ul, stops, emptyText) {
  if (!stops.length) {
    ul.innerHTML = `<li class="empty">${esc(emptyText)}</li>`;
    return;
  }
  const pending = [];
  ul.replaceChildren(...stops.map(s => {
    const li = document.createElement("li");
    const extra = [s.no && `#${s.no}`, s.dist != null && `${s.dist}m`].filter(Boolean).join(" · ");
    li.innerHTML = `
      <span class="name">${esc(s.name)}</span>
      <span class="heading">${s.heading ? `→ ${esc(s.heading)} 방면` : ""}</span>
      <span class="meta">${esc(extra)}</span>`;
    seenStops.set(s.id, s);
    li.onclick = () => go(stopHash(s));
    pending.push({ stop: s, el: li.querySelector(".heading") });
    return li;
  }));
  fillHeadings(pending);
}

const seenStops = new Map(); // 정류장ID → 목록에서 본 정보 (번호, 방면)
const stopHash = (s) => `#s/${enc(s.city)}/${enc(s.id)}/${enc(s.name)}`;
const routeHash = (city, routeId, node) => `#r/${enc(city)}/${enc(routeId)}/${enc(node || "")}`;
const go = (hash) => { location.hash = hash; };

// ── 즐겨찾기 / 최근 본 정류장 ─────────────────────────────

const favs = () => store.get("favs", []);
const isFav = (s) => favs().some(f => f.id === s.id);
const favLabel = (s) => (isFav(s) ? "즐겨찾기 빼기" : "즐겨찾기 추가");

function toggleFav() {
  const s = state.stop;
  if (!s) return;
  const list = isFav(s) ? favs().filter(f => f.id !== s.id) : [...favs(), { ...s, heading: state.stopInfo?.heading ?? null }];
  store.set("favs", list);
  $("favBtn").textContent = favLabel(s);
}

function addRecent(s) {
  const list = store.get("recent", []).filter(r => r.id !== s.id);
  list.unshift(s);
  store.set("recent", list.slice(0, 8));
}

function renderHomeLists() {
  const f = favs();
  $("favSection").hidden = !f.length;
  if (f.length) renderStopList($("favList"), f, "");
  const r = store.get("recent", []).filter(x => !f.some(y => y.id === x.id));
  $("recentSection").hidden = !r.length;
  if (r.length) renderStopList($("recentList"), r, "");
}

// ── 처음 화면: 검색 / 내 주변 ─────────────────────────────

async function search(q) {
  showMsg("찾는 중…");
  try {
    const data = await api(`/api/stops?q=${enc(q)}`);
    $("resultTitle").textContent = `'${q}' 검색 결과`;
    $("resultSection").hidden = false;
    renderStopList($("resultList"), data.stops, "검색 결과 없음. 더 짧게 쳐보셈 (예: 후포)");
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
      $("resultTitle").textContent = "내 주변 정류장";
      $("resultSection").hidden = false;
      renderStopList($("resultList"), data.stops, "근처에 정류장 없음");
      showMsg("");
    } catch (e) { showMsg(e.message); }
  }, () => showMsg("위치 권한이 없어서 주변 정류장을 못 찾았어요"), { timeout: 10000, maximumAge: 60000 });
}

// ── 정류장 화면 ───────────────────────────────────────────

async function openStop(city, id, name) {
  state.stop = { city, id, name, no: "" };
  state.stopInfo = null;
  state.arrivals = null;
  $("stopName").textContent = name;
  $("stopMeta").textContent = "";
  $("favBtn").textContent = favLabel(state.stop);
  $("arrivalList").innerHTML = `<li class="empty">불러오는 중…</li>`;
  $("routeList").innerHTML = "";

  // 정류장 정보(노선·방면)와 도착정보를 동시에 요청
  const infoP = api(`/api/stop?city=${enc(city)}&node=${enc(id)}&full=1`)
    .then(d => { state.stopInfo = d; renderStopInfo(); })
    .catch(e => { $("routeList").innerHTML = `<li class="empty">${esc(e.message)}</li>`; });
  await refreshArrivals();
  await infoP;
  renderArrivals();

  // 정류장 번호는 목록/즐겨찾기/최근에 있던 것에서 가져옴
  const known = seenStops.get(id) || [...favs(), ...store.get("recent", [])].find(s => s.id === id);
  if (known?.no) state.stop.no = known.no;
  addRecent({ ...state.stop, heading: state.stopInfo?.heading ?? known?.heading ?? null });
  renderStopMeta();
  startTimers(refreshArrivals);
}

function renderStopMeta() {
  const h = state.stopInfo?.heading;
  $("stopMeta").textContent = [state.stop.no && `#${state.stop.no}`, h && `→ ${h} 방면`].filter(Boolean).join(" · ");
}

// 노선ID → 노선 정보 (방면, 첫막차)
const routeById = (id) => state.stopInfo?.routes.find(r => r.id === id);

function renderStopInfo() {
  renderStopMeta();
  const live = new Set((state.arrivals?.arrivals || []).map(a => a.routeId));
  const routes = state.stopInfo.routes;
  if (!routes.length) {
    $("routeList").innerHTML = `<li class="empty">노선 정보가 없어요</li>`;
    return;
  }
  $("routeList").innerHTML = routes.map(r => {
    const dir = r.terminal ? `여기가 종점 · ${r.dest ? `${r.dest}행으로 회차` : ""}` : (r.dest ? `${r.dest}행` : `${r.start} ↔ ${r.end}`);
    const next = r.next && !r.terminal ? `다음 ${r.next}` : "";
    const times = [r.first && `첫차 ${r.first}`, r.last && `막차 ${r.last}`, r.interval && `배차 ${r.interval}분`].filter(Boolean).map(nb).join(" · ");
    return `<li data-route="${esc(r.id)}">
      <span class="route">${esc(r.no)}</span>
      <span class="body">
        <span class="dir">${esc(dir)}</span>
        <span class="detail">${esc([next && nb(next), times].filter(Boolean).join(" · "))}</span>
      </span>
      <span class="live">${live.has(r.id) ? "운행중" : ""}</span>
    </li>`;
  }).join("");
  $("routeList").querySelectorAll("li[data-route]").forEach(li => {
    li.onclick = () => go(routeHash(state.stop.city, li.dataset.route, state.stop.id));
  });
}

async function refreshArrivals() {
  const s = state.stop;
  if (!s) return;
  try {
    const data = await api(`/api/arrivals?city=${enc(s.city)}&node=${enc(s.id)}`);
    if (state.stop !== s) return; // 그 사이 다른 정류장으로 갔으면 버림
    state.arrivals = data;
    state.fetchedAt = Date.now();
    renderArrivals();
    if (state.stopInfo) renderStopInfo();
    showMsg("");
  } catch (e) { showMsg(e.message); }
}

// 초 → "곧 도착" / "7분" + 색 등급
function formatTime(sec) {
  if (!isFinite(sec)) return { text: "-", cls: "" };
  if (sec < 60) return { text: "곧도착!!", cls: "soon" };
  const min = Math.round(sec / 60);
  return { text: `${min}분`, cls: min <= 3 ? "soon" : min <= 10 ? "near" : "" };
}

// 받은 뒤 흐른 시간만큼 빼서 보여줌 (30초마다 받아오지만 숫자는 계속 줄어들게)
function renderArrivals() {
  const data = state.arrivals;
  if (!data) return;
  const elapsed = (Date.now() - state.fetchedAt) / 1000;
  const list = $("arrivalList");

  if (!data.arrivals.length) {
    list.innerHTML = `<li class="empty">지금은 오는 버스 정보가 없음 (시골 노선은 원래 잘 안 나옴)</li>`;
  } else {
    list.innerHTML = data.arrivals.map(a => {
      const left = Math.max(0, a.seconds - elapsed);
      const t = formatTime(left);
      const r = routeById(a.routeId);
      const dir = r?.dest ? `${r.dest}행` : "";
      const detail = [isFinite(a.stopsAway) && `${a.stopsAway}정류장 전`, a.vehicleType].filter(Boolean).join(" · ");
      const key = `${state.stop.id}:${a.routeId}`;
      checkAlert(key, a, left, dir);
      return `<li class="${t.cls}" data-sec="${a.seconds}" data-key="${esc(key)}" data-route-no="${esc(a.route)}" data-dir="${esc(dir)}">
        <button class="route link-route" data-route="${esc(a.routeId)}">${esc(a.route)}</button>
        <span class="body">
          <span class="dir">${esc(dir)}</span>
          <span class="detail">${esc(detail)}</span>
        </span>
        <span class="time">${esc(t.text)}</span>
        <button class="bell ${state.watches.has(key) ? "on" : ""}" data-key="${esc(key)}" aria-label="도착 알림">${state.watches.has(key) ? "알림켜짐" : "알림"}</button>
      </li>`;
    }).join("");
    list.querySelectorAll(".link-route").forEach(b => {
      b.onclick = () => go(routeHash(state.stop.city, b.dataset.route, state.stop.id));
    });
    list.querySelectorAll(".bell").forEach(b => { b.onclick = () => toggleWatch(b.dataset.key); });
  }
  const d = new Date(data.updated);
  $("updated").textContent = `${d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })} 기준`;
}

// 1초마다: 남은 시간 글자와 색만 바꿈
function updateTimes() {
  const elapsed = (Date.now() - state.fetchedAt) / 1000;
  $("arrivalList").querySelectorAll("li[data-sec]").forEach(li => {
    const left = Math.max(0, Number(li.dataset.sec) - elapsed);
    const t = formatTime(left);
    li.className = t.cls;
    li.querySelector(".time").textContent = t.text;
    checkAlert(li.dataset.key, { route: li.dataset.routeNo }, left, li.dataset.dir);
  });
}

// ── 도착 알림 (화면을 켜둔 동안만) ──────────────────────

async function toggleWatch(key) {
  if (state.watches.has(key)) {
    state.watches.delete(key);
  } else {
    state.watches.add(key);
    state.alerted.delete(key);
    toast("도착 3분 전에 알려드림. 이 화면 켜놔야 됨!");
  }
  renderArrivals();
  // 권한 창은 화면을 먼저 바꾼 다음에 띄움 (창이 떠 있는 동안 화면이 멈춰 보이지 않게)
  if (state.watches.has(key) && "Notification" in window && Notification.permission === "default") {
    try { await Notification.requestPermission(); } catch { /* 무시 */ }
  }
}

function checkAlert(key, a, left, dir) {
  if (!state.watches.has(key) || state.alerted.has(key) || left > ALERT_SEC) return;
  state.alerted.add(key);
  const text = `${a.route}번${dir ? ` (${dir})` : ""} ${formatTime(left).text}! ${state.stop.name}`;
  toast(`[알림] ${text}`);
  try { navigator.vibrate?.([200, 100, 200]); } catch { /* 무시 */ }
  try {
    if ("Notification" in window && Notification.permission === "granted") new Notification("울진 버스", { body: text, icon: "/icon-192.png" });
  } catch { /* 일부 모바일 브라우저는 여기서 막힘 → 토스트로 충분 */ }
}

// ── 노선 화면 ─────────────────────────────────────────────

async function openRoute(city, id, node) {
  state.route = { city, id, node };
  $("routeName").textContent = "노선";
  $("routeMeta").textContent = "";
  $("routeTimes").textContent = "";
  $("lineList").innerHTML = `<li class="empty">불러오는 중…</li>`;
  await refreshRoute(true);
  startTimers(() => refreshRoute(false));
}

async function refreshRoute(first) {
  const r = state.route;
  if (!r) return;
  try {
    const data = await api(`/api/route?city=${enc(r.city)}&route=${enc(r.id)}`);
    if (state.route !== r) return;
    renderRoute(data, first);
    showMsg("");
  } catch (e) { showMsg(e.message); }
}

function renderRoute(data, first) {
  const info = data.info || {};
  $("routeName").textContent = info.no ? `${info.no}번` : "노선";
  $("routeMeta").textContent = [info.type, info.start && info.end && `${info.start} ↔ ${info.end}`].filter(Boolean).join(" · ");
  const iv = [info.interval && `평일 ${info.interval}분`, info.intervalSat && `토 ${info.intervalSat}분`, info.intervalSun && `일 ${info.intervalSun}분`].filter(Boolean).join(" / ");
  $("routeTimes").textContent = [info.first && `첫차 ${info.first}`, info.last && `막차 ${info.last}`, iv && `배차 ${iv}`].filter(Boolean).join(" · ");

  // 정류장 순번(ord)별로 지금 있는 버스
  const busAt = new Map();
  for (const b of data.buses) {
    if (!busAt.has(b.ord)) busAt.set(b.ord, []);
    busAt.get(b.ord).push(b);
  }

  let prevUpdown = null;
  $("lineList").innerHTML = data.stops.map(s => {
    // 상행→하행이 바뀌는 곳에 "회차" 표시
    const turn = prevUpdown !== null && s.updown !== prevUpdown ? `<li class="turn">회차</li>` : "";
    prevUpdown = s.updown;
    const buses = busAt.get(s.ord) || [];
    const here = s.id === state.route.node;
    return `${turn}<li class="${here ? "here" : ""} ${buses.length ? "has-bus" : ""}" data-node="${esc(s.id)}" data-name="${esc(s.name)}">
      <span class="dot"></span>
      <span class="name">${esc(s.name)}${here ? " <em>여기</em>" : ""}</span>
      <span class="bus">${buses.map(b => `버스 ${esc(String(b.vehicle).slice(-4))}`).join(", ")}</span>
    </li>`;
  }).join("") || `<li class="empty">경유 정류장 정보가 없어요</li>`;

  $("lineList").querySelectorAll("li[data-node]").forEach(li => {
    li.onclick = () => go(stopHash({ city: state.route.city, id: li.dataset.node, name: li.dataset.name }));
  });

  const d = new Date(data.updated);
  $("routeUpdated").textContent = data.busError
    ? `버스 위치를 못 받았어요 (${data.busError})`
    : `버스 ${data.buses.length}대 운행중 · ${d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준`;

  if (first) $("lineList").querySelector(".here")?.scrollIntoView({ block: "center" });
}

// ── 자동 새로고침 + 카운트다운 ────────────────────────────

function startTimers(refreshFn) {
  stopTimers();
  let next = Date.now() + REFRESH_SEC * 1000;
  refreshTimer = setInterval(() => {
    if (document.hidden) return;
    next = Date.now() + REFRESH_SEC * 1000;
    refreshFn();
  }, REFRESH_SEC * 1000);
  // 1초마다: 남은 시간 숫자 줄이기 + "N초 후 갱신"
  tickTimer = setInterval(() => {
    $("countdown").textContent = `${Math.max(0, Math.round((next - Date.now()) / 1000))}초 후 갱신`;
    if (state.stop && !$("stopView").hidden) updateTimes();
  }, 1000);
}
function stopTimers() { clearInterval(refreshTimer); clearInterval(tickTimer); }

// ── 화면 전환 (주소의 # 부분을 보고 결정) ─────────────────

function route() {
  const parts = location.hash.slice(1).split("/").map(decodeURIComponent);
  const view = parts[0];
  $("homeView").hidden = !!view && view !== "";
  $("stopView").hidden = view !== "s";
  $("routeView").hidden = view !== "r";
  showMsg("");
  stopTimers();
  window.scrollTo(0, 0);

  if (view === "s" && parts[1] && parts[2]) {
    openStop(parts[1], parts[2], parts[3] || "정류장");
  } else if (view === "r" && parts[1] && parts[2]) {
    openRoute(parts[1], parts[2], parts[3]);
  } else {
    $("homeView").hidden = false;
    state.stop = null; state.route = null;
    renderHomeLists();
  }
}

// ── 시작 ──────────────────────────────────────────────────

$("searchForm").onsubmit = (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (q) { $("q").blur(); search(q); }
};
$("nearbyBtn").onclick = nearby;
$("favBtn").onclick = toggleFav;
$("refreshBtn").onclick = refreshArrivals;
$("routeRefreshBtn").onclick = () => refreshRoute(false);
$("clearRecent").onclick = () => { store.set("recent", []); renderHomeLists(); };
document.querySelectorAll("[data-back]").forEach(b => {
  b.onclick = () => (history.length > 1 ? history.back() : go(""));
});
// 다른 앱 갔다 돌아오면 바로 새로고침
document.addEventListener("visibilitychange", () => {
  if (document.hidden) return;
  if (!$("stopView").hidden) refreshArrivals();
  if (!$("routeView").hidden) refreshRoute(false);
});
window.addEventListener("hashchange", route);

// 예전 버전 주소(#{"id":...}) 호환
try {
  const old = JSON.parse(decodeURIComponent(location.hash.slice(1)));
  if (old?.id && old?.city) location.replace(stopHash(old));
} catch { /* 새 형식 */ }

route();
