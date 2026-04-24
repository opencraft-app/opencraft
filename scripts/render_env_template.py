#!/usr/bin/env python3
import argparse
import os
import re
import sys
from pathlib import Path


PATTERN = re.compile(r"\{\{([A-Z0-9_]+)\}\}")


def render_template(text: str) -> str:
    missing = sorted({match.group(1) for match in PATTERN.finditer(text) if match.group(1) not in os.environ})
    if missing:
        raise KeyError(", ".join(missing))
    return PATTERN.sub(lambda match: os.environ[match.group(1)], text)


def main() -> int:
    parser = argparse.ArgumentParser(description="Render {{ENV_VAR}} placeholders from environment variables.")
    parser.add_argument("--input", required=True, help="Template input file")
    parser.add_argument("--output", required=True, help="Rendered output file")
    args = parser.parse_args()

    src = Path(args.input)
    dst = Path(args.output)

    try:
        rendered = render_template(src.read_text())
    except KeyError as exc:
        print(f"ERROR: missing template variables: {exc}", file=sys.stderr)
        return 1

    dst.write_text(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
