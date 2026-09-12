"""Detecta si la app de escritorio de Claude (Claude.exe, la app oficial de
Anthropic para Windows -- no el navegador) esta en primer plano, para poder
esconder/mostrar el popup del widget en sync con ella.

Se usa el nombre de proceso ("Claude.exe") en vez de buscar por titulo de
ventana, ya que el titulo puede cambiar (nombre de la conversacion activa,
idioma, etc).

El criterio es por monitor, no global: con varios monitores conectados,
si Claude esta en el Monitor 1 y abres/enfocas otra app tambien en el
Monitor 1 (la tapa), el popup se esconde. Pero si esa otra app la abres en
el Monitor 2, Claude sigue intacto en su pantalla -- no hay razon para
esconder el popup solo porque el foco global de Windows cambio de monitor.
"""

from __future__ import annotations

import ctypes
import ctypes.wintypes as wintypes
from typing import Optional

PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
MONITOR_DEFAULTTONEAREST = 2
OWN_EXE_NAME = "claudeusagewidget.exe"

# Procesos de UI del sistema que son SIEMPRE superficies transitorias
# (Inicio, buscador, panel de entrada) -- corren en su propio proceso
# dedicado, nunca son "el escritorio", asi que basta con el nombre.
# explorer.exe NO va aca: ese mismo proceso es dueno tanto del escritorio
# vacio (Progman/WorkerW) como del flyout de iconos ocultos de la bandeja,
# y solo el segundo debe ignorarse -- el escritorio vacio SI debe contar
# como "Claude ya no esta a la vista" (ej. al minimizarla sin abrir nada
# mas). Por eso explorer.exe se filtra aparte, por CLASE de ventana.
SHELL_SURFACE_PROCESS_NAMES = {
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "textinputhost.exe",
}

# Clases de ventana de explorer.exe que son overlays transitorios (bandeja)
# y no el escritorio en si.
SHELL_OVERLAY_CLASS_NAMES = {
    "topLevelWindowForOverflowXamlIsland".lower(),  # bandeja de iconos ocultos, Windows 11
    "notifyiconoverflowwindow",                      # bandeja de iconos ocultos, Windows 10
}


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


def pid_for_hwnd(hwnd: int) -> Optional[int]:
    pid = wintypes.DWORD()
    ctypes.windll.user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value or None


def monitor_for_hwnd(hwnd: int) -> Optional[int]:
    """Handle del monitor (HMONITOR) donde vive esa ventana ahora mismo."""
    try:
        return ctypes.windll.user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) or None
    except Exception:
        return None


def get_foreground_hwnd() -> Optional[int]:
    try:
        hwnd = ctypes.windll.user32.GetForegroundWindow()
    except Exception:
        return None
    return hwnd or None


def _class_name_for(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    ctypes.windll.user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def is_shell_surface(hwnd: int) -> bool:
    """True si esa ventana es UI transitoria del sistema (flyout de la
    bandeja, Inicio, buscador) -- pero NO el escritorio vacio en si
    (Progman/WorkerW), que tambien es de explorer.exe pero SI cuenta como
    'no hay ninguna app real a la vista'."""
    name = (_process_name_for(hwnd) or "").lower()
    if not name:
        return False
    if name in SHELL_SURFACE_PROCESS_NAMES:
        return True
    if name == "explorer.exe":
        return _class_name_for(hwnd).lower() in SHELL_OVERLAY_CLASS_NAMES
    return False
