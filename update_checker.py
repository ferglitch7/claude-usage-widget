"""Chequeo de actualizaciones contra GitHub Releases.

No descarga ni instala nada por si solo: si hay una version mas nueva,
devuelve los datos para que `main.py` decida como avisar (notificacion de
bandeja + item de menu que abre el link de descarga en el navegador -- el
usuario corre el instalador el mismo, igual que la primera vez). Nunca debe
tumbar la app si falla (sin internet, repo/release inexistente todavia,
rate limit de la API, etc): cualquier error se traduce en "no hay
actualizacion" en silencio.
"""

from __future__ import annotations

import re
from typing import Optional

import requests

from version import VERSION

GITHUB_REPO = "ferglitch7/claude-usage-widget"
RELEASES_API_URL = f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest"
REQUEST_TIMEOUT_SECONDS = 5


def _parse_version(text: str) -> tuple[int, int, int]:
    """'v1.2.3' o '1.2.3' -> (1, 2, 3). Cualquier formato raro -> (0, 0, 0)."""
    match = re.search(r"(\d+)\.(\d+)\.(\d+)", text)
    if not match:
        return (0, 0, 0)
    a, b, c = match.groups()
    return (int(a), int(b), int(c))


def check_for_update() -> Optional[dict]:
    """Devuelve {"version": "1.2.3", "url": "..."} si hay una version mas
    nueva publicada en GitHub Releases que la instalada, o None si no hay
    actualizacion (o si el chequeo fallo por cualquier motivo)."""
    try:
        response = requests.get(
            RELEASES_API_URL,
            headers={"accept": "application/vnd.github+json"},
            timeout=REQUEST_TIMEOUT_SECONDS,
        )
        if response.status_code != 200:
            return None

        data = response.json()
        remote_version = _parse_version(data.get("tag_name", ""))
        if remote_version <= _parse_version(VERSION):
            return None

        assets = data.get("assets", [])
        download_url = next(
            (a["browser_download_url"] for a in assets if a.get("name", "").endswith(".exe")),
            data.get("html_url"),
        )
        return {
            "version": ".".join(str(part) for part in remote_version),
            "url": download_url,
        }
    except Exception:
        return None
