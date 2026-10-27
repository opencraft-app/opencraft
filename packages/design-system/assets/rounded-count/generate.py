"""Build OpenCraft Rounded Count from original centerlines (no source font).

Tooling only: python -m pip install -r requirements.txt; python generate.py
The checked-in WOFF2 is consumed directly; application builds need no Python.
"""
from pathlib import Path
import argparse
import hashlib
import io

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.cu2quPen import Cu2QuPen
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.svgLib.path import parse_path
import pathops

ROOT = Path(__file__).resolve().parent
# Font coordinates: 1000 UPM, 620 advance, 740 optical cap, 116 round stroke.
# Generous counters and a curved 2/3/5 distinguish the face at badge sizes.
STROKES = {
    "zero": "M 310 64 C 155 64 130 205 130 376 C 130 548 155 688 310 688 C 465 688 490 548 490 376 C 490 205 465 64 310 64 Z",
    "one": "M 190 546 Q 270 590 320 684 L 320 68 M 192 68 L 448 68",
    "two": "M 132 550 C 153 650 218 690 312 690 C 424 690 490 631 490 538 C 490 451 429 397 343 322 L 133 129 Q 102 68 159 68 L 494 68",
    "three": "M 145 603 C 192 670 246 690 315 690 C 422 690 484 636 484 552 C 484 461 425 400 311 390 C 426 387 494 331 494 232 C 494 130 422 64 309 64 C 222 64 169 94 127 147",
    "four": "M 411 68 L 411 686 L 116 283 Q 90 244 139 244 L 515 244",
    "five": "M 476 682 L 174 682 L 144 404 C 192 434 244 446 302 446 C 420 446 494 374 494 260 C 494 143 421 64 308 64 C 230 64 171 89 126 143",
    "six": "M 449 630 C 410 674 371 690 318 690 C 194 690 126 574 126 362 L 126 259 C 126 144 196 64 309 64 C 421 64 491 144 491 259 C 491 369 421 442 315 442 C 226 442 162 400 130 328",
    "seven": "M 119 682 L 492 682 L 248 68",
    "eight": "M 310 390 C 206 390 139 446 139 544 C 139 634 206 690 310 690 C 414 690 481 634 481 544 C 481 446 414 390 310 390 C 195 390 124 330 124 231 C 124 128 195 64 310 64 C 425 64 496 128 496 231 C 496 330 425 390 310 390 Z",
    "nine": "M 171 124 C 210 80 249 64 302 64 C 426 64 494 180 494 392 L 494 495 C 494 610 424 690 311 690 C 199 690 129 610 129 495 C 129 385 199 312 305 312 C 394 312 458 354 490 426",
    "plus": "M 130 377 L 490 377 M 310 197 L 310 557",
    "period": "M 120 70 L 120 72",
    "comma": "M 126 74 Q 134 11 92 -38",
}
NAMES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]


def build():
    glyphs = {}
    order = [".notdef", "space", *STROKES]
    for name in order:
        pen = TTGlyphPen(None)
        if name in STROKES:
            path = pathops.Path()
            parse_path(STROKES[name], path.getPen())
            path.stroke(116, pathops.LineCap.ROUND_CAP, pathops.LineJoin.ROUND_JOIN, 4)
            # Remove overlaps at crossings without changing the round terminals.
            path.convertConicsToQuads(0.1)
            path.simplify()
            path.draw(Cu2QuPen(pen, max_err=0.5, reverse_direction=True))
        glyphs[name] = pen.glyph()
    fb = FontBuilder(1000, isTTF=True)
    fb.setupGlyphOrder(order)
    fb.setupCharacterMap({**{48 + i: n for i, n in enumerate(NAMES)}, 32: "space", 43: "plus", 44: "comma", 46: "period"})
    fb.setupGlyf(glyphs)
    fb.setupHorizontalMetrics({name: (240 if name in ["period", "comma", "space"] else 620, getattr(glyphs[name], "xMin", 0)) for name in order})
    fb.setupHorizontalHeader(ascent=875, descent=-125)
    fb.setupNameTable({
        "familyName": "OpenCraft Rounded Count", "styleName": "Bold",
        "uniqueFontIdentifier": "OpenCraftRoundedCount-Bold-1.000",
        "fullName": "OpenCraft Rounded Count Bold", "psName": "OpenCraftRoundedCount-Bold",
        "version": "Version 1.000",
        "copyright": "Copyright 2026 OpenCraft contributors. Licensed under Apache-2.0.",
        "licenseDescription": "Apache License, Version 2.0", "licenseInfoURL": "https://www.apache.org/licenses/LICENSE-2.0",
    })
    fb.setupOS2(version=4, sTypoAscender=875, sTypoDescender=-125, sTypoLineGap=0,
                usWinAscent=875, usWinDescent=125, usWeightClass=700,
                fsSelection=0xA0, sCapHeight=748, sxHeight=748)
    fb.setupPost()
    fb.font["head"].macStyle = 1
    # Fixed timestamp and canonical table order make regeneration byte stable.
    fb.font["head"].created = fb.font["head"].modified = 3864931200
    fb.font.recalcTimestamp = False
    fb.font.flavor = "woff2"
    output = io.BytesIO()
    fb.font.save(output)
    return output.getvalue()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    data = build()
    target = ROOT / "opencraft-rounded-count-bold.woff2"
    if args.check:
        assert target.read_bytes() == data, "WOFF2 is stale; regenerate with the pinned tooling"
    else:
        target.write_bytes(data)
    print(f"{target.name}: {len(data)} bytes, sha256 {hashlib.sha256(data).hexdigest()}")
