"""울진군 농어촌버스 시간표 PDF(군청 게시) → public/data/timetable.json

PDF의 글자 위치를 읽어서 '기점 > 방면 > (번호, 시각, 경유지)' 로 정리한다.
글자 배치가 복잡해서 완벽하지 않으니, 결과는 사람이 원본과 비교해서 확인할 것.
사용법: python3 parse_timetable.py 시간표.pdf public/data/timetable.json
"""
import json, re, sys
import pdfplumber

TIME = re.compile(r"^\d{1,2}:\d{2}$")
NUM = re.compile(r"^\d{1,3}$")

def lines_of(words, tol=5):
    out = []
    for w in sorted(words, key=lambda w: (round(w["top"]), w["x0"])):
        if out and abs(out[-1]["top"] - w["top"]) <= tol:
            out[-1]["words"].append(w)
        else:
            out.append({"top": w["top"], "words": [w]})
    for l in out:
        l["words"].sort(key=lambda w: w["x0"])
        l["text"] = " ".join(w["text"] for w in l["words"])
    return out

def squash(ws, gap=22):
    """띄엄띄엄 쓴 제목(울 진 기 점)을 붙여서 덩어리로"""
    groups = []
    for w in sorted(ws, key=lambda w: w["x0"]):
        if groups and w["x0"] - groups[-1][-1]["x1"] < gap:
            groups[-1].append(w)
        else:
            groups.append([w])
    return [{"text": "".join(x["text"] for x in g), "x0": g[0]["x0"], "x1": g[-1]["x1"],
             "top": min(x["top"] for x in g), "bottom": max(x["bottom"] for x in g)} for g in groups]

# 맨 위 색깔 띠(기점 이름)가 여러 열에 걸쳐 있어서, 열마다 어느 기점인지 직접 적어둠 (2025.10.1 시간표 기준)
TOP_GROUPS = ["울진기점", "울진기점", "울진기점", "죽변기점", "죽변기점", "부구기점(터미널)", "부구기점(터미널)",
              "후포기점", "평해기점", "평해기점", "평해기점", "기성기점", "매화기점(터미널)", "매화기점(터미널)"]

def is_title(l):
    t = "".join(w["text"] for w in l["words"])
    return ("기점" in t or "시골버스" in t) and not any(TIME.match(w["text"]) for w in l["words"])

def is_note(l):
    t = "".join(w["text"] for w in l["words"])
    return ("운행하지" in t or "않습니다" in t or "운행안함" in t) and not any(TIME.match(w["text"]) for w in l["words"])

def parse(pdf_path):
    pdf = pdfplumber.open(pdf_path)
    pg = pdf.pages[0]
    words = pg.extract_words(x_tolerance=1.5)
    words = [w for w in words if w["top"] > 110 and w["top"] < pg.height - 90]  # 머리·꼬리 제외

    # 1) 열 경계: '번호' 글자의 x 위치들
    xs = sorted({round(w["x0"]) for w in words if w["text"] == "번호"})
    cols = []
    for x in xs:
        if not cols or x - cols[-1] > 30:
            cols.append(x)
    edges = cols + [pg.width]

    # 2) 기점 제목 찾기 (페이지 전체)
    titles = []
    for l in lines_of(words):
        for g in squash(l["words"]):
            t = g["text"]
            if ("기점" in t or "시골버스" in t) and not any(TIME.match(w["text"]) for w in l["words"]) and len(t) < 30:
                titles.append({**g, "text": re.sub(r"\s+", "", t)})

    tables = []
    for ci in range(len(cols)):
        x0, x1 = edges[ci] - 3, edges[ci + 1] - 3
        cw = [w for w in words if x0 <= w["x0"] < x1]
        lines = lines_of(cw)
        group = TOP_GROUPS[ci] if ci < len(TOP_GROUPS) else None
        cur = None
        header_until = -1
        # '번호' 칸은 두 줄 높이라 방면 제목이 '번호'보다 위아래로 걸쳐 있음 → 미리 모아둠
        heads = {}
        for l in lines:
            if l["words"][0]["text"] == "번호":
                heads[id(l)] = [m for m in lines if m is not l and abs(m["top"] - l["top"]) <= 20
                                and not any(TIME.match(w["text"]) for w in m["words"])
                                and not NUM.match(m["words"][0]["text"])
                                and not is_title(m) and not is_note(m)]
        skip = {id(m) for v in heads.values() for m in v}
        for l in lines:
            if id(l) in skip:
                continue
            texts = [w["text"] for w in l["words"]]
            if is_note(l) and tables and tables[-1]["col"] == ci:
                tables[-1]["note"] = " ".join(texts)   # "토,일,공휴일 운행하지 않습니다" 같은 안내
                continue
            # 기점 제목 줄?
            tt = [t for t in titles if abs(t["top"] - l["top"]) < 6 and t["x0"] < x1 and t["x1"] > x0]
            if tt and not any(TIME.match(t) for t in texts):
                group = tt[0]["text"]
                continue
            if texts and texts[0] == "번호":
                parts = sorted([l] + heads[id(l)], key=lambda m: m["top"])
                head = " ".join(w["text"] for m in parts for w in m["words"] if w["text"] != "번호")
                cur = {"group": group, "head": head, "rows": [], "col": ci, "top": l["top"]}
                tables.append(cur)
                header_until = l["top"] + 26
                continue
            if cur is None:
                continue
            has_time = any(TIME.match(t) for t in texts)
            if not has_time and l["top"] <= header_until and not (texts and NUM.match(texts[0])):
                cur["head"] = (cur["head"] + " " + " ".join(texts)).strip()   # 두 줄짜리 제목
                continue
            if not has_time and not cur["rows"]:
                # 시각 없는 줄이 표 맨 위에 오면 제목의 일부로 봄 (예: 울진 ↔ 현내, 공석)
                cur["head"] = (cur["head"] + " " + " ".join(texts)).strip()
                continue
            if has_time:
                nos, times, desc = [], [], []
                for t in texts:
                    if TIME.match(t):
                        times.append(t)
                    elif not times and NUM.match(t):
                        nos.append(t)
                    else:
                        desc.append(t)
                cur["rows"].append({"no": nos, "times": times, "via": " ".join(desc)})
            elif cur["rows"]:
                # 시각 없는 줄 = 앞 줄의 이어지는 글 (또는 위아래로 쓴 두 번째 번호)
                prev = cur["rows"][-1]
                rest = []
                for t in texts:
                    if NUM.match(t) and not rest and len(prev["no"]) < 3:
                        prev["no"].append(t)
                    else:
                        rest.append(t)
                if rest:
                    prev["via"] = (prev["via"] + " " + " ".join(rest)).strip()
    return tables

# PDF에서 글자가 꼬여 나오는 제목은 손으로 고침
HEAD_FIX = {
    "울진 → 연지3, 온양 1": "울진 → 연지3, 온양",
    "( 평해 삼율터미널 → 온정 방면 울진": "삼율터미널 → 평해·온정·울진 방면",
    "( 삼율 평해 ↔ 거일 방면 후포": "평해 ↔ 거일·후포·삼율 방면",
    "평해 ↔ 오곡 · 황보 201": "평해 ↔ 오곡 · 황보",
    "조금 → 평해 201": "조금 → 평해",
    "기성 → 오곡,황보 → 평해 206": "기성 → 오곡,황보 → 평해",
    "덕산·덕인·만산 →평해 204 덕인,만산,금음,삼율,": "덕산·덕인·만산 → 평해",
    "의 료 원 경 유": "의료원 경유",
    "울 진 방 면": "울진 방면",
    "평 해 방 면": "평해 방면",
}

def clean(tables):
    out = []
    for t in tables:
        head = re.sub(r"\s+", " ", t["head"]).strip()
        rows = []
        for r in t["rows"]:
            via = re.sub(r"\s*,\s*", ",", r["via"]).strip(" ,")
            rows.append({"no": r["no"], "dep": r["times"][0], "arr": r["times"][1] if len(r["times"]) > 1 else None, "via": via})
        # "부 구 방 면" 처럼 한 글자씩 띄운 것 붙이기
        head = re.sub(r"((?:[가-힣] ){2,}[가-힣])(?![가-힣])", lambda m: m.group(1).replace(" ", ""), head)
        head = HEAD_FIX.get(head, head)
        item = {"group": t["group"], "dir": head, "rows": rows}
        if t.get("note"):
            item["note"] = t["note"]
        out.append(item)
    return out

if __name__ == "__main__":
    data = clean(parse(sys.argv[1]))
    json.dump({"source": "울진군 농어촌버스 시간표 (2025. 10. 1. 시행, 울진군청 게시 PDF)", "tables": data},
              open(sys.argv[2], "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
    for t in data:
        print(f"[{t['group']}] {t['dir']}  ({len(t['rows'])}건)", file=sys.stderr)
