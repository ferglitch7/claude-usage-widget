# Claude Usage Tray Widget

Widget para la bandeja del sistema de Windows 11 que muestra el uso actual de
Claude.ai (sesion actual, limites semanales por modelo) en un popup flotante,
leyendo el endpoint interno que usa la propia web de Claude.

## Instalacion (para usuarios finales)

1. Descarga `installer/ClaudeUsageWidget-Setup.exe`.
2. Ejecutalo (no pide admin, se instala en tu carpeta de usuario). Si Windows
   SmartScreen avisa "Windows protegio tu PC" (el instalador no esta firmado
   digitalmente), click en **Mas informacion -> Ejecutar de todas formas**.
3. Sigue el asistente. Puedes marcar la casilla **"Iniciar automaticamente con
   Windows"** si quieres autoarranque.
4. Al terminar, se abre el widget solo y aparece una ventana **"Iniciar sesion
   - Claude.ai"** embebida (WebView2). Inicia sesion ahi con tu cuenta de
   Claude.ai (Google o email) igual que en el navegador normal.
5. La ventana se cierra sola en cuanto detecta la sesion, y el icono naranja
   queda en la bandeja del sistema (junto al reloj).

No hace falta copiar cookies a mano ni usar DevTools: el login embebido lee la
sesion directamente del cookie store nativo de WebView2 y la guarda en
`cookies.local.json`, dentro de la carpeta de instalacion.

Para volver a iniciar sesion mas adelante (p. ej. si la sesion expira), click
derecho en el icono de bandeja -> **Iniciar sesion**.

## Uso

- **Clic izquierdo:** abre/cierra el popup con el uso.
- **Pasar el mouse por encima:** el tooltip muestra el % de la sesion actual.
- **Clic derecho:** menu con **Iniciar sesion**, **Actualizar ahora** y
  **Salir**.
- El popup refresca automaticamente cada 15 segundos mientras esta abierto, y
  se puede arrastrar y ajustar su opacidad con la barra de la esquina
  superior.

## Por que no lee las cookies de Brave/Chrome directamente

Brave/Chrome 127+ cifran las cookies con App-Bound Encryption (ABE), asi que
la lectura automatica via `browser_cookie3` falla
(`Unable to get key for cookie decryption`). El unico bypass conocido de ABE
usa tecnicas tipo infostealer (process hollowing, syscalls directos) y
deliberadamente **no se implementa aqui**. Por eso el widget usa su propia
ventana de login embebida (WebView2) en vez de intentar leer la sesion de otro
navegador.

## Desarrollo

### Requisitos

- Windows 11
- Python 3.10+

### Setup

```powershell
pip install -r requirements.txt
python main.py
```

Si no existe `cookies.local.json`, se dispara automaticamente el login
embebido (`login_flow.py`) al arrancar. Tambien se puede forzar con:

```powershell
python main.py --login
```

### Fallback manual de cookies (debug / sin WebView2)

Si por algun motivo el login embebido no funciona, se puede seguir editando
`cookies.local.json` a mano (usa `cookies.local.example.json` como plantilla):

1. Abre `claude.ai` en el navegador con tu sesion iniciada.
2. DevTools (**F12**) -> **Network** -> filtra **Fetch/XHR** -> entra a
   **Settings -> Usage** (o recarga esa pagina) -> busca la request `usage`.
3. **Headers -> Request Headers -> cookie**, copia `sessionKey` y
   `lastActiveOrg`.
4. Pega ambos valores en `cookies.local.json`:

   ```json
   {
     "sessionKey": "sk-ant-sid02-...",
     "lastActiveOrg": "00000000-0000-0000-0000-000000000000"
   }
   ```

> El `sessionKey` equivale a tu sesion activa de Claude.ai: tratalo como una
> contrasena. `cookies.local.json` esta en `.gitignore` para que no se suba, y
> nunca debe compartirse ni incluirse al empaquetar el widget para otra
> persona.

### Reconstruir el .exe y el instalador

```powershell
python -m PyInstaller ClaudeUsageWidget.spec --noconfirm
& "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" ClaudeUsageWidget.iss
```

Esto genera `dist\ClaudeUsageWidget.exe` y
`installer\ClaudeUsageWidget-Setup.exe`. Cierra cualquier instancia del widget
corriendo antes de reconstruir (Windows bloquea el archivo si esta en uso).

### Autoarranque manual (sin el instalador)

El instalador ya ofrece esto como checkbox. Para hacerlo a mano: crea un
acceso directo a `ClaudeUsageWidget.exe` dentro de
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup` (escribe
`shell:startup` en el explorador para llegar rapido).

## Estructura

```
claude-usage-widget/
├── main.py                     # entrypoint: tray icon, menu, loop de polling
├── login_flow.py                # login embebido (WebView2) -> cookies.local.json
├── auth.py                     # cookie: browser_cookie3 + fallback manual
├── api_client.py               # cliente del endpoint /usage
├── ui.py                       # popup tkinter (estilo flyout de Windows 11)
├── ClaudeUsageWidget.spec       # config de PyInstaller
├── ClaudeUsageWidget.iss        # script de Inno Setup (instalador)
├── installer/                   # ClaudeUsageWidget-Setup.exe generado
├── dist/                        # ClaudeUsageWidget.exe generado
├── cookies.local.json          # tu sesion (ignorado por git) -- se crea sola al loguearte
├── cookies.local.example.json  # plantilla para el fallback manual
└── requirements.txt
```
