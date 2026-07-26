"""Popup flotante estilo flyout de Windows 11 (tkinter, sin bordes)."""

from __future__ import annotations

import ctypes
import tkinter as tk
from datetime import datetime, timezone
from typing import Optional

BG_COLOR = "#202020"
BAR_BG_COLOR = "#3A3A3A"
BAR_FG_COLOR = "#4A9EFF"
TEXT_COLOR = "#FFFFFF"
SUBTEXT_COLOR = "#B0B0B0"
ERROR_COLOR = "#FF6B6B"
FONT_FAMILY = "Segoe UI"

POPUP_WIDTH = 300
WARNING_THRESHOLD = 80
MIN_SCALE = 0.75
MAX_SCALE = 1.6

IDLE_ALPHA = 1.0

DWMWA_WINDOW_CORNER_PREFERENCE = 33
DWMWCP_ROUND = 2


class _POINT(ctypes.Structure):
    _fields_ = [("x", ctypes.c_long), ("y", ctypes.c_long)]


class _RECT(ctypes.Structure):
    _fields_ = [
        ("left", ctypes.c_long),
        ("top", ctypes.c_long),
        ("right", ctypes.c_long),
        ("bottom", ctypes.c_long),
    ]


class _MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", ctypes.c_ulong),
        ("rcMonitor", _RECT),
        ("rcWork", _RECT),
        ("dwFlags", ctypes.c_ulong),
    ]


MONITOR_DEFAULTTONEAREST = 2
MDT_EFFECTIVE_DPI = 0
DEFAULT_DPI = 96


def get_cursor_pos() -> tuple[int, int]:
    point = _POINT()
    ctypes.windll.user32.GetCursorPos(ctypes.byref(point))
    return point.x, point.y


def get_work_area_for(x: int, y: int) -> tuple[int, int, int, int]:
    """Area de trabajo (sin taskbar) del monitor que contiene (x, y).

    tkinter's winfo_screenwidth/height solo conocen el monitor primario, asi
    que en setups multi-monitor el clamp de posicion usaba limites del
    monitor equivocado y el popup se recortaba. Se consulta el monitor real
    via win32 (MonitorFromPoint + GetMonitorInfo).
    """
    point = _POINT(x, y)
    monitor = ctypes.windll.user32.MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST)
    info = _MONITORINFO()
    info.cbSize = ctypes.sizeof(_MONITORINFO)
    ctypes.windll.user32.GetMonitorInfoW(monitor, ctypes.byref(info))
    rc = info.rcWork
    return rc.left, rc.top, rc.right, rc.bottom


def get_dpi_for(x: int, y: int) -> int:
    """DPI real del monitor que contiene (x, y). 96 = 100% de escalado."""
    point = _POINT(x, y)
    monitor = ctypes.windll.user32.MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST)
    dpi_x = ctypes.c_uint()
    dpi_y = ctypes.c_uint()
    try:
        ctypes.windll.shcore.GetDpiForMonitor(
            monitor, MDT_EFFECTIVE_DPI, ctypes.byref(dpi_x), ctypes.byref(dpi_y)
        )
        return dpi_x.value or DEFAULT_DPI
    except Exception:
        return DEFAULT_DPI


def _round_corners(window: tk.Toplevel) -> None:
    """Fuerza esquinas redondeadas via DWM (Windows 11).

    Ventanas overrideredirect a veces quedan fuera del auto-rounding de DWM,
    asi que lo pedimos explicitamente; si falla (versiones viejas de Windows,
    o falta dwmapi) simplemente no hacemos nada.
    """
    try:
        hwnd = ctypes.windll.user32.GetParent(window.winfo_id())
        value = ctypes.c_int(DWMWCP_ROUND)
        ctypes.windll.dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_WINDOW_CORNER_PREFERENCE, ctypes.byref(value), ctypes.sizeof(value)
        )
    except Exception:
        pass


def _format_resets(kind: str, resets_at: Optional[datetime]) -> str:
    if resets_at is None:
        return ""
    now = datetime.now(timezone.utc)
    if kind == "session":
        delta = resets_at - now
        total_minutes = max(int(delta.total_seconds() // 60), 0)
        hours, minutes = divmod(total_minutes, 60)
        return f"Resets in {hours}h {minutes}m"
    local = resets_at.astimezone()
    return f"Resets {local.strftime('%a')} {local.strftime('%I:%M %p').lstrip('0')}"


class Popup:
    def __init__(self, root: tk.Tk):
        self._window = tk.Toplevel(root)
        self._window.withdraw()
        self._window.overrideredirect(True)
        self._window.attributes("-topmost", True)
        self._window.attributes("-toolwindow", True)
        self._window.configure(bg=BG_COLOR)

        self._has_moved = False
        self._dragging = False
        self._drag_start = (0, 0)
        self._window_start = (0, 0)
        self._scale = 1.0
        self._dpi_scale = 1.0
        self._resizing = False
        self._resize_start_x = 0
        self._resize_start_scale = 1.0
        self._resize_anchor_pos = (0, 0)
        self._resize_refresh_job: Optional[str] = None
        self._last_state = None
        self._idle_alpha = IDLE_ALPHA
        self._window.attributes("-alpha", self._idle_alpha)

        self._titlebar = tk.Frame(self._window, bg=BG_COLOR, height=24)
        self._titlebar.pack(fill="x", side="top")
        self._titlebar.pack_propagate(False)

        self._close_btn = tk.Label(
            self._titlebar, text="✕", bg=BG_COLOR, fg=SUBTEXT_COLOR,
            font=(FONT_FAMILY, 10), cursor="hand2",
        )
        self._close_btn.pack(side="right", padx=(0, 8), pady=2)
        self._close_btn.bind("<Enter>", lambda _e: self._close_btn.configure(fg=TEXT_COLOR))
        self._close_btn.bind("<Leave>", lambda _e: self._close_btn.configure(fg=SUBTEXT_COLOR))
        self._close_btn.bind("<Button-1>", lambda _e: self.hide())

        self._opacity_scale = tk.Scale(
            self._titlebar,
            from_=20,
            to=100,
            orient="horizontal",
            length=70,
            width=6,
            sliderlength=10,
            showvalue=False,
            bg=BG_COLOR,
            troughcolor=BAR_BG_COLOR,
            activebackground=BAR_FG_COLOR,
            highlightthickness=0,
            bd=0,
            cursor="hand2",
            command=self._on_opacity_change,
        )
        self._opacity_scale.set(int(self._idle_alpha * 100))
        self._opacity_scale.pack(side="left", padx=(8, 0), pady=2)

        self._drag_exempt = {self._close_btn, self._opacity_scale}
        self._window.bind("<ButtonPress-1>", self._start_drag)
        self._window.bind("<B1-Motion>", self._on_drag)

        self._container = tk.Frame(self._window, bg=BG_COLOR, padx=16, pady=16)
        self._container.pack(fill="both", expand=True)

        self._status_label = tk.Label(
            self._container,
            text="",
            bg=BG_COLOR,
            fg=SUBTEXT_COLOR,
            font=(FONT_FAMILY, 11),
            justify="left",
            anchor="w",
            wraplength=POPUP_WIDTH - 32,
        )

        self._resize_grip = tk.Label(
            self._window, text="◢", bg=BG_COLOR, fg=SUBTEXT_COLOR,
            font=(FONT_FAMILY, 8), cursor="size_nw_se",
        )
        self._resize_grip.place(relx=1.0, rely=1.0, anchor="se", width=14, height=14)
        self._resize_grip.bind("<ButtonPress-1>", self._start_resize)
        self._resize_grip.bind("<B1-Motion>", self._on_resize)
        self._resize_grip.bind("<ButtonRelease-1>", lambda _e: setattr(self, "_resizing", False))
        self._drag_exempt.add(self._resize_grip)

        self._rows: list[tk.Frame] = []
        self._visible = False
        self._anchor_cursor: Optional[tuple[int, int]] = None

        _round_corners(self._window)

    def _sp(self, px: float) -> int:
        """Escala una dimension en pixeles crudos (padding, alto de barra,
        ancho minimo de ventana) segun el DPI real del monitor + el zoom
        manual del usuario. Los tamanos de FUENTE no usan este helper --
        usan `_fp` -- porque Tk ya los reescala solo a su tamano fisico
        correcto una vez que el proceso es DPI-aware (ver `main.py`); aplicar
        el factor de DPI tambien ahi los infla dos veces.
        """
        return max(1, round(px * self._scale * self._dpi_scale))

    def _fp(self, pt: float) -> int:
        """Tamano de fuente en puntos: solo el zoom manual del usuario."""
        return max(1, round(pt * self._scale))

    def _on_opacity_change(self, value: str) -> None:
        self._idle_alpha = int(float(value)) / 100.0
        self._window.attributes("-alpha", self._idle_alpha)

    def _start_resize(self, event: tk.Event) -> None:
        self._resizing = True
        self._resize_start_x = event.x_root
        self._resize_start_scale = self._scale
        self._resize_anchor_pos = (self._window.winfo_x(), self._window.winfo_y())

    def _on_resize(self, event: tk.Event) -> None:
        if not self._resizing:
            return
        dx = event.x_root - self._resize_start_x
        new_scale = self._resize_start_scale + dx / 220.0
        new_scale = max(MIN_SCALE, min(MAX_SCALE, new_scale))
        if abs(new_scale - self._scale) > 0.01:
            self._scale = new_scale
            self._schedule_resize_refresh()

    def _schedule_resize_refresh(self) -> None:
        # refresh() destruye y recrea todos los widgets del popup (fuentes,
        # barras, etc). Llamarlo en cada evento de <B1-Motion> (decenas por
        # segundo) se siente entrecortado, sobre todo en equipos mas lentos.
        # Se agrupan los cambios y se aplica como maximo uno cada ~30ms.
        if self._resize_refresh_job is not None:
            return
        self._resize_refresh_job = self._window.after(30, self._apply_resize_refresh)

    def _apply_resize_refresh(self) -> None:
        self._resize_refresh_job = None
        if self._last_state is not None:
            self.refresh(self._last_state)
        # Mantiene fija la esquina superior izquierda mientras se arrastra el
        # grip; sin esto, refresh() recentra la ventana en el cursor donde se
        # abrio originalmente y "salta" en cada frame.
        x, y = self._resize_anchor_pos
        self._window.geometry(f"+{x}+{y}")

    def _start_drag(self, event: tk.Event) -> None:
        if event.widget in self._drag_exempt:
            self._dragging = False
            return
        self._dragging = True
        self._drag_start = (event.x_root, event.y_root)
        self._window_start = (self._window.winfo_x(), self._window.winfo_y())

    def _on_drag(self, event: tk.Event) -> None:
        if not self._dragging:
            return
        dx = event.x_root - self._drag_start[0]
        dy = event.y_root - self._drag_start[1]
        x = self._window_start[0] + dx
        y = self._window_start[1] + dy
        self._window.geometry(f"+{x}+{y}")
        self._has_moved = True

    def _clear_rows(self) -> None:
        for frame in self._rows:
            frame.destroy()
        self._rows = []
        self._status_label.pack_forget()

    def refresh(self, state) -> None:
        self._last_state = state
        with state.lock:
            status = state.status
            limits = list(state.limits)
            error_message = state.error_message

        self._container.configure(padx=self._sp(16), pady=self._sp(16))
        self._status_label.configure(
            font=(FONT_FAMILY, self._fp(11)),
            wraplength=self._sp(POPUP_WIDTH) - self._sp(32),
        )

        self._titlebar.configure(height=self._sp(24))
        self._close_btn.configure(font=(FONT_FAMILY, self._fp(10)))
        self._opacity_scale.configure(
            length=self._sp(70), width=self._sp(6), sliderlength=self._sp(10)
        )
        self._resize_grip.configure(font=(FONT_FAMILY, self._fp(8)))
        self._resize_grip.place_configure(width=self._sp(14), height=self._sp(14))

        self._clear_rows()

        if status == "auth_error":
            self._status_label.configure(
                text=(
                    "Sesion expirada o no iniciada.\n"
                    "Clic derecho en el icono -> Iniciar sesion."
                ),
                fg=ERROR_COLOR,
            )
            self._status_label.pack(anchor="w", pady=(0, 4))
        elif status == "error":
            self._status_label.configure(text=f"Error: {error_message}", fg=ERROR_COLOR)
            self._status_label.pack(anchor="w", pady=(0, 4))
        elif status == "loading" and not limits:
            self._status_label.configure(text="Cargando...", fg=SUBTEXT_COLOR)
            self._status_label.pack(anchor="w", pady=(0, 4))

        for index, block in enumerate(limits):
            self._add_row(block, is_first=(index == 0))

        self._resize_to_content()
        if self._visible and not self._has_moved and self._anchor_cursor is not None:
            self._reposition(self._anchor_cursor)

    def _add_row(self, block, is_first: bool) -> None:
        frame = tk.Frame(self._container, bg=BG_COLOR)
        frame.pack(fill="x", pady=(0 if is_first else self._sp(14), 0))

        header = tk.Frame(frame, bg=BG_COLOR)
        header.pack(fill="x")

        label_widget = tk.Label(
            header, text=block.label, bg=BG_COLOR, fg=TEXT_COLOR,
            font=(FONT_FAMILY, self._fp(12)), anchor="w",
        )
        label_widget.pack(side="left")

        is_warning = block.percent >= WARNING_THRESHOLD
        percent_text = block.value_text if block.value_text is not None else f"{block.percent:.0f}%"
        percent_widget = tk.Label(
            header, text=percent_text,
            bg=BG_COLOR, fg=(ERROR_COLOR if is_warning else SUBTEXT_COLOR),
            font=(FONT_FAMILY, self._fp(11)), anchor="e",
        )
        percent_widget.pack(side="right")

        bar_bg = tk.Frame(frame, bg=BAR_BG_COLOR, height=self._sp(4))
        bar_bg.pack(fill="x", pady=(self._sp(6), self._sp(4)))
        bar_bg.pack_propagate(False)

        width_ratio = max(0.0, min(block.percent / 100.0, 1.0))
        if width_ratio > 0:
            bar_fg = tk.Frame(bar_bg, bg=(ERROR_COLOR if is_warning else BAR_FG_COLOR))
            bar_fg.place(relx=0, rely=0, relwidth=width_ratio, relheight=1)

        reset_text = _format_resets(block.kind, block.resets_at)
        if reset_text:
            reset_widget = tk.Label(
                frame, text=reset_text, bg=BG_COLOR, fg=SUBTEXT_COLOR,
                font=(FONT_FAMILY, self._fp(10)), anchor="w",
            )
            reset_widget.pack(fill="x")

        self._rows.append(frame)

    def _resize_to_content(self) -> None:
        self._window.update_idletasks()
        # El ancho medido (winfo_reqwidth) ya refleja el tamano real de fuente
        # que Tk calculo (correcto en DPI-aware); si supera nuestra estimacion
        # via _sp(), gana el medido para nunca recortar/superponer texto.
        min_width = self._sp(POPUP_WIDTH)
        content_width = max(self._titlebar.winfo_reqwidth(), self._container.winfo_reqwidth())
        width = max(min_width, content_width)
        height = self._titlebar.winfo_reqheight() + self._container.winfo_reqheight()
        self._window.geometry(f"{width}x{height}")

    def _reposition(self, cursor_pos: tuple[int, int]) -> None:
        self._window.update_idletasks()
        width = self._window.winfo_width()
        height = self._window.winfo_height()
        x, y = cursor_pos
        left, top, right, bottom = get_work_area_for(x, y)
        pos_x = min(max(x - width // 2, left + 8), right - width - 8)
        pos_y = min(max(y - height - 16, top + 8), bottom - height - 8)
        self._window.geometry(f"+{pos_x}+{pos_y}")

    @property
    def visible(self) -> bool:
        return self._visible

    def toggle(self, state, cursor_pos: tuple[int, int]) -> None:
        if self._visible:
            self.hide()
        else:
            self.show(state, cursor_pos)

    def show(self, state, cursor_pos: tuple[int, int]) -> None:
        self._window.attributes("-alpha", self._idle_alpha)
        self._visible = True
        self._anchor_cursor = cursor_pos
        self._dpi_scale = get_dpi_for(*cursor_pos) / DEFAULT_DPI
        self.refresh(state)
        if not self._has_moved:
            self._reposition(cursor_pos)
        self._window.deiconify()
        self._window.lift()
        self._window.focus_force()
        _round_corners(self._window)

    def hide(self) -> None:
        self._window.withdraw()
        self._visible = False
