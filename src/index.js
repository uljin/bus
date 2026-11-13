// 울진 버스 도착정보 — Cloudflare Worker (API 프록시)
//
// 하는 일:
//   1. 브라우저 대신 TAGO(국토부 대중교통 API)를 불러줌 → API 키가 브라우저에 노출 안 됨
//   2. 응답을 잠깐 캐시 → TAGO 하루 호출 한도를 아끼고 빨라짐
//   3. 여러 TAGO API를 엮어서 "어느 방면인지" 같은 정보를 계산해줌
//
// 엔드포인트:
//   GET /api/stops?q=후포                    정류장 이름 검색
//   GET /api/nearby?lat=..&lng=..            내 주변 정류장
//   GET /api/arrivals?city=..&node=..        정류장 도착 예정 버스
//   GET /api/stop?city=..&node=..[&full=1]   정류장을 지나는 노선 + 방면(다음 정류장, 종점)
//                                            full=1이면 첫차·막차·배차간격까지
//   GET /api/route?city=..&route=..          노선 상세 + 경유 정류장 + 지금 버스 위치
//   GET /api/city, /api/cities               도시코드 확인용 (디버깅)
//
// 쓰는 TAGO API (data.go.kr, 키는 하나로 공통):
//   15098534 버스정류소정보  BusSttnInfoInqireService
//   15098530 버스도착정보    ArvlInfoInqireService
//   15098529 버스노선정보    BusRouteInfoInqireService
//   15098533 버스위치정보    BusLcInfoInqireService

const BASE = "https://apis.data.go.kr/1613000";

// 캐시 유지 시간(초). 실시간인 건 짧게, 잘 안 바뀌는 건 길게.
const TTL = {
  day: 86400,     // 도시, 정류장 검색, 노선 경유지, 노선 정보, 정류장 경유노선
  nearby: 3600,   // 주변 정류장
  live: 20,       // 도착정보, 버스 위치
};

// Worker가 살아있는 동안만 유지되는 메모리 캐시 (1차)
const memCache = new Map();
const MEM_MAX = 500;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // /api/ 로 시작 안 하면 정적 파일(public/) 담당에게 넘김
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (!env.TAGO_KEY) throw new HttpError(500, "TAGO_KEY가 등록 안 됐어 (대시보드에서 Secret으로 등록)");
      const p = url.searchParams;
      const need = (k) => {
        const v = (p.get(k) || "").trim();
        if (!v) throw new HttpError(400, `${k}가 필요해`);
        return v;
      };

      switch (url.pathname) {
        case "/api/city":
          return json({ cityCode: await getCityCode(env, ctx), cityName: env.CITY_NAME });

        case "/api/cities": {
          const cities = await getCities(env, ctx);
          return json({ count: cities.length, cities: cities.map(c => ({ code: String(c.citycode), name: c.cityname })) });
        }

        case "/api/stops": {
          const q = need("q");
          const cityCode = await getCityCode(env, ctx);
          const items = await tago(env, ctx, "/BusSttnInfoInqireService/getSttnNoList",
            { cityCode, nodeNm: q, numOfRows: 50 }, TTL.day);
          return json({ stops: items.map(toStop(cityCode)) });
        }

        case "/api/nearby": {
          const lat = Number(p.get("lat")), lng = Number(p.get("lng"));
          if (!isFinite(lat) || !isFinite(lng)) throw new HttpError(400, "lat, lng가 필요해");
          // 좌표를 소수 3자리(약 100m)로 반올림 → 비슷한 위치끼리 캐시를 같이 씀
          const items = await tago(env, ctx, "/BusSttnInfoInqireService/getCrdntPrxmtSttnList",
            { gpsLati: lat.toFixed(3), gpsLong: lng.toFixed(3), numOfRows: 30 }, TTL.nearby);
          const cityCode = await getCityCode(env, ctx);
          const stops = items.map(toStop(cityCode))
            .map(s => ({ ...s, dist: distM(lat, lng, s.lat, s.lng) }))
            .sort((a, b) => a.dist - b.dist);
          return json({ stops });
        }

        case "/api/arrivals": {
          const city = need("city"), node = need("node");
          const items = await tago(env, ctx, "/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList",
            { cityCode: city, nodeId: node, numOfRows: 50 }, TTL.live);
          const arrivals = items.map(it => ({
            routeId: String(it.routeid ?? ""),        // 노선ID (다른 API와 연결할 때 씀)
            route: String(it.routeno ?? ""),          // 노선번호
            routeType: it.routetp ?? "",              // 노선유형
            stopsAway: Number(it.arrprevstationcnt),  // 남은 정류장 수
            seconds: Number(it.arrtime),              // 도착까지 남은 초
            vehicleType: it.vehicletp ?? "",          // 차량유형 (저상 등)
          })).sort((a, b) => a.seconds - b.seconds);
          return json({ arrivals, updated: new Date().toISOString() });
        }

        case "/api/stop": {
          const city = need("city"), node = need("node");
          return json(await stopRoutes(env, ctx, city, node, p.get("full") === "1"));
        }

        case "/api/route": {
          const city = need("city"), route = need("route");
          const [info, stops, buses] = await Promise.all([
            routeInfo(env, ctx, city, route).catch(e => ({ error: e.message })),
            routeStops(env, ctx, city, route),
            routeBuses(env, ctx, city, route).catch(e => ({ error: e.message })),
          ]);
          return json({
            info,
            stops,
            buses: Array.isArray(buses) ? buses : [],
            busError: Array.isArray(buses) ? null : buses.error,
            updated: new Date().toISOString(),
          });
        }

        default:
          throw new HttpError(404, "없는 API야");
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 502;
      return json({ error: e.message }, status);
    }
  },
};

// ── 방면 계산 ────────────────────────────────────────────────────
//
// TAGO엔 "이 정류장은 어느 방면" 정보가 따로 없어. 그래서:
//   1) 이 정류장을 지나는 노선 목록을 받고
//   2) 노선마다 경유 정류장 순서를 받아서
//   3) 이 정류장 "다음" 정류장과, 같은 방향(상행/하행)의 마지막 정류장(종점)을 찾음
// 길 건너 마주 보는 같은 이름 정류장도 다음 정류장이 달라서 구분돼.

async function stopRoutes(env, ctx, city, node, full) {
  const through = await tago(env, ctx, "/BusSttnInfoInqireService/getSttnThrghRouteList",
    { cityCode: city, nodeid: node, numOfRows: 100 }, TTL.day);

  const routes = await mapLimit(through, 4, async (r) => {
    const id = String(r.routeid);
    const out = {
      id,
      no: String(r.routeno ?? ""),
      type: r.routetp ?? "",
      start: r.startnodenm ?? "",
      end: r.endnodenm ?? "",
      next: null,      // 다음 정류장 이름
      dest: null,      // 이 방향 종점
      terminal: false, // 여기가 종점인지
    };
    try {
      const stops = await routeStops(env, ctx, city, id);
      const i = stops.findIndex(s => s.id === node);
      if (i >= 0) {
        const me = stops[i];
        const seg = me.updown !== "" ? stops.filter(s => s.updown === me.updown) : stops;
        const last = seg[seg.length - 1];
        const after = stops[i + 1];
        out.terminal = last.id === node && seg.length > 1;
        out.next = after?.name ?? null;
        if (out.terminal && after) {
          // 여기서 회차하는 경우: 반대 방향 구간의 종점이 목적지
          const back = stops.filter(s => s.updown === after.updown);
          out.dest = back[back.length - 1].name;
        } else {
          out.dest = last.name;
        }
      }
    } catch { /* 노선정보 API 미승인 등 → 방면 없이 노선만 보여줌 */ }
    if (full) {
      try { Object.assign(out, await routeInfo(env, ctx, city, id)); } catch { /* 시간 정보 없음 */ }
    }
    return out;
  });

  routes.sort((a, b) => a.no.localeCompare(b.no, "ko", { numeric: true }));

  // 정류장 전체의 대표 방면 = 노선들의 "다음 정류장" 중 가장 많은 것
  const count = {};
  for (const r of routes) if (r.next) count[r.next] = (count[r.next] || 0) + 1;
  const heading = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return { heading, routes };
}

// 노선의 경유 정류장 (순서대로)
async function routeStops(env, ctx, city, route) {
  const items = await tago(env, ctx, "/BusRouteInfoInqireService/getRouteAcctoThrghSttnList",
    { cityCode: city, routeId: route, numOfRows: 500 }, TTL.day);
  return items.map(it => ({
    id: String(it.nodeid),
    name: String(it.nodenm),
    no: it.nodeno != null ? String(it.nodeno) : "",
    ord: Number(it.nodeord),
    updown: it.updowncd != null ? String(it.updowncd) : "",  // 0/1 = 상행/하행 구분
    lat: Number(it.gpslati),
    lng: Number(it.gpslong),
  })).sort((a, b) => a.ord - b.ord);
}

// 노선 기본정보: 기점·종점, 첫차·막차, 배차간격
async function routeInfo(env, ctx, city, route) {
  const items = await tago(env, ctx, "/BusRouteInfoInqireService/getRouteInfoIem",
    { cityCode: city, routeId: route }, TTL.day);
  const it = items[0];
  if (!it) return {};
  return {
    no: String(it.routeno ?? ""),
    type: it.routetp ?? "",
    start: it.startnodenm ?? "",
    end: it.endnodenm ?? "",
    first: hhmm(it.startvehicletime),     // 첫차
    last: hhmm(it.endvehicletime),        // 막차
    interval: num(it.intervaltime),       // 평일 배차(분)
    intervalSat: num(it.intervalsattime), // 토요일
    intervalSun: num(it.intervalsuntime), // 일요일
  };
}

// 지금 이 노선을 달리는 버스들의 위치
async function routeBuses(env, ctx, city, route) {
  const items = await tago(env, ctx, "/BusLcInfoInqireService/getRouteAcctoBusLcList",
    { cityCode: city, routeId: route, numOfRows: 100 }, TTL.live);
  return items.map(it => ({
    node: String(it.nodeid ?? ""),
    ord: Number(it.nodeord),
    name: it.nodenm ?? "",
    vehicle: it.vehicleno ?? "",
    lat: Number(it.gpslati),
    lng: Number(it.gpslong),
  }));
}

// ── TAGO 호출 + 캐시 ─────────────────────────────────────────────

async function tago(env, ctx, path, params, ttl) {
  // 캐시 키에는 API 키를 넣지 않음 (키가 어디에도 기록되지 않게)
  const query = new URLSearchParams({ ...params, _type: "json" }).toString();
  const cacheKey = `https://cache.uljin-bus${path}?${query}`;

  // 1) 메모리 캐시
  const hit = memCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.items;

  // 2) Cloudflare Cache API (커스텀 도메인에서 동작)
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const items = await cached.json();
    remember(cacheKey, items, ttl);
    return items;
  }

  // 3) 진짜 TAGO 호출
  // serviceKey는 data.go.kr의 "Decoding" 키를 등록하고, 여기서 한 번만 인코딩함
  // (Encoding 키를 등록하면 두 번 인코딩돼서 SERVICE_KEY 오류가 나)
  const url = `${BASE}${path}?serviceKey=${encodeURIComponent(env.TAGO_KEY.trim())}&${query}`;
  const res = await fetch(url);
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    // 키 오류 같은 건 _type=json 이어도 XML로 와서 여기로 빠짐
    const msg = text.match(/<returnAuthMsg>(.*?)<\/returnAuthMsg>/)?.[1]
             || text.match(/<resultMsg>(.*?)<\/resultMsg>/)?.[1]
             || text.slice(0, 120);
    throw new HttpError(502, `TAGO 오류: ${msg} (${path.split("/")[1]})`);
  }

  const header = data?.response?.header;
  if (header && header.resultCode !== "00") {
    throw new HttpError(502, `TAGO 오류: ${header.resultMsg} (${header.resultCode})`);
  }

  const items = normalizeItems(data);
  remember(cacheKey, items, ttl);
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(items), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` },
  })));
  return items;
}

function remember(key, items, ttl) {
  if (memCache.size >= MEM_MAX) memCache.delete(memCache.keys().next().value); // 제일 오래된 것 버림
  memCache.set(key, { items, expires: Date.now() + ttl * 1000 });
}

// TAGO는 결과가 0개면 items가 "", 1개면 객체, 여러 개면 배열로 줌 → 항상 배열로 통일
function normalizeItems(data) {
  const item = data?.response?.body?.items?.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

// numOfRows를 안 주면 기본 10개만 와서, 넉넉히 1000으로 요청함
function getCities(env, ctx) {
  return tago(env, ctx, "/BusSttnInfoInqireService/getCtyCodeList", { numOfRows: 1000 }, TTL.day);
}

async function getCityCode(env, ctx) {
  // wrangler.toml에 CITY_CODE를 직접 적어두면 그걸 우선 씀
  if (env.CITY_CODE) return String(env.CITY_CODE);
  const cities = await getCities(env, ctx);
  const name = env.CITY_NAME || "울진";
  const found = cities.find(c => String(c.cityname).includes(name));
  if (!found) throw new HttpError(500, `TAGO 도시 목록(${cities.length}곳)에 '${name}'이 없어. /api/cities 에서 목록 확인`);
  return String(found.citycode);
}

// ── 작은 도우미들 ─────────────────────────────────────────────────

const toStop = (fallbackCity) => (it) => ({
  id: String(it.nodeid),
  name: String(it.nodenm),
  no: it.nodeno != null ? String(it.nodeno) : "",
  city: String(it.citycode ?? fallbackCity ?? ""),
  lat: Number(it.gpslati),
  lng: Number(it.gpslong),
});

// 550, "0550" → "05:50"
function hhmm(v) {
  const s = String(v ?? "").replace(/\D/g, "");
  if (!s) return null;
  const p = s.padStart(4, "0");
  return `${p.slice(0, 2)}:${p.slice(2, 4)}`;
}
const num = (v) => (v === undefined || v === null || v === "" || isNaN(Number(v)) ? null : Number(v));

// 동시에 n개씩만 실행 (TAGO에 한꺼번에 몰아서 부르지 않게)
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  const worker = async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

// 두 좌표 사이 거리(m) — 하버사인 공식
function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000, rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad, dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
