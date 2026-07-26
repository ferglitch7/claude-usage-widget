"""Login embebido: ventana WebView2 con claude.ai para capturar la sesion
sin pedirle al usuario que copie cookies a mano desde DevTools.

Usa pywebview (backend EdgeChromium/WebView2 en Windows). A diferencia de
leer `document.cookie` con JS, `Window.get_cookies()` consulta el cookie
store nativo del navegador embebido, asi que SI puede leer cookies
`httpOnly` como `sessionKey` -- por eso este enfoque funciona donde
document.cookie no serviria.

Corre en un proceso separado (invocado como `--login`) porque pywebview
necesita el hilo principal para su propio loop de eventos, igual que
tkinter para el suyo; mezclarlos en el mismo proceso es fragil.
"""

from __future__ import annotations

import json
import sys
import threading
import time
import winreg
from pathlib import Path
from typing import Optional

import webview

LOGIN_URL = "https://claude.ai/login"
POLL_INTERVAL_SECONDS = 1.0
TIMEOUT_SECONDS = 10 * 60

# GUID publico del cliente "WebView2 Runtime" (documentado por Microsoft) --
# se usa para detectar si esta instalado antes de intentar abrir la ventana.
WEBVIEW2_CLIENT_GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
WEBVIEW2_REGISTRY_PATHS = [
    (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_GUID}"),
    (winreg.HKEY_LOCAL_MACHINE, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_GUID}"),
    (winreg.HKEY_CURRENT_USER, rf"SOFTWARE\Microsoft\EdgeUpdate\Clients\{WEBVIEW2_CLIENT_GUID}"),
]

APP_DIR = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
COOKIES_PATH = APP_DIR / "cookies.local.json"


def _has_webview2_runtime() -> bool:
    for hive, path in WEBVIEW2_REGISTRY_PATHS:
        try:
            with winreg.OpenKey(hive, path):
                return True
        except OSError:
            continue
    return False


def _extract_session(cookies: dict) -> Optional[dict]:
    session_key = cookies.get("sessionKey")
    org_id = cookies.get("lastActiveOrg")
    if not session_key or not org_id:
        return None
    value = session_key.value if hasattr(session_key, "value") else session_key
    org_value = org_id.value if hasattr(org_id, "value") else org_id
    return {"sessionKey": value, "lastActiveOrg": org_value}


def _watch_for_session(window: webview.Window, stop_event: threading.Event) -> None:
    deadline = time.time() + TIMEOUT_SECONDS
    while not stop_event.is_set() and time.time() < deadline:
        try:
            raw_cookies = window.get_cookies()
        except Exception:
            raw_cookies = None

        if raw_cookies:
            cookies = {}
            for morsel in raw_cookies:
                for name, m in morsel.items():
                    cookies[name] = m
            session = _extract_session(cookies)
            if session is not None:
                COOKIES_PATH.write_text(
                    json.dumps(session, indent=2), encoding="utf-8"
                )
                stop_event.set()
                window.destroy()
                return

        time.sleep(POLL_INTERVAL_SECONDS)

    if not stop_event.is_set():
        stop_event.set()
        window.destroy()


def run_login_and_save() -> bool:
    """Abre la ventana de login de claude.ai y guarda cookies.local.json.

    Bloquea hasta que el usuario complete el login (o cierre la ventana, o
    pase el timeout). Devuelve True si se guardo una sesion valida.
    """
    if not _has_webview2_runtime():
        raise RuntimeError(
            "Falta el Microsoft Edge WebView2 Runtime, necesario para el login "
            "embebido. Descargalo desde "
            "https://developer.microsoft.com/microsoft-edge/webview2/ "
            "(seccion 'Evergreen Bootstrapper') e intenta de nuevo."
        )

    stop_event = threading.Event()
    watcher_started = threading.Event()

    def _start_watcher_once() -> None:
        if watcher_started.is_set():
            return
        watcher_started.set()
        threading.Thread(
            target=_watch_for_session, args=(window, stop_event), daemon=True
        ).start()

    window = webview.create_window(
        "Iniciar sesion - Claude.ai", LOGIN_URL, width=480, height=720
    )
    window.events.loaded += _start_watcher_once
    webview.start()
    return COOKIES_PATH.exists() and stop_event.is_set()


if __name__ == "__main__":
    ok = run_login_and_save()
    print("login OK" if ok else "login cancelado o timeout")
