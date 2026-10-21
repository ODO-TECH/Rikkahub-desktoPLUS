"""Build a Windows multi-resolution ICO from the RikkaHub mobile launcher icon.

Source of truth for the desktop icon is the Android launcher artwork in the
upstream RikkaHub repository, so that repo has to be checked out next to this
one (or its res directory passed explicitly):

    python make_icon.py [output.ico] [path/to/app/src/main/res/mipmap-xxxhdpi]
    RIKKAHUB_RES=/path/to/mipmap-xxxhdpi python make_icon.py

icon.ico in this directory is already generated and committed; rerun this only
when the upstream launcher artwork changes.
"""

from PIL import Image
import os
import sys

# 候选位置：上游 Android 仓库常见的本地检出目录名。找不到时报错并提示用参数指定，
# 不再假设某个固定目录（每台机器放代码的位置不一样）。
_CANDIDATES = [
    ("rikkahub-master", "app", "src", "main", "res", "mipmap-xxxhdpi"),
    ("rikkahub", "app", "src", "main", "res", "mipmap-xxxhdpi"),
    ("Rikkahub-Android", "app", "src", "main", "res", "mipmap-xxxhdpi"),
]
_HERE = os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.normpath(os.path.join(_HERE, "..", ".."))


def resolve_mobile_res(argv):
    if len(argv) > 2:
        return os.path.abspath(argv[2])
    env = os.environ.get("RIKKAHUB_RES")
    if env:
        return os.path.abspath(env)
    for parts in _CANDIDATES:
        cand = os.path.join(_ROOT, *parts)
        if os.path.isfile(os.path.join(cand, "ic_launcher.png")):
            return cand
    raise SystemExit(
        "找不到上游 RikkaHub 的 mipmap-xxxhdpi 目录。把 rikkahub 仓库检出到本仓库的同级目录，\n"
        "或直接传路径：python make_icon.py icon.ico /path/to/app/src/main/res/mipmap-xxxhdpi"
    )


SIZES = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256]


def build_master(mobile_res):
    bg = Image.open(os.path.join(mobile_res, "ic_launcher_background.png")).convert("RGBA")
    fg = Image.open(os.path.join(mobile_res, "ic_launcher_foreground.png")).convert("RGBA")
    composed = Image.alpha_composite(bg, fg)

    # The legacy 192px launcher png carries the canonical rounded-square
    # silhouette; reuse its alpha so the desktop icon matches the phone.
    legacy = Image.open(os.path.join(mobile_res, "ic_launcher.png")).convert("RGBA")
    mask = legacy.split()[3].resize(composed.size, Image.LANCZOS)

    rgb = composed.convert("RGB")
    master = Image.new("RGBA", composed.size)
    master.paste(rgb, (0, 0), mask)
    return master


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "icon.ico"
    master = build_master(resolve_mobile_res(sys.argv))
    master.save(out.replace(".ico", "_master.png"))
    master.save(out, format="ICO", sizes=[(s, s) for s in SIZES])
    print(f"wrote {out}: {SIZES}")


if __name__ == "__main__":
    main()
