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

import pystray
from PIL import Image, ImageDraw

import api_client
import auth
import ui
import update_checker

POLL_INTERVAL_SECONDS = 15
UPDATE_CHECK_INTERVAL_SECONDS = 6 * 60 * 60
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


def poll_loop(state: AppState, on_update, stop_event: threading.Event) -> None:
    while not stop_event.is_set():
        refresh_once(state, on_update)
        stop_event.wait(POLL_INTERVAL_SECONDS)


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
    )
    tray_icon = pystray.Icon("claude-usage-widget", build_tray_image(), "Claude Usage", menu)

    poll_thread = threading.Thread(
        target=poll_loop, args=(state, on_update, stop_event), daemon=True
    )
    poll_thread.start()

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
