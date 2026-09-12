"""Script de prueba manual (no se distribuye) para probar el flujo completo
de actualizacion: la ventana de aviso + que el widget instalado se cierre
solo justo despues de lanzar el instalador (para que Inno Setup nunca
tenga que negociar el cierre via Restart Manager, que fallaba en la
practica). Correr con: python test_update_notice.py

IMPORTANTE: para que la prueba tenga sentido, deja el widget instalado
corriendo (icono en la bandeja) antes de correr este script.

"Actualizar ahora" descarga y lanza el instalador real de v1.3.0 (la
version ya publicada), y ~0.3s despues cierra a la fuerza cualquier
ClaudeUsageWidget.exe corriendo -- simulando el mismo timing que
`on_launched` hace en la app real. Si el instalador ya no muestra el
dialogo de "no se pudo cerrar la aplicacion", el fix funciona.
"""

import subprocess
import time
import tkinter as tk

import main

TEST_URL = "https://github.com/ferglitch7/claude-usage-widget/releases/download/v1.3.0/ClaudeUsageWidget-Setup.exe"


def _launch_and_close_running_widget() -> None:
    main._download_and_launch_installer(TEST_URL)
    time.sleep(0.3)
    subprocess.run(
        ["taskkill", "/IM", "ClaudeUsageWidget.exe", "/F"],
        capture_output=True,
    )
    print("[test] instalador lanzado y ClaudeUsageWidget.exe cerrado a la fuerza.")


root = tk.Tk()
root.withdraw()

main._show_update_notice(
    root,
    "9.9.9",
    TEST_URL,
    _launch_and_close_running_widget,
    lambda: print("[test] Mas tarde -- descartado."),
)

root.mainloop()
