# -*- coding: utf-8 -*-
"""
把坐标数据注入 weather.js 的 CN_CITY_COORDS 常量。

## 为什么用注入而不是手写

数据有 3000+ 条（全国区县），手写进源码既不现实也易错。
这里从 `_work/city_coords.json` 读，生成紧凑的 JS 字面量，
替换 weather.js 里 `const CN_CITY_COORDS = {...};` 这一段。

生成的格式刻意**紧凑**（每条一行、键名短），因为这是要打进
exe 的前端代码，体积值得计较：

    '江苏|苏州': {lat:31.30,lon:120.58,p:12740000},

区县多一级：

    '江苏|苏州|昆山': {lat:31.39,lon:120.98,p:2092496},

字段名用 `lat/lon/p`（p = population）而非全称，
3000 条能省下约 60 KB。

## 用法

    python _work/inject_city_coords.py
"""

import json
import os
import re
import sys

WORK = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(WORK, ".."))
WEATHER = os.path.join(ROOT, "desktop-pet", "web", "weather.js")
SRC = os.path.join(WORK, "city_coords.json")


def strip_suffix(s: str) -> str:
    """去掉行政区划后缀。

    高德返回的名字是「昆山市」「苏州市」「江苏省」这类**带后缀**的写法，
    而用户输入的是「昆山」「苏州」「江苏」。

    注入时统一去后缀，这样：
      - 搜索匹配简单（不必在运行时反复比对多种写法）
      - 表体积更小

    注意顺序：先长后短。「内蒙古自治区」要剥「自治区」得「内蒙古」，
    若先剥「自治」会得到「内蒙古区」。
    """
    for k in ("特别行政区", "维吾尔自治区", "壮族自治区", "回族自治区",
              "自治区", "自治州", "自治县", "地区", "盟", "省", "市", "县", "区"):
        if s.endswith(k) and len(s) > len(k):
            return s[: -len(k)]
    return s


def main() -> int:
    if not os.path.exists(SRC):
        print(f"找不到坐标数据: {SRC}\n"
              f"先运行 _work/fetch_amap_coords.py", file=sys.stderr)
        return 1

    with open(SRC, "r", encoding="utf-8") as f:
        raw = json.load(f)

    # 键名去后缀
    #
    # 同时过滤掉**乡镇级**数据：台湾部分的结构与大陆不同，
    # 高德把乡镇也放在 district 层（`罗东镇`、`苏澳镇`），
    # 还混进了岛屿（`钓鱼岛`、`赤尾屿`）。
    #
    # 注意不能简单地按后缀删：**「桐乡」是浙江的县级市**，
    # 却也以「乡」结尾。第一版按后缀过滤时把它误删了。
    # 因此改为「后缀 + 长度」双重判断：
    # 乡镇名通常 2~4 字，而县级市名同样可能很短，所以真正可靠的
    # 判据是**高德给的 level**（已在上游 walk() 里保证），
    # 这里只兜底过滤明显的岛屿/礁石。
    ISLAND_SUFFIX = ("岛", "屿", "礁", "沙洲", "暗沙")
    data = {}
    dropped = 0
    for key, v in raw.items():
        parts = [strip_suffix(p) for p in key.split("|")]
        last = parts[-1]
        if len(parts) == 3 and last.endswith(ISLAND_SUFFIX):
            dropped += 1
            continue
        data["|".join(parts)] = v

    print(f"坐标数据: {len(raw)} 条（去后缀 {len(data)} 条，"
          f"过滤岛屿 {dropped} 条）")

    # 按省份分组输出，便于人工核对
    by_prov = {}
    for key, v in data.items():
        prov = key.split("|")[0]
        by_prov.setdefault(prov, []).append((key, v))

    lines = []
    for prov in sorted(by_prov):
        items = by_prov[prov]
        lines.append(f"  // {prov}（{len(items)}）")
        buf = []
        for key, v in items:
            lat = v.get("lat")
            lon = v.get("lon")
            # 高德的行政区划接口不返回人口，所以通常为 0。
            # 排序时人口只用于「同名前缀匹配」的次要排序，
            # 精确匹配不受影响，因此缺人口不影响正确性。
            pop = v.get("population") or v.get("p") or 0
            buf.append(f"  '{key}': {{lat:{lat},lon:{lon},p:{pop}}},")
        # 每行拼若干个，控制单行长度
        for i in range(0, len(buf), 2):
            lines.append("".join(buf[i:i + 2]))
        lines.append("")

    body = "\n".join(lines).rstrip() + "\n"

    block = (
        "/**\n"
        " * 内置城市坐标表（**离线可查**，不依赖任何网络服务）。\n"
        " *\n"
        " * ## 为什么需要\n"
        " *\n"
        " * 原本搜城市依赖 `geocoding-api.open-meteo.com`，但该服务在\n"
        " * 国内网络下**多数 IP 不可达**（实测 7 个里 5 个超时），\n"
        " * 搜索成功率只有约 65%，每次失败还要等 4 秒。\n"
        " *\n"
        " * 而中国的城市坐标是固定数据，没有理由每次联网查。\n"
        " * 内置之后常用城市**瞬时返回、100% 可用**。\n"
        " *\n"
        " * ## 键的格式\n"
        " *\n"
        " *   '省|市'           地级市，如 '江苏|苏州'\n"
        " *   '省|市|区县'      区县，如 '江苏|苏州|昆山'\n"
        " *\n"
        " * 带上省份是为了消歧义：全国有 4 个「鼓楼区」、4 个「市中区」、\n"
        " * 2 个「朝阳区」，只按名字匹配必然张冠李戴。\n"
        " *\n"
        " * ## 字段\n"
        " *\n"
        " *   lat/lon  经纬度（高德 GCJ-02 坐标系）\n"
        " *   p        人口，用于同名前缀匹配时排序\n"
        " *\n"
        " * ## 数据来源\n"
        " *\n"
        " * 高德地图行政区划 API，生成脚本见 _work/fetch_amap_coords.py。\n"
        " * 本表是**生成物**，不要手工编辑 —— 改数据请改脚本后重跑。\n"
        " */\n"
        "const CN_CITY_COORDS = {\n"
        + body +
        "};\n"
    )

    with open(WEATHER, "r", encoding="utf-8") as f:
        src = f.read()

    # 替换已有块（首次则插在 CN_PROVINCE_BY_CITY 之后）
    pat = re.compile(
        r"/\*\*\n \* 内置城市坐标表[\s\S]*?\nconst CN_CITY_COORDS = \{[\s\S]*?\n\};",
        re.M)
    if pat.search(src):
        src = pat.sub(block.rstrip(), src, count=1)
        print("  已替换现有 CN_CITY_COORDS")
    else:
        anchor = "const CN_PROVINCE_BY_CITY = {"
        idx = src.find(anchor)
        if idx < 0:
            print("  找不到插入锚点 CN_PROVINCE_BY_CITY", file=sys.stderr)
            return 1
        end = src.find("\n};", idx)
        if end < 0:
            print("  找不到该表的结束位置", file=sys.stderr)
            return 1
        end += len("\n};")
        src = src[:end] + "\n\n" + block + src[end:]
        print("  已插入 CN_CITY_COORDS")

    with open(WEATHER, "w", encoding="utf-8") as f:
        f.write(src)

    size = os.path.getsize(WEATHER)
    print(f"  weather.js -> {size/1024:.0f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
