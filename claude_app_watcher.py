"""Detecta si la app de escritorio de Claude (Claude.exe, la app oficial de
Anthropic para Windows -- no el navegador) esta minimizada, para poder
esconder/mostrar el popup del widget en sync con ella.

Se usa el nombre de proceso ("Claude.exe") en vez de buscar por titulo de
ventana, ya que el titulo puede cambiar (nombre de la conversacion activa,
idioma, etc). Deliberadamente NO reacciona a que otras apps (Telegram,
el navegador, etc) tomen el foco -- solo le importa el estado de
minimizado/restaurado de esa ventana especifica.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
from typing import Optional

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
OWN_EXE_NAME = "claudeusagewidget.exe"


def _process_name_for(hwnd: int) -> Optional[str]:
    pid = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    if not pid.value:
        return None

    handle = ctypes.windll.kernel32.OpenProcess(
        PROCESS_QUERY_LIMITED_INFORMATION, False, pid.value
    )
    if not handle:
        return None
    try:
        buf = ctypes.create_unicode_buffer(260)
        size = wintypes.DWORD(260)
        ok = ctypes.windll.kernel32.QueryFullProcessImageNameW(
            handle, 0, buf, ctypes.byref(size)
        )
        if not ok:
            return None
        return buf.value.rsplit("\\", 1)[-1]
    finally:
        ctypes.windll.kernel32.CloseHandle(handle)


def find_claude_app_hwnd() -> Optional[int]:
    """Devuelve el hwnd top-level de Claude.exe, o None si no esta corriendo."""
    found: list[int] = []
    own_pid = ctypes.windll.kernel32.GetCurrentProcessId()

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def _callback(hwnd: int, _lparam: int) -> bool:
        if not ctypes.windll.user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value == own_pid:
            return True
        name = _process_name_for(hwnd)
        if name and name.lower() == "claude.exe" and name.lower() != OWN_EXE_NAME:
            found.append(hwnd)
            return False
        return True

    try:
        ctypes.windll.user32.EnumWindows(WNDENUMPROC(_callback), 0)
    except Exception:
        return None
    return found[0] if found else None


def is_minimized(hwnd: int) -> bool:
    try:
        return bool(ctypes.windll.user32.IsIconic(hwnd))
    except Exception:
        return False
