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

## 폴더 구조

| 파일 | 하는 일 |
|---|---|
| `wrangler.toml` | 배포 설정 (이름, 정적 파일 폴더, 도시 이름) |
| `src/index.js` | Worker: `/api/...` 요청을 받아 TAGO를 대신 부름 |
| `public/index.html` | 화면 뼈대 |
| `public/app.js` | 검색, 내 주변, 즐겨찾기, 자동 새로고침 |
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
| `TAGO 도시 목록에 '울진'이 없어` | `wrangler.toml` 의 `CITY_NAME` 확인 |
| 도착정보가 늘 비어 있음 | 해당 노선에 BIS 단말기가 없으면 TAGO에도 실시간 정보가 안 들어와 |

## 주소

https://uljin-bus.soonjeong.net — `wrangler.toml` 의 `routes` 에 적혀 있어.
GitHub에 push하면 Cloudflare가 자동으로 다시 배포해 (GitHub Pages는 안 씀).

커스텀 도메인에서는 Cloudflare 엣지 캐시(Cache API)도 실제로 동작해서 호출이 더 줄어.

## 고칠 때 참고

- 새로고침 간격: `public/app.js` 의 `REFRESH_SEC`
- 캐시 시간: `src/index.js` 의 `TTL`
- 색 기준(3분/10분): `public/app.js` 의 `formatTime`
- 로그 보기: `npx wrangler tail` (배포된 Worker 실시간 로그)
