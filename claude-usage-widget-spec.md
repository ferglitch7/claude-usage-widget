# Claude Usage Tray Widget — Spec para Claude Code

## Objetivo
Widget en la bandeja del sistema de Windows 11 (system tray) que, al hacer clic,
despliega un popup flotante mostrando el uso actual de Claude.ai (session, weekly
por modelo), leyendo el endpoint interno no documentado que usa la propia app web.

## Stack
- **Python 3.x**
- `pystray` → icono de bandeja
- `tkinter` (Toplevel sin bordes, `overrideredirect(True)`) → popup flotante.
  Alternativa si tkinter da problemas de estética: `customtkinter` para look más
  moderno sin salir de la librería estándar-adyacente.
- `browser_cookie3` → extracción automática de cookies de sesión desde Brave
  (usa el mismo formato Chromium; desencripta vía DPAPI de Windows bajo el
  usuario actual, sin intervención manual).
- `requests` → polling al endpoint.
- `threading` o `asyncio` → loop de refresco sin bloquear la UI.

## Autenticación
- Leer cookies de Brave para el dominio `claude.ai` con `browser_cookie3.brave()`.
- **Riesgo conocido:** si Brave tiene el archivo de cookies bloqueado en el
  momento exacto de la lectura, puede fallar. Implementar retry con backoff
  corto (ej. 3 intentos, 1s entre cada uno) antes de reportar error en UI.
- **Rotación de sesión:** la cookie puede expirar/rotar. Si el request devuelve
  401/403, el widget debe mostrar un estado "sesión expirada" en vez de
  crashear, y seguir reintentando en cada ciclo de polling.

## Endpoint (a descubrir, no confirmado)
No tengo la URL ni el schema exacto del endpoint interno. Se menciona como
`/usageAPI` en fuentes de terceros, pero no está documentado oficialmente.
**Primer paso de Claude Code antes de escribir lógica de negocio:**
1. Abrir DevTools (F12) → pestaña Network en Brave, sobre `claude.ai`.
2. Ir a Settings → Usage dentro de la app.
3. Filtrar por XHR/Fetch, identificar la request que trae session/weekly usage.
4. Documentar: URL completa, método, headers requeridos (aparte de la cookie),
   y forma exacta del JSON de respuesta (campos, nombres, tipos).
5. Recién ahí escribir el cliente HTTP contra ese contrato real.

## Datos a mostrar (igual que la captura de referencia)
- **Current session**: % usado + barra de progreso + "Resets in Xh Ym"
- **Weekly limits → All models**: % usado + barra + "Resets [día] [hora]"
- **Weekly limits → Fable only**: % usado + barra + "Resets [día] [hora]"
(Si el plan del usuario no tiene Fable, ese bloque no debe romper el widget —
renderizar solo lo que el JSON traiga.)

## UI — estilo Windows 11 nativo
- Fondo oscuro (~`#202020` / `#2C2C2C`), esquinas redondeadas.
- Windows 11 redondea automáticamente ventanas top-level sin decoración vía
  DWM en builds recientes — probar antes de implementar rounded-corners a mano
  con `ctypes` (`DwmSetWindowAttribute`, `DWMWA_WINDOW_CORNER_PREFERENCE`).
- Barras de progreso: línea delgada, azul (~`#4A9EFF` o similar al de la
  captura), fondo gris oscuro.
- Tipografía: Segoe UI (nativa de Windows), tamaños discretos (11-13px).
- Sin chrome de ventana (sin barra de título, sin bordes de sistema).
- Posicionamiento: aparece anclado cerca del icono de tray, como los flyouts
  nativos de volumen/wifi/batería de Windows 11.

## Comportamiento
- **Refresco:** cada 15s (constante configurable, ver aviso de riesgo arriba).
- **Clic en el icono de tray:** toggle — un clic abre el popup, otro clic
  (en el mismo icono) lo cierra. Clic fuera del popup también lo cierra
  (comportamiento estándar de flyout de Windows).
- **Autoarranque:** NO. El usuario abre el script manualmente cada vez
  (sin entrada en Task Scheduler ni carpeta de Startup).

## Estructura de archivos sugerida
```
claude-usage-widget/
├── main.py              # entrypoint, tray icon, loop principal
├── auth.py              # extracción de cookie vía browser_cookie3
├── api_client.py        # cliente del endpoint (una vez descubierto)
├── ui.py                # popup tkinter, estilos
└── requirements.txt
```

## Fuera de alcance (v1)
- Widget para iPhone (Scriptable) — proyecto separado, no incluir en esta build.
- Autoarranque con Windows.
- Notificaciones push al acercarse al límite (posible v2 si v1 funciona bien).

## Contexto de decisión (por si Claude Code pregunta)
- PC: Torre (no laptop).
- Navegador con sesión activa: Brave (también hay Chrome y la app Desktop de
  Claude instalados, pero el mecanismo de auth apunta a Brave).
- Prioridad: que funcione y sea simple, no que sea visualmente perfecto en v1.
