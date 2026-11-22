"""Console-free launcher for the optional Windows logon task.

Run with ``pythonw.exe`` so Windows never creates a console window or a
PowerShell host. The bridge's normal uvicorn output is appended to
``logs/bridge.log`` exactly as before.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
LOG_DIR = ROOT / "logs"
LOG_DIR.mkdir(parents=True, exist_ok=True)
os.chdir(ROOT)
sys.path.insert(0, str(ROOT))

_log = open(LOG_DIR / "bridge.log", "a", encoding="utf-8", buffering=1)
sys.stdout = _log
sys.stderr = _log

import uvicorn  # noqa: E402

from app.config import SETTINGS  # noqa: E402


def main() -> None:
    uvicorn.run(
        "app.api:app",
        host=SETTINGS.host,
        port=SETTINGS.port,
        log_level="info",
    )


if __name__ == "__main__":
    main()
