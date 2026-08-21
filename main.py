"""Entrypoint: icono de bandeja, popup flotante y loop de refresco."""

from __future__ import annotations

import ctypes
import datetime
import math
import subprocess
import sys
import threading
import traceback
import tkinter as tk
import webbrowser
from dataclasses import dataclass, field
from typing import Optional

import pystray
from PIL import Image, ImageDraw

import api_client
import auth
import claude_app_watcher
import ui
import update_checker
from version import VERSION

POLL_INTERVAL_ACTIVE_SECONDS = 15
POLL_INTERVAL_IDLE_SECONDS = 5 * 60
UPDATE_CHECK_INTERVAL_SECONDS = 6 * 60 * 60
CLAUDE_APP_WATCH_INTERVAL_SECONDS = 1.0
TRAY_ICON_SIZE = 64
CLAUDE_ORANGE = (217, 119, 87, 255)  # #D97757
LOG_PATH = auth.APP_DIR / "error.log"


def log_error(context: str, exc: BaseException) -> None:
    """Deja rastro de fallos que antes desaparecian en silencio (console=False
    no muestra nada). Sin esto, un fallo en una PC ajena (ej. falta WebView2)
    era indiagnosticable a la distancia."""
    try:
        with LOG_PATH.open("a", encoding="utf-8") as f:
            f.write(f"\n[{datetime.datetime.now().isoformat()}] {context}\n")
            f.write("".join(traceback.format_exception(type(exc), exc, exc.__traceback__)))
    except Exception:
        pass


@dataclass
class AppState:
    status: str = "loading"  # loading | ok | auth_error | error
    limits: list = field(default_factory=list)
    error_message: str = ""
    lock: threading.Lock = field(default_factory=threading.Lock)


def build_tray_image() -> Image.Image:
    """Icono de bandeja: la rafaga (sunburst) de Claude en naranja.

    Se dibuja a 8x y se reduce con LANCZOS para tener bordes suaves a tamano
    de bandeja. La rafaga son rayos radiales con puntas redondeadas; el numero
    impar de rayos y el hueco central le dan el aspecto del logo de Claude.
    """
    supersample = 8
    size = TRAY_ICON_SIZE * supersample
    image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)

    center = size / 2
    spokes = 11
    inner_radius = size * 0.10
    outer_radius = size * 0.46
    spoke_width = size * 0.085
    cap = spoke_width / 2

    for i in range(spokes):
        angle = math.pi / 2 + (2 * math.pi * i / spokes)
        x_inner = center + inner_radius * math.cos(angle)
        y_inner = center - inner_radius * math.sin(angle)
        x_outer = center + outer_radius * math.cos(angle)
        y_outer = center - outer_radius * math.sin(angle)
        draw.line(
            (x_inner, y_inner, x_outer, y_outer),
            fill=CLAUDE_ORANGE,
            width=int(spoke_width),
        )
        # Puntas redondeadas (ImageDraw.line no tiene caps): circulo en la punta.
        draw.ellipse(
            (x_outer - cap, y_outer - cap, x_outer + cap, y_outer + cap),
            fill=CLAUDE_ORANGE,
        )

    return image.resize((TRAY_ICON_SIZE, TRAY_ICON_SIZE), Image.LANCZOS)


def refresh_once(state: AppState, on_update) -> None:
    cookiejar = auth.get_claude_cookiejar()
    if cookiejar is None or not auth.has_session_cookie(cookiejar):
        with state.lock:
            state.status = "auth_error"
            state.error_message = "No hay sesion guardada"
        on_update()
        return

    try:
        limits = api_client.fetch_usage(cookiejar)
    except api_client.AuthError as exc:
        with state.lock:
            state.status = "auth_error"
            state.error_message = str(exc)
        on_update()
        return
    except api_client.UsageRequestError as exc:
        with state.lock:
            state.status = "error"
            state.error_message = str(exc)
        on_update()
        return

    with state.lock:
        state.status = "ok"
        state.limits = limits
        state.error_message = ""
    on_update()


def poll_loop(popup: ui.Popup, state: AppState, on_update, stop_event: threading.Event) -> None:
    """Refresca cada POLL_INTERVAL_ACTIVE_SECONDS mientras el popup esta
    abierto, pero baja a POLL_INTERVAL_IDLE_SECONDS mientras esta cerrado
    (que es la mayor parte del tiempo que el widget vive en la bandeja) --
    antes pegaba siempre cada 15s sin importar si alguien estaba mirando.
    Al reabrir el popup, `on_left_click` ya fuerza un refresh inmediato, asi
    que la respuesta al usuario sigue siendo instantanea.
    """
    while not stop_event.is_set():
        refresh_once(state, on_update)
        interval = POLL_INTERVAL_ACTIVE_SECONDS if popup.visible else POLL_INTERVAL_IDLE_SECONDS
        stop_event.wait(interval)


def claude_app_watch_loop(
    root: tk.Tk, popup: ui.Popup, state: AppState, stop_event: threading.Event
) -> None:
    """Esconde/muestra el popup en sync con la app de escritorio de Claude
    (Claude.exe), pero el criterio es por MONITOR, no global: si Claude esta
    en el Monitor 1 y otra app toma el foco tambien en el Monitor 1 (la
    tapa), el popup se esconde. Si esa otra app se enfoca en un Monitor 2
    distinto, Claude sigue intacto en su pantalla y el popup no se toca --
    cambiar de monitor no es lo mismo que taparla. Ignora los momentos en
    que el propio popup del widget tiene el foco, para no auto-esconderse
    al interactuar con el. Solo actua mientras el toggle este encendido.
    """
    own_pid = ctypes.windll.kernel32.GetCurrentProcessId()
    # was_shown es siempre un bool concreto (nunca None): arranca en lo que
    # el popup REALMENTE esta mostrando ahora mismo. Antes arrancaba en None
    # ("no se"), y como el toggle se prende con foco en el propio popup, la
    # primera transicion real (cambiar a otra app) quedaba "tragada": el
    # estado interno pasaba a False pero nunca se llamaba a popup.hide(),
    # dejando el popup visible aunque el codigo ya creyera que estaba oculto.
    was_shown = popup.visible
    hwnd: Optional[int] = None
    claude_pid: Optional[int] = None
    while not stop_event.is_set():
        if popup.sync_with_claude_app:
            # Cachea el hwnd -- re-enumerar TODAS las ventanas de Windows
            # cada segundo (EnumWindows) es innecesario si Claude sigue
            # siendo la misma ventana; solo se re-busca si se cerro.
            if hwnd is None or not ctypes.windll.user32.IsWindow(hwnd):
                hwnd = claude_app_watcher.find_claude_app_hwnd()
                claude_pid = claude_app_watcher.pid_for_hwnd(hwnd) if hwnd else None
                was_shown = popup.visible

            if hwnd is not None:
                front_hwnd = claude_app_watcher.get_foreground_hwnd()
                front_pid = claude_app_watcher.pid_for_hwnd(front_hwnd) if front_hwnd else None

                if front_pid == own_pid:
                    should_show = was_shown  # foco en nuestro propio popup: no decidir nada
                elif front_pid == claude_pid:
                    should_show = True
                else:
                    claude_monitor = claude_app_watcher.monitor_for_hwnd(hwnd)
                    front_monitor = (
                        claude_app_watcher.monitor_for_hwnd(front_hwnd) if front_hwnd else None
                    )
                    if front_monitor == claude_monitor:
                        should_show = False
                    else:
                        should_show = was_shown  # otro monitor: no molesta a Claude

                if should_show != was_shown:
                    if should_show:
                        root.after(0, popup.show, state, ui.get_cursor_pos())
                    else:
                        root.after(0, popup.hide)
                    was_shown = should_show
        else:
            hwnd = None
            claude_pid = None
            was_shown = popup.visible
        stop_event.wait(CLAUDE_APP_WATCH_INTERVAL_SECONDS)


def update_check_loop(tray_icon: pystray.Icon, update_state: dict, stop_event: threading.Event) -> None:
    """Avisa si hay una version mas nueva -- nunca descarga ni instala sola.

    El usuario decide cuando actualizar: clic en el item de menu abre el
    link de descarga en el navegador, igual que la primera instalacion.
    """
    while not stop_event.is_set():
        info = update_checker.check_for_update()
        if info and info["version"] != update_state.get("version"):
            update_state["available"] = True
            update_state["version"] = info["version"]
            update_state["url"] = info["url"]
            try:
                tray_icon.notify(
                    f"Version {info['version']} disponible. "
                    "Clic derecho -> Actualizar disponible.",
                    "Claude Usage Widget",
                )
            except Exception:
                pass
        stop_event.wait(UPDATE_CHECK_INTERVAL_SECONDS)


def tooltip_text(state: AppState) -> str:
    """Texto del tooltip del icono: muestra el % de sesion sin abrir el popup."""
    with state.lock:
        status = state.status
        limits = list(state.limits)

    if status == "auth_error":
        return "Claude Usage - sesion expirada"
    if status == "error":
        return "Claude Usage - error de conexion"

    session = next((b for b in limits if b.kind == "session"), None)
    if session is not None:
        return f"Claude Usage - sesion {session.percent:.0f}%"
    return "Claude Usage"


def _make_dpi_aware() -> None:
    """Declara el proceso DPI-aware antes de crear cualquier ventana.

    Sin esto, en pantallas con escalado >100% (tipico en laptops) Windows
    estira el bitmap de la ventana en vez de dejar que Tk renderice a la
    resolucion real, y el layout del popup se ve desalineado/superpuesto.
    """
    if sys.platform != "win32":
        return
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per-monitor DPI aware
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass


def main() -> None:
    _make_dpi_aware()

    if "--login" in sys.argv:
        import login_flow

        try:
            login_flow.run_login_and_save()
        except Exception as exc:
            log_error("login_flow.run_login_and_save (--login)", exc)
        return

    if not auth.MANUAL_COOKIES_PATH.exists():
        import login_flow

        try:
            login_flow.run_login_and_save()
        except Exception as exc:
            log_error("login_flow.run_login_and_save (primer arranque)", exc)
            # No relanzamos: mejor que el tray icon aparezca en estado
            # "sesion expirada" (reintentable via menu) a que toda la app
            # desaparezca sin dejar rastro, como le paso a un usuario cuyo
            # WebView2 Runtime fallaba. Pero si mostramos el error, mejor
            # que el usuario lo vea en vez de solo quedar en el log.
            try:
                import tkinter.messagebox as messagebox

                messagebox.showwarning("Claude Usage Widget", str(exc))
            except Exception:
                pass

    state = AppState()
    update_state: dict = {"available": False, "version": None, "url": None}
    stop_event = threading.Event()

    root = tk.Tk()
    root.withdraw()

    popup = ui.Popup(root)

    def on_update() -> None:
        root.after(0, popup.refresh, state)
        tray_icon.title = tooltip_text(state)

    def refresh_async() -> None:
        threading.Thread(target=refresh_once, args=(state, on_update), daemon=True).start()

    def on_left_click(icon, item=None) -> None:
        pos = ui.get_cursor_pos()
        opening = not popup.visible
        root.after(0, popup.toggle, state, pos)
        if opening:
            refresh_async()

    def on_refresh_now(icon, item=None) -> None:
        refresh_async()

    def on_login(icon, item=None) -> None:
        def do_login() -> None:
            if getattr(sys, "frozen", False):
                args = [sys.executable, "--login"]
            else:
                args = [sys.executable, __file__, "--login"]
            subprocess.run(args)
            refresh_async()

        threading.Thread(target=do_login, daemon=True).start()

    def on_quit(icon, item=None) -> None:
        stop_event.set()
        icon.stop()
        root.after(0, root.destroy)

    def on_update_click(icon, item=None) -> None:
        if update_state.get("url"):
            webbrowser.open(update_state["url"])

    menu = pystray.Menu(
        pystray.MenuItem("Mostrar/ocultar", on_left_click, default=True, visible=False),
        pystray.MenuItem(
            "Actualizar disponible",
            on_update_click,
            visible=lambda item: update_state["available"],
        ),
        pystray.MenuItem("Iniciar sesion", on_login),
        pystray.MenuItem("Actualizar ahora", on_refresh_now),
        pystray.MenuItem("Salir", on_quit),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(f"v{VERSION}", lambda icon, item: None, enabled=False),
    )
    tray_icon = pystray.Icon("claude-usage-widget", build_tray_image(), "Claude Usage", menu)

    poll_thread = threading.Thread(
        target=poll_loop, args=(popup, state, on_update, stop_event), daemon=True
    )
    poll_thread.start()

    claude_app_watch_thread = threading.Thread(
        target=claude_app_watch_loop, args=(root, popup, state, stop_event), daemon=True
    )
    claude_app_watch_thread.start()

    update_thread = threading.Thread(
        target=update_check_loop, args=(tray_icon, update_state, stop_event), daemon=True
    )
    update_thread.start()

    tray_thread = threading.Thread(target=tray_icon.run, daemon=True)
    tray_thread.start()

    root.mainloop()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        log_error("main() sin capturar", exc)
        try:
            import tkinter.messagebox as messagebox

            messagebox.showerror(
                "Claude Usage Widget",
                "Ocurrio un error inesperado y la app se va a cerrar.\n\n"
                f"Detalles guardados en:\n{LOG_PATH}",
            )
        except Exception:
            pass
