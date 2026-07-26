"""Extraccion de la cookie de sesion de claude.ai.

Via principal: browser_cookie3 leyendo Brave directamente. En Brave/Chrome
recientes (127+) esto falla porque el valor de la cookie esta protegido con
App-Bound Encryption (ABE): la clave AES ya no se puede recuperar solo con
DPAPI de Windows. El unico bypass conocido de ABE implica tecnicas de
process hollowing y syscalls directos para evadir EDR -- son las mismas
tecnicas que usan los infostealers, y no las vamos a implementar aqui aunque
el uso sea legitimo (es el propio riesgo de construir una herramienta
generica de robo de cookies).

Via de respaldo: `cookies.local.json` junto a este archivo, con los valores
'sessionKey' y 'lastActiveOrg' copiados a mano desde DevTools (Network ->
request a /api/organizations/{org}/usage -> Headers -> Cookie). Hay que
repetirlo cuando la sesion expire/rote (401/403 en el cliente HTTP).
"""

import http.cookiejar
import json
import sys
import time
from pathlib import Path
from typing import Optional

import browser_cookie3

DOMAIN = "claude.ai"
RETRIES = 3
RETRY_DELAY_SECONDS = 1
APP_DIR = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
MANUAL_COOKIES_PATH = APP_DIR / "cookies.local.json"


def _cookiejar_from_browser() -> Optional[http.cookiejar.CookieJar]:
    """Intenta leer la cookie de Brave, con reintentos por archivo bloqueado."""
    last_error = None
    for attempt in range(1, RETRIES + 1):
        try:
            cookiejar = browser_cookie3.brave(domain_name=DOMAIN)
            if len(cookiejar) > 0:
                return cookiejar
            last_error = RuntimeError("no cookies found for claude.ai in Brave")
        except Exception as exc:  # noqa: BLE001 - queremos capturar cualquier fallo de lectura
            last_error = exc
            if "admin" in str(exc).lower():
                # Falla permanente (App-Bound Encryption): reintentar no cambia
                # el resultado, y este metodo se llama cada 15s en el poll loop.
                break

        if attempt < RETRIES:
            time.sleep(RETRY_DELAY_SECONDS)

    print(f"[auth] no se pudo leer la cookie de Brave tras {RETRIES} intentos: {last_error}")
    return None


def _cookiejar_from_manual_file() -> Optional[http.cookiejar.CookieJar]:
    """Construye un CookieJar a partir de cookies.local.json (fallback manual)."""
    if not MANUAL_COOKIES_PATH.exists():
        return None

    try:
        values = json.loads(MANUAL_COOKIES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[auth] no se pudo leer {MANUAL_COOKIES_PATH.name}: {exc}")
        return None

    if "sessionKey" not in values or "lastActiveOrg" not in values:
        print(f"[auth] {MANUAL_COOKIES_PATH.name} debe tener 'sessionKey' y 'lastActiveOrg'")
        return None

    jar = http.cookiejar.CookieJar()
    for name, value in values.items():
        jar.set_cookie(
            http.cookiejar.Cookie(
                version=0,
                name=name,
                value=value,
                port=None,
                port_specified=False,
                domain=DOMAIN,
                domain_specified=True,
                domain_initial_dot=False,
                path="/",
                path_specified=True,
                secure=True,
                expires=None,
                discard=True,
                comment=None,
                comment_url=None,
                rest={},
            )
        )
    return jar


def get_claude_cookiejar() -> Optional[http.cookiejar.CookieJar]:
    """Devuelve un CookieJar con sesion de claude.ai, o None si no hay ninguna via.

    Prueba primero la extraccion automatica desde Brave; si falla (ABE,
    archivo bloqueado, etc.) cae al archivo manual `cookies.local.json`.
    """
    cookiejar = _cookiejar_from_browser()
    if cookiejar is not None:
        return cookiejar

    cookiejar = _cookiejar_from_manual_file()
    if cookiejar is not None:
        print("[auth] usando cookies.local.json (fallback manual)")
        return cookiejar

    return None


def has_session_cookie(cookiejar) -> bool:
    if cookiejar is None:
        return False
    return any(c.name == "sessionKey" for c in cookiejar)
