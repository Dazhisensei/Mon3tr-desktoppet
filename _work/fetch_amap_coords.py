# -*- coding: utf-8 -*-
"""
用高德地图 API 生成完整的中国行政区划坐标表。

## 为什么换数据源

先用 GeoNames（Open-Meteo 的底库）试过，覆盖不够：

    GeoNames 中国记录里带中文名的: 2546 条（人口>2万仅 1435 条）
    全国区县: 2978 个
    -> 区县级只能覆盖约 49%

而 GeoNames 的主名多为拼音、且混杂大量同名村庄（「肥城」只找到两个
人口为 0 的 Feichengcun，取到的坐标偏到河北）。这条路的上限就在那里。

高德的行政区划数据完整且权威，**区县级 100% 覆盖**。

## 需要 Key

高德 Web 服务 API Key（免费申请，见 README 中的步骤）。
通过环境变量传入，不写进代码：

    set AMAP_KEY=你的KEY
    python _work/fetch_amap_coords.py

## 接口

    行政区划查询:  https://restapi.amap.com/v3/config/district
      - keywords: 行政区名或 adcode
      - subdistrict: 层级（3 = 到区县）
      - extensions: base（返回中心点 center = "经度,纬度"）

    一次请求可拿到某省下辖的全部市与区县及其中心点，
    31 个省只需 31 次请求，很快。

## 输出

    _work/city_coords.json
      { "省|市": {lat, lon, prov, city, code}, ... }
      { "省|市|区县": {...}, ... }
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request

WORK = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(WORK, ".."))
OUT = os.path.join(WORK, "city_coords.json")

PROXY = os.environ.get("UPSTREAM_PROXY", "")     # 高德在国内，通常不需要代理
KEY = os.environ.get("AMAP_KEY", "")

API = "https://restapi.amap.com/v3/config/district"

_opener = urllib.request.build_opener(
    urllib.request.ProxyHandler(
        {"http": PROXY, "https": PROXY} if PROXY else {})
)


def api_get(params: dict) -> dict:
    params = dict(params, key=KEY, output="JSON")
    url = API + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "coord-fetch/1.0"})
    with _opener.open(req, timeout=30) as r:
        return json.loads(r.read())


def walk(node: dict, prov: str, city: str, out: dict, depth: int = 0) -> None:
    """递归收集行政区划及其中心点。

    ## 只取到区县级

    高德的 `subdistrict` 是**递归深度**：传 3 会一直拉到乡镇街道
    （实测拉到 43281 条，其中 42891 条是「七宝镇」「万里街道」这种）。

    需求是精确到**区县**，再往下没有意义（用户不会用乡镇名查天气），
    而且会让内置表膨胀到 6 MB。

    因此这里按 `level` 判断，**遇到 district 就停止递归**。

    ## 直辖市的特殊结构

    北京/上海/天津/重庆在高德里是：

        北京市(province)
        └─ 北京城区(city)        <- 虚拟的中间层
           └─ 东城区(district)
           └─ 朝阳区(district)

    「北京城区」不是真实行政区，但它占了 city 这一层，
    导致区县被记成「北京|北京城区|东城区」——既啰嗦又不利于搜索。

    处理：**跳过名字以「城区」结尾的虚拟市**，让它的子级直接继承
    省份作为上级。
    """
    name = node.get("name") or ""
    level = node.get("level") or ""
    center = node.get("center") or ""
    adcode = node.get("adcode") or ""

    lat = lon = None
    if "," in center:
        try:
            lon_s, lat_s = center.split(",")
            lon, lat = float(lon_s), float(lat_s)
        except ValueError:
            pass

    # 「北京城区」这类虚拟层不作为城市名
    is_virtual_city = level == "city" and name.endswith("城区")

    cur_prov, cur_city = prov, city
    if level == "province":
        cur_prov = name
    elif level == "city" and not is_virtual_city:
        cur_city = name

    if lat is not None and name and not is_virtual_city:
        if level == "city":
            out[f"{cur_prov}|{name}"] = {
                "lat": round(lat, 5), "lon": round(lon, 5),
                "prov": cur_prov, "city": name, "code": adcode,
            }
        elif level == "district":
            # 直辖市没有真实 city，上级写省份名（搜「北京 东城区」也通）
            parent_city = cur_city or cur_prov
            out[f"{cur_prov}|{parent_city}|{name}"] = {
                "lat": round(lat, 5), "lon": round(lon, 5),
                "prov": cur_prov, "city": parent_city, "code": adcode,
            }

    # 到区县为止，不再往下（乡镇街道不需要）
    if level == "district":
        return

    for sub in node.get("districts") or []:
        walk(sub, cur_prov, cur_city, out, depth + 1)


def main() -> int:
    if not KEY:
        print("缺少 AMAP_KEY 环境变量。\n"
              "申请步骤见本文件头部说明或 README。", file=sys.stderr)
        return 1

    # 1) 取全国省级列表
    print("=== 1/3 拉取省级列表 ===")
    top = api_get({"keywords": "中国", "subdistrict": "1", "extensions": "base"})
    if top.get("status") != "1":
        print(f"  失败: {top.get('info')} ({top.get('infocode')})", file=sys.stderr)
        return 1
    provs = (top.get("districts") or [{}])[0].get("districts") or []
    print(f"  {len(provs)} 个省级行政区")

    # 2) 逐个省拉取到区县
    print("\n=== 2/3 逐省拉取（到区县）===")
    out = {}
    for i, p in enumerate(provs, 1):
        name = p.get("name") or ""
        adcode = p.get("adcode") or ""
        # 港澳台的处理方式不同，先跳过（高德数据可能不完整）
        # 高德的 subdistrict 是递归深度。省份下依次是 市 -> 区县 -> 乡镇。
        #
        # 传 3 是必要的：直辖市多一层虚拟的「XX城区」
        # （北京 -> 北京城区 -> 东城区），传 2 拿不到区县。
        # walk() 会在遇到 district 时停止递归，所以不会真的收下乡级数据。
        try:
            r = api_get({"keywords": adcode, "subdistrict": "3",
                         "extensions": "base"})
            if r.get("status") == "1":
                for d in r.get("districts") or []:
                    walk(d, name, "", out)
                print(f"  [{i}/{len(provs)}] {name}: 累计 {len(out)} 条")
            else:
                print(f"  [{i}/{len(provs)}] {name}: 失败 {r.get('info')}")
        except Exception as e:
            print(f"  [{i}/{len(provs)}] {name}: 异常 {e}")
        time.sleep(0.15)        # 限速：个人 Key 约 3 次/秒

    # 3) 保存
    print("\n=== 3/3 保存 ===")

    # ---- 给直辖市补一条「市」级条目 ----
    #
    # 高德对直辖市的返回结构是「北京市(province) -> 北京城区(city)
    # -> 东城区(district)」，中间的「北京城区」是虚拟层、被跳过了，
    # 于是表里只有「北京市|北京市|东城区」这类区县，
    # **没有「北京」本身** —— 用户搜「北京」会查不到。
    #
    # 中心点用**高德给的省中心**，而不是各区均值：
    # 均值和会被远郊区拉偏（实测北京偏 0.48 度 ≈ 50 公里，
    # 因为密云、延庆离市中心很远），而高德的省中心是官方值。
    for muni in ("北京市", "上海市", "天津市", "重庆市"):
        kids = [(k, v) for k, v in out.items() if k.startswith(muni + "|")]
        if not kids or f"{muni}|{muni}" in out:
            continue

        lat = lon = None
        try:
            r = api_get({"keywords": muni, "subdistrict": "0",
                         "extensions": "base"})
            if r.get("status") == "1" and r.get("districts"):
                center = r["districts"][0].get("center") or ""
                if "," in center:
                    lon_s, lat_s = center.split(",")
                    lat, lon = float(lat_s), float(lon_s)
        except Exception:
            pass

        if lat is None:
            # 兜底：用区县均值（不如省中心准，但总比没有好）
            lat = sum(v["lat"] for _, v in kids) / len(kids)
            lon = sum(v["lon"] for _, v in kids) / len(kids)

        out[f"{muni}|{muni}"] = {
            "lat": round(lat, 5), "lon": round(lon, 5),
            "prov": muni, "city": muni,
            "code": kids[0][1]["code"][:2] + "0000",
        }
        print(f"  补直辖市条目: {muni}|{muni}  ({lat:.3f},{lon:.3f})")

    cities = sum(1 for k in out if k.count("|") == 1)
    districts = sum(1 for k in out if k.count("|") == 2)
    print(f"  市 {cities} 个，区县 {districts} 个，合计 {len(out)}")

    if not out:
        print("  未取得任何数据，可能 Key 无效或额度用尽", file=sys.stderr)
        return 1

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=0, sort_keys=True)
    print(f"  写入 {OUT}  ({os.path.getsize(OUT)/1024:.0f} KB)")

    # 抽查
    print("\n=== 抽查 ===")
    KNOWN = {
        "北京": (39.90, 116.40), "上海": (31.23, 121.47),
        "昆山": (31.39, 120.98), "义乌": (29.31, 120.08),
        "江阴": (31.92, 120.28), "常熟": (31.65, 120.75),
        "温岭": (28.37, 121.37), "肥城": (36.18, 116.77),
        "慈溪": (30.17, 121.25), "晋江": (24.78, 118.55),
        "招远": (37.36, 120.40), "龙口": (37.65, 120.48),
    }

    def strip_suffix(s: str) -> str:
        """高德的名字带「市/区/县」后缀，抽查时按去掉后缀比较。"""
        for k in ("自治州", "自治县", "地区", "盟", "市", "县", "区"):
            if s.endswith(k) and len(s) > len(k):
                return s[: -len(k)]
        return s

    ok = 0
    for want, (elat, elon) in KNOWN.items():
        hit = None
        # 优先匹配**市级**条目（键只有 2 段），因为抽查用的是市名。
        # 若先匹配到区县（如「北京市|北京市|密云区」），坐标会偏到远郊。
        for pass_no in (1, 2):
            for k, v in out.items():
                parts = k.split("|")
                if pass_no == 1 and len(parts) != 2:
                    continue
                last = strip_suffix(parts[-1])
                names = {last, strip_suffix(parts[0])}
                if want in names:
                    hit = v
                    hit_key = k
                    break
            if hit:
                break
        if not hit:
            print(f"  {want:5s} 未收录")
            continue
        d = ((hit["lat"] - elat) ** 2 + (hit["lon"] - elon) ** 2) ** 0.5
        good = d < 0.3
        ok += good
        print(f"  {want:5s} {'OK ' if good else '偏差'} "
              f"得到({hit['lat']:.3f},{hit['lon']:.3f}) "
              f"期望({elat},{elon}) 距离{d:.3f}度")
    print(f"\n  抽查通过 {ok}/{len(KNOWN)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
