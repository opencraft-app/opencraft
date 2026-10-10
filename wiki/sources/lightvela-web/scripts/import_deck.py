#!/usr/bin/env python3
"""将页面 XML 导入 React 数据。只用 Python 标准库。

正文顺序与补充材料通过 sources/deck/manifest.json 定义；无清单时按文件排序。
运行会覆盖 src/data 的内容、正文、补充材料、主题与 public/manus-routes.json。
"""
from pathlib import Path
import argparse
import json
import shutil
import xml.etree.ElementTree as ET

PROJECT = Path(__file__).resolve().parents[1]


def rich(node):
    result = {"tag": node.tag, "attrs": dict(node.attrib)}
    if node.text and not (not node.text.strip() and '\n' in node.text):
        result["text"] = node.text
    children = []
    for child in node:
        children.append(rich(child))
        if child.tail and not (not child.tail.strip() and '\n' in child.tail):
            children.append({"tag": "plain", "text": child.tail, "attrs": {}})
    if children:
        result["children"] = children
    return result


def resolve_asset(raw, asset_root):
    path = Path(raw)
    if path.exists():
        return path
    alternative = asset_root / path.name
    if alternative.is_file():
        return alternative
    raise FileNotFoundError(f"无法找到图片：{raw}")


def copy_asset(raw, asset_root):
    original = resolve_asset(raw, asset_root)
    target = PROJECT / "public/assets" / original.name
    target.parent.mkdir(parents=True, exist_ok=True)
    if original.resolve() != target.resolve():
        shutil.copy2(original, target)
    return f"/assets/{target.name}"


def convert(source, asset_root):
    theme = {"colors": {}, "fonts": {}, "size": {"width": 1280, "height": 720}}
    for item in ET.parse(source / "design.xml").getroot():
        if item.tag == "color":
            theme["colors"][item.get("name")] = item.get("value")
        elif item.tag == "font":
            theme["fonts"][item.get("name")] = {"family": item.get("family"), "size": float(item.get("size"))}
    manifest_file = source / "manifest.json"
    manifest = json.loads(manifest_file.read_text()) if manifest_file.exists() else {
        "pages": [f.stem for f in sorted(source.glob("s[0-9]*.xml"))], "supplements": []
    }
    page_ids = manifest["pages"]
    supplements_spec = manifest.get("supplements", [])
    all_ids = page_ids + [s["id"] for s in supplements_spec]
    if len(all_ids) != len(set(all_ids)):
        raise ValueError("正文与补充材料 ID 必须唯一")
    contents = {}

    def convert_page(file, page_id, number, footer):
        page = ET.parse(file).getroot()
        elements = []
        title = ""
        section = ""
        for ordinal, item in enumerate(page):
            attrs = dict(item.attrib)
            key = f"{page_id}_{attrs.get('id', f'{item.tag}_{ordinal:02}')}"
            element = {"key": key, "type": item.tag, "attrs": attrs}
            if item.tag in {"text", "table", "chart", "image", "video", "dynamic"}:
                value = rich(item)
                if item.tag == "dynamic":
                    value = {"pageIndex": int(attrs.pop("page-index")), "title": attrs.pop("title")}
                elif item.tag == "video":
                    value = {"src": copy_asset(attrs.pop("src"), asset_root),
                             "poster": copy_asset(attrs.pop("poster"), asset_root),
                             "title": attrs.pop("title", "LightVela 新视觉演示"),
                             "duration": float(attrs.pop("duration", "0"))}
                elif item.tag == "image":
                    value = {"src": copy_asset(attrs.pop("src"), asset_root), "alt": attrs.pop("alt", f"{page_id} 原始图文材料")}
                    if "original-src" in attrs:
                        value["originalSrc"] = copy_asset(attrs.pop("original-src"), asset_root)
                elif item.tag in {"text", "table"}:
                    value["attrs"] = {}
                    if item.tag == "text" and attrs.get("x") == "1180" and attrs.get("y") == "684":
                        value = {"tag": "text", "attrs": {}, "text": footer}
                else:
                    value["attrs"] = {k: attrs.pop(k) for k in ["categories", "color"] if k in attrs}
                contents[key] = value
                element["contentKey"] = key
            if item.tag == "text" and attrs.get("y") == "36":
                section = "".join(item.itertext()).strip()
            if item.tag == "text" and attrs.get("y") in {"77", "316"}:
                title = "".join(item.itertext()).strip()
            if item.tag == "text" and page_id == "s24" and attrs.get("y") == "172":
                title = "".join(item.itertext()).strip()
            elements.append(element)
        return {"id": page_id, "number": number, "title": title, "section": section, "elements": elements}

    layouts = [convert_page(source / f"{page_id}.xml", page_id, i, f"{i:02d} / {len(page_ids)}") for i, page_id in enumerate(page_ids, 1)]
    supplements = []
    for i, spec in enumerate(supplements_spec, 1):
        page = convert_page(source / spec["source"], spec["id"], i, "补充材料")
        page.update({"group": spec["group"], "label": spec["label"]})
        supplements.append(page)
    out = PROJECT / "src/data"
    out.mkdir(parents=True, exist_ok=True)
    for name, data in [("content.json", contents), ("layouts.json", layouts), ("supplements.json", supplements), ("theme.json", theme)]:
        (out / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    routes = [{"path": "/", "title": "LightVela 汇报"}]
    routes += [{"path": f"/#/{p['id']}", "title": p["title"]} for p in layouts]
    routes += [{"path": f"/#/supplements/{p['id']}", "title": p["label"]} for p in supplements]
    routes += [{"path": f"/#/{p['id']}", "title": p["label"]} for p in supplements if p["id"].startswith("s")]
    (PROJECT / "public/manus-routes.json").write_text(json.dumps({"routes": routes}, ensure_ascii=False, indent=2) + "\n")
    print(f"已导入 {len(layouts)} 页正文、{len(supplements)} 组补充材料，{len(contents)} 个独立内容节点")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=PROJECT / "sources/deck")
    parser.add_argument("--asset-root", type=Path, default=PROJECT / "public/assets")
    args = parser.parse_args()
    convert(args.source.resolve(), args.asset_root.resolve())
