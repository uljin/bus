"""울진여객 노선도 PDF에서 뽑은 정류장 좌표(stops.json)와
사람이 지도를 보고 적은 연결선 목록(아래 EDGES)을 합쳐서 public/data/map.json 을 만든다.

연결선 종류
  trunk : 지도의 남색 굵은 선 (주요 간선)
  branch: 빨간 선 (마을로 들어가는 지선)
  link  : 하늘색 선
  spur  : "정류장 -> (A, B) 선 위 어딘가"  지선이 다른 선 중간에 붙는 경우
"""
import json, sys

stops = json.load(open(sys.argv[1], encoding="utf8"))
nodes = {}
for s in stops:
    name = s["name"]
    if not name:  # 이름 없는 갈림길 점
        name = "J1" if s["x"] > 1000 else "J2"
    if name == "구산":
        name = "구산(근남)" if s["y"] < 2000 else "구산(기성)"
    kind = {"blue": "hub", "green": "sight", "red": "stop", "junction": "junction"}[s["kind"]]
    if name in ("J1", "J2"):
        kind = "junction"
    nodes[name] = {"x": s["x"], "y": s["y"], "kind": kind}

def chain(kind, *names):
    return [(kind, a, b) for a, b in zip(names, names[1:])]

EDGES = []
# 남색 간선
EDGES += chain("trunk", "호산", "나곡", "부구", "죽변", "울진", "수산", "근남", "J1", "매화", "덕신", "망양", "사동", "기성", "구산(기성)", "월송", "평해", "삼율", "금음")
EDGES += chain("trunk", "수산", "불영사", "금강송", "J2", "덕거리", "옥방", "광희", "분천")
EDGES += chain("trunk", "선구", "온정", "금천", "평해")
EDGES += [("trunk", "선구", "@영양")]  # 지도 왼쪽 밖(영양 방면)으로 나가는 선
# 하늘색
EDGES += chain("link", "상당", "두천1리", "하당")
EDGES += chain("link", "두천1리", "두천2리")
EDGES += chain("link", "갈면", "길곡")
EDGES += chain("link", "J2", "소광1리")
# 빨간 지선
EDGES += chain("branch", "호산", "고포", "나곡", "검성")
EDGES += chain("branch", "부구", "주인", "덕구", "상당", "하당", "소곡", "화성", "죽변")
EDGES += chain("branch", "주인", "소야", "소곡", "사계", "명도", "화성")
EDGES += chain("branch", "하당", "정림", "호월", "명도")
EDGES += chain("branch", "호월", "울진")
EDGES += chain("branch", "비례", "신림", "울진")
EDGES += chain("branch", "근남", "성류굴", "수곡", "말앞", "잘미", "J1")
EDGES += chain("branch", "잘미", "구산(근남)")
EDGES += chain("branch", "근남", "월정리", "산포", "J1")
EDGES += chain("branch", "근남", "망양정", "진복", "동정", "무릉", "덕신")
EDGES += chain("branch", "매화", "갈면")
EDGES += chain("branch", "매화", "신흥1리", "신흥2리", "덕신2리")
EDGES += chain("branch", "삼산2리", "삼산1리", "사동", "사동항")
EDGES += chain("branch", "이평", "다천", "기성")
EDGES += chain("branch", "기성", "봉산", "구산(기성)", "황보", "오곡", "평해")
EDGES += chain("branch", "외선미", "선구", "문골", "부달")
EDGES += chain("branch", "외선미", "문골")
EDGES += chain("branch", "온정", "조금")
EDGES += chain("branch", "금천", "덕인", "덕인3리", "만산", "석골")
EDGES += chain("branch", "척산", "남산")
EDGES += chain("branch", "척산", "거일", "후포", "삼율")
EDGES += chain("branch", "소광2리", "소광1리")

# 지선이 다른 선 중간에 붙는 것: (정류장, 선의 양 끝)
SPURS = [
    ("신화2리", "부구", "죽변"), ("고목1리", "부구", "죽변"), ("고목3리", "부구", "죽변"),
    ("주인3리", "덕구", "주인"), ("사계2리", "하당", "소곡"), ("화성3리", "소곡", "화성"),
    ("화성1리", "화성", "명도"), ("박곡", "죽변", "울진"), ("사계", "정림", "호월"),
    ("고성2리", "호월", "울진"), ("고성1리", "호월", "울진"),
    ("몽천", "J1", "매화"), ("금매", "J1", "매화"), ("산포", "망양정", "진복"),
    ("신흥2리", "매화", "신흥1리"), ("방율", "사동", "기성"), ("금실", "다천", "기성"),
    ("하암", "온정", "금천"), ("두실", "온정", "금천"), ("평밭", "금천", "평해"),
    ("고드네", "금천", "덕인"), ("덕산", "금천", "덕인"),
    ("만산", "삼율", "금음"), ("석골", "삼율", "금음"),
    ("척산", "평해", "월송"), ("학곡1리", "평해", "삼율"),
    ("솔평지", "소광2리", "소광1리"),
]

def foot(p, a, b):
    """점 p에서 선분 ab에 내린 수선의 발"""
    ax, ay, bx, by = a["x"], a["y"], b["x"], b["y"]
    dx, dy = bx - ax, by - ay
    t = max(0.05, min(0.95, ((p["x"] - ax) * dx + (p["y"] - ay) * dy) / (dx * dx + dy * dy)))
    return {"x": round(ax + t * dx), "y": round(ay + t * dy)}

edges = []
for kind, a, b in EDGES:
    if b == "@영양":
        n = nodes[a]
        edges.append({"kind": kind, "from": a, "to": None, "pts": [[n["x"], n["y"]], [n["x"] - 330, n["y"] - 80]], "label": "영양 방면"})
        continue
    for x in (a, b):
        if x not in nodes:
            sys.exit(f"없는 정류장: {x}")
    edges.append({"kind": kind, "from": a, "to": b,
                  "pts": [[nodes[a]["x"], nodes[a]["y"]], [nodes[b]["x"], nodes[b]["y"]]]})
for s, a, b in SPURS:
    f = foot(nodes[s], nodes[a], nodes[b])
    edges.append({"kind": "branch", "from": s, "to": None, "on": [a, b],
                  "pts": [[nodes[s]["x"], nodes[s]["y"]], [f["x"], f["y"]]]})

# 연결 안 된 정류장 확인
linked = {e["from"] for e in edges} | {e["to"] for e in edges if e["to"]}
alone = [n for n in nodes if n not in linked]
print("연결 없는 정류장:", alone, file=sys.stderr)

out = {
    "source": "(주)울진여객 노선도 (울진군청 게시 PDF)",
    "width": 2367, "height": 3289,
    "nodes": [{"name": k, **v} for k, v in nodes.items()],
    "edges": edges,
}
json.dump(out, open(sys.argv[2], "w", encoding="utf8"), ensure_ascii=False, separators=(",", ":"))
print(len(nodes), "정류장,", len(edges), "선", file=sys.stderr)
