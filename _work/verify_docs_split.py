# -*- coding: utf-8 -*-
"""
校验 README 拆分后没有丢章节、且链接有效。

背景：拆分是「按行号搬运」，最怕的是某一段既没留在 README、
也没进 docs，静默消失。

## 用法

    python _work/verify_docs_split.py
"""

import os
import re
import sys

WORK = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(WORK, "..")
BACKUP = os.path.join(WORK, "README.full.bak.md")
README = os.path.join(ROOT, "README.md")
DOCS = os.path.join(ROOT, "docs")

fails = []


def chk(name, ok, extra=""):
    print(f"  {'OK ' if ok else 'FAIL'} {name}{('  ' + extra) if extra else ''}")
    if not ok:
        fails.append(name)


def headings(path, level=2):
    """取指定级别的标题文本。"""
    pat = re.compile(r"^" + "#" * level + r" (.+)$")
    out = []
    with open(path, "r", encoding="utf-8") as f:
        in_fence = False
        for line in f:
            if line.startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            m = pat.match(line.rstrip("\n"))
            if m:
                out.append(m.group(1).strip())
    return out


def check_links_only(quiet: bool = True) -> int:
    """检查 README 里的本地链接是否存在；返回退出码。"""
    if not quiet:
        pass
    with open(README, "r", encoding="utf-8") as f:
        text = f.read()

    before = len(fails)
    for link in re.findall(r"\]\(([^)]+)\)", text):
        if link.startswith(("http", "#", "mailto")):
            continue
        target = os.path.normpath(os.path.join(ROOT, link))
        # `../../releases` 这类是 **GitHub 网页相对链接**（指向仓库的
        # Releases 页），解析到仓库之外，本地当然不存在文件，跳过。
        if not os.path.abspath(target).startswith(os.path.abspath(ROOT)):
            print(f"  SKIP {link}  (GitHub 网页链接，非本地文件)")
            continue
        chk(f"链接存在: {link}", os.path.exists(target))

    if not quiet:
        print()
    return 0 if len(fails) == before else 1


def main() -> int:
    if not os.path.exists(BACKUP):
        # 备份是一次性迁移用的临时文件，仓库里不留（原版 README 在
        # git 历史里，用 git show <拆分前的 commit>:README.md 可取回）。
        # 没有备份就跳过「章节是否丢失」的比对，只做链接检查。
        print(f"未找到 {os.path.basename(BACKUP)}，跳过章节比对"
              f"（如需比对：git show <拆分前的 commit>:README.md > _work/README.full.bak.md）\n")
        return check_links_only()

    old = headings(BACKUP)
    print(f"原 README 的 ## 章节: {len(old)} 个\n")

    # 汇总拆分后所有文档（README 用 ## ，docs 也用 ## ）
    doc_files = [README] + [
        os.path.join(DOCS, f) for f in ("DESIGN.md", "TROUBLESHOOTING.md", "BUILD.md")
    ]
    present = {}
    for p in doc_files:
        if os.path.exists(p):
            for h in headings(p):
                present.setdefault(h, []).append(os.path.basename(p))

    print("=== 每个原章节是否仍存在 ===")
    missing = []
    for h in old:
        where = present.get(h)
        if where:
            print(f"  OK   {h}   -> {', '.join(where)}")
        else:
            print(f"  LOST {h}")
            missing.append(h)

    print()
    chk("无章节丢失", not missing,
        f"丢失 {len(missing)} 个: {missing}" if missing else f"{len(old)} 个全部保留")

    # README 内部链接有效性
    print("\n=== 链接有效性 ===")
    check_links_only(quiet=False)

    print("\n=== 汇总 ===")
    if fails:
        print(f"  {len(fails)} 项未通过")
        return 1
    print("  全部通过")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
