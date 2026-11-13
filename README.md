# 울진 버스

울진군 시내·농어촌버스 실시간 도착정보 사이트.
Cloudflare Worker 하나가 화면(정적 파일)과 API 프록시를 같이 맡아.

```
브라우저 ──▶ Worker ──▶ TAGO API (data.go.kr)
  │           │
  │           └ API 키는 여기에만 있음 (secret)
  │           └ 응답을 잠깐 캐시 (도착정보 20초, 정류장 하루)
  └ public/ 의 index.html, app.js, style.css
```

## 기능

- 정류장 검색 / 내 주변 정류장 — 목록마다 **"→ ○○ 방면"** 표시 (길 건너 같은 이름 정류장 구분)
- 정류장 화면 — 곧 도착할 버스(○○행, 몇 정류장 전, 남은 시간 1초마다 줄어듦), 지나는 노선 전체(첫차·막차·배차)
- 노선 화면 — 세로 노선도, 지금 버스가 있는 정류장, 회차 지점, 내가 있는 정류장 표시
- 도착 알림 — 3분 전에 진동/알림 (화면을 켜둔 동안)
- 즐겨찾기, 최근 본 정류장 (이 브라우저에만 저장)
- 홈 화면에 추가하면 앱처럼 열림, 다크모드 자동
- 주소로 화면 공유: `#s/도시/정류장ID/이름`, `#r/도시/노선ID/정류장ID`

### 방면은 이렇게 계산해

TAGO엔 "방면" 정보가 없어서 Worker가 직접 계산해.
정류장을 지나는 노선마다 경유 정류장 순서를 받아서, 이 정류장 **다음 정류장**과
같은 방향(상행/하행)의 **마지막 정류장(종점)** 을 찾아. 노선들의 다음 정류장 중
가장 많은 게 그 정류장의 대표 방면이야.

## 쓰는 TAGO API (data.go.kr, 키 하나로 공통)

| 번호 | 이름 | 어디에 |
|---|---|---|
| 15098534 | 버스정류소정보 | 검색, 주변, 정류장 경유노선 |
| 15098530 | 버스도착정보 | 곧 도착 |
| 15098529 | 버스노선정보 | 방면 계산, 첫차·막차, 노선도 |
| 15098533 | 버스위치정보 | 노선도의 버스 위치 |

노선정보가 승인 전이면 방면 없이 노선만 나오고, 위치정보가 승인 전이면 노선도에 버스만 안 보여. 나머지는 그대로 동작해.

## 폴더 구조

| 파일 | 하는 일 |
|---|---|
| `wrangler.toml` | 배포 설정 (이름, 정적 파일 폴더, 도시 이름) |
| `src/index.js` | Worker: `/api/...` 요청을 받아 TAGO를 대신 부름 |
| `public/index.html` | 화면 뼈대 |
| `public/app.js` | 화면 3개(처음/정류장/노선), 즐겨찾기, 알림, 자동 새로고침 |
| `public/manifest.webmanifest`, `icon*` | 홈 화면 앱 설정과 아이콘 |
| `public/style.css` | 스타일 (다크모드 자동) |

## 처음 배포하기 (맥 터미널)

1. **API 활용신청 확인** — data.go.kr에서 아래 두 개가 '승인' 상태인지 봐.
   - 국토교통부_(TAGO)_버스도착정보
   - 국토교통부_(TAGO)_버스정류소정보

   키는 같은 걸 써. 마이페이지에서 **일반 인증키 (Decoding)** 을 복사해둬.

2. **Node.js 확인** — `node -v` (없으면 `brew install node`)

3. **폴더로 이동해서 로그인**
   ```sh
   cd uljin-bus
   npx wrangler login        # 브라우저 열리면 Cloudflare 로그인
   ```

4. **API 키 등록** (깃허브에 안 올라가는 비밀값)
   ```sh
   npx wrangler secret put TAGO_KEY
   # 붙여넣고 엔터 (Decoding 키!)
   ```

5. **배포**
   ```sh
   npx wrangler deploy
   ```
   끝나면 `https://uljin-bus.soonjeong.net` 으로 열려.

6. **확인** — 브라우저에서 `/api/city` 를 열어봐. `{"cityCode":"...","cityName":"울진"}` 이 나오면 성공.

## 내 맥에서 먼저 돌려보기

```sh
echo 'TAGO_KEY=여기에키' > .dev.vars   # 로컬 전용 비밀값 파일 (.gitignore에 들어있음)
npx wrangler dev                        # http://localhost:8787
```

## 자주 나는 오류

| 메시지 | 원인 / 해결 |
|---|---|
| `SERVICE_KEY_IS_NOT_REGISTERED_ERROR` | Encoding 키를 넣었거나, 승인 직후(1~2시간 대기). Decoding 키로 다시 `secret put` |
| `LIMITED_NUMBER_OF_SERVICE_REQUESTS_EXCEEDS_ERROR` | 하루 호출 한도 초과. 개발계정은 하루 1,000회 정도라 운영계정 신청을 고려 |
| `TAGO_KEY가 등록 안 됐어` (전엔 됐는데 갑자기) | 키를 Text 변수로 넣으면 배포 때마다 지워져. 대시보드에서 **Secret** 종류로 다시 등록 |
| `TAGO 도시 목록에 '울진'이 없어` | `wrangler.toml` 의 `CITY_NAME` 확인 |
| 도착정보가 늘 비어 있음 | 해당 노선에 BIS 단말기가 없으면 TAGO에도 실시간 정보가 안 들어와 |

## 주소

https://uljin-bus.soonjeong.net — `wrangler.toml` 의 `routes` 에 적혀 있어.
GitHub에 push하면 Cloudflare가 자동으로 다시 배포해 (GitHub Pages는 안 씀).

커스텀 도메인에서는 Cloudflare 엣지 캐시(Cache API)도 실제로 동작해서 호출이 더 줄어.

## 고칠 때 참고

- 새로고침 간격: `public/app.js` 의 `REFRESH_SEC`
- 알림 시점(3분): `public/app.js` 의 `ALERT_SEC`
- 캐시 시간: `src/index.js` 의 `TTL`
- 색 기준(3분/10분): `public/app.js` 의 `formatTime`
- 로그 보기: `npx wrangler tail` (배포된 Worker 실시간 로그)
