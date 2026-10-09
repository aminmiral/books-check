"""Download the Piper voice used by /speak (LJSpeech, public domain).

    python scripts/get_voice.py        # -> data/voices/en_US-ljspeech-medium.onnx

About 63 MB. Without it the web client uses the browser's built-in voice.
"""

import sys
import urllib.request
from pathlib import Path

BASE = "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/ljspeech/medium/"
NAME = "en_US-ljspeech-medium.onnx"
OUT = Path(__file__).resolve().parents[1] / "data" / "voices"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for name in (NAME, NAME + ".json"):
        dest = OUT / name
        if dest.exists():
            print(f"have {dest}")
            continue
        print(f"fetching {name} ...", flush=True)
        tmp = dest.with_suffix(dest.suffix + ".part")
        urllib.request.urlretrieve(BASE + name, tmp)
        tmp.rename(dest)
    print("voice ready")


if __name__ == "__main__":
    sys.exit(main())
