// 울진 버스 도착정보 — Cloudflare Worker (API 프록시)
//
// 하는 일:
//   1. 브라우저 대신 TAGO(국토부 대중교통 API)를 불러줌 → API 키가 브라우저에 노출 안 됨
//   2. 응답을 잠깐 캐시 → TAGO 하루 호출 한도를 아끼고 빨라짐
//   3. TAGO의 복잡한 응답을 프론트가 쓰기 쉬운 모양으로 정리
//
// 엔드포인트:
//   GET /api/stops?q=후포         정류장 이름 검색 (울진 안에서)
//   GET /api/nearby?lat=..&lng=.. 내 주변 정류장
//   GET /api/arrivals?city=..&node=..  정류장 도착 예정 버스
//   GET /api/city                 지금 쓰는 도시코드 확인용 (디버깅)

const BASE = "https://apis.data.go.kr/1613000";

// 캐시 유지 시간(초). 도착정보는 짧게, 잘 안 바뀌는 건 길게.
const TTL = {
  city: 86400,    // 도시코드: 하루
  stops: 86400,   // 정류장 검색: 하루
  nearby: 3600,   // 주변 정류장: 1시간
  arrivals: 20,   // 도착정보: 20초
};

// Worker가 살아있는 동안만 유지되는 메모리 캐시.
// (Cache API는 workers.dev 주소에선 동작 안 해서, 이걸 1차 캐시로 둠)
const memCache = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // /api/ 로 시작 안 하면 정적 파일(public/) 담당에게 넘김
    if (!url.pathname.startsWith("/api/")) {
      return env.ASSETS.fetch(request);
    }

    try {
      if (!env.TAGO_KEY) throw new HttpError(500, "TAGO_KEY가 등록 안 됐어 (wrangler secret put TAGO_KEY)");
      const p = url.searchParams;

      switch (url.pathname) {
        case "/api/city":
          return json({ cityCode: await getCityCode(env, ctx), cityName: env.CITY_NAME });

        case "/api/stops": {
          const q = (p.get("q") || "").trim();
          if (!q) throw new HttpError(400, "검색어(q)가 필요해");
          const cityCode = await getCityCode(env, ctx);
          const items = await tago(env, ctx, "/BusSttnInfoInqireService/getSttnNoList",
            { cityCode, nodeNm: q, numOfRows: 50 }, TTL.stops);
          return json({ stops: items.map(toStop(cityCode)) });
        }

        case "/api/nearby": {
          const lat = Number(p.get("lat")), lng = Number(p.get("lng"));
          if (!isFinite(lat) || !isFinite(lng)) throw new HttpError(400, "lat, lng가 필요해");
          // 좌표를 소수 3자리(약 100m)로 반올림 → 비슷한 위치끼리 캐시를 같이 씀
          const items = await tago(env, ctx, "/BusSttnInfoInqireService/getCrdntPrxmtSttnList",
            { gpsLati: lat.toFixed(3), gpsLong: lng.toFixed(3), numOfRows: 30 }, TTL.nearby);
          const stops = items.map(toStop(null)).map(s => ({ ...s, dist: distM(lat, lng, s.lat, s.lng) }));
          stops.sort((a, b) => a.dist - b.dist);
          return json({ stops });
        }

        case "/api/arrivals": {
          const city = p.get("city"), node = p.get("node");
          if (!city || !node) throw new HttpError(400, "city, node가 필요해");
          const items = await tago(env, ctx, "/ArvlInfoInqireService/getSttnAcctoArvlPrearngeInfoList",
            { cityCode: city, nodeId: node, numOfRows: 50 }, TTL.arrivals);
          const arrivals = items.map(it => ({
            route: String(it.routeno ?? ""),          // 노선번호
            routeType: it.routetp ?? "",              // 노선유형 (일반/좌석 등)
            stopsAway: Number(it.arrprevstationcnt),  // 남은 정류장 수
            seconds: Number(it.arrtime),              // 도착까지 남은 초
            vehicleType: it.vehicletp ?? "",          // 차량유형 (저상 등)
          })).sort((a, b) => a.seconds - b.seconds);
          return json({ arrivals, updated: new Date().toISOString() });
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

// ── TAGO 호출 + 캐시 ─────────────────────────────────────────────

async function tago(env, ctx, path, params, ttl) {
  // 캐시 키에는 API 키를 넣지 않음 (키가 어디에도 기록되지 않게)
  const query = new URLSearchParams({ ...params, _type: "json" }).toString();
  const cacheKey = `https://cache.uljin-bus${path}?${query}`;

  // 1) 메모리 캐시
  const hit = memCache.get(cacheKey);
  if (hit && hit.expires > Date.now()) return hit.items;

  // 2) Cloudflare Cache API (커스텀 도메인에서만 실제로 동작)
  const cache = caches.default;
  const cached = await cache.match(cacheKey);
  if (cached) {
    const items = await cached.json();
    memCache.set(cacheKey, { items, expires: Date.now() + ttl * 1000 });
    return items;
  }

  // 3) 진짜 TAGO 호출
  // serviceKey는 data.go.kr의 "Decoding" 키를 등록하고, 여기서 한 번만 인코딩함
  // (Encoding 키를 등록하면 두 번 인코딩돼서 SERVICE_KEY 오류가 나)
  const url = `${BASE}${path}?serviceKey=${encodeURIComponent(env.TAGO_KEY)}&${query}`;
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
    throw new HttpError(502, `TAGO 오류: ${msg}`);
  }

  const header = data?.response?.header;
  if (header && header.resultCode !== "00") {
    throw new HttpError(502, `TAGO 오류: ${header.resultMsg} (${header.resultCode})`);
  }

  const items = normalizeItems(data);

  memCache.set(cacheKey, { items, expires: Date.now() + ttl * 1000 });
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(items), {
    headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${ttl}` },
  })));
  return items;
}

// TAGO는 결과가 0개면 items가 "" , 1개면 객체, 여러 개면 배열로 줌 → 항상 배열로 통일
function normalizeItems(data) {
  const item = data?.response?.body?.items?.item;
  if (!item) return [];
  return Array.isArray(item) ? item : [item];
}

// 도시 이름(예: "울진")으로 도시코드를 찾음. 하루 캐시.
async function getCityCode(env, ctx) {
  const cities = await tago(env, ctx, "/BusSttnInfoInqireService/getCtyCodeList", {}, TTL.city);
  const name = env.CITY_NAME || "울진";
  const found = cities.find(c => String(c.cityname).includes(name));
  if (!found) throw new HttpError(500, `TAGO 도시 목록에 '${name}'이 없어`);
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
