# Portfolio

App web instalable (PWA) que valora tus posiciones al precio de mercado en
vivo. Guardas cantidad y, si quieres, costo promedio por activo; no hay
historial de transacciones ni conexión a brokers o wallets.

Sin backend y sin paso de build: son archivos estáticos.

## Probarla

```
node serve.mjs          # http://localhost:4173
```

`http://localhost:4173/#demo` abre un portfolio de ejemplo que no se guarda.

## Publicarla

Sube la carpeta tal cual a cualquier hosting estático con HTTPS (Cloudflare
Pages, Netlify, Vercel, GitHub Pages). En el iPhone: abrirla en Safari →
Compartir → **Añadir a pantalla de inicio**.

### En tu tailnet (Tailscale, Windows)

En PowerShell, en la máquina que la va a servir:

```
irm https://raw.githubusercontent.com/ferglitch7/claude-usage-widget/claude/serene-davinci-syt3d3/docs/tools/serve-tailscale.ps1 | iex
```

Descarga la app en `%USERPROFILE%\portfolio`, la publica con `tailscale serve`
en un puerto HTTPS libre y muestra la dirección. Volver a ejecutarlo actualiza
los archivos y conserva la dirección.

Si la máquina tiene Python 3, el mismo comando activa la **copia automática**:
arranca `server/backup_server.py` (solo librería estándar, escucha en
127.0.0.1), lo monta en `/api` y lo deja iniciándose con Windows. Las copias
quedan en `%USERPROFILE%\portfolio-data`.

Para actualizar, vuelve a ejecutar el mismo comando. Nada se actualiza solo en
la máquina: así ningún cambio en el repo puede ejecutarse en ella sin que tú
lo lances. Si una versión anterior dejó la tarea "Portfolio update", el
instalador la elimina.

### Publicar un cambio

Sube el mismo número de versión en `version.json` y en `js/update.js`
(`node --test` falla si no coinciden). La app instalada compara su versión con
`version.json` cada vez que vuelve a primer plano y se recarga sola si hay una
nueva; nunca con una hoja abierta.

## De dónde salen los datos

| Clase | Precio en vivo | Histórico (gráficos) | Llave |
| --- | --- | --- | --- |
| Crypto listada en Coinbase | Coinbase, tick a tick | Coinbase | no |
| Resto de crypto | CoinGecko, cada 60 s | CoinGecko | no |
| Oro | gold-api.com, cada 30 s | Coinbase PAXG (token respaldado por oro), reescalado al precio spot | no |
| Plata, platino, paladio | gold-api.com, cada 30 s | aproximado con un ETF (SLV, PPLT, PALL) vía Twelve Data | Twelve Data, gratuita |
| Acciones y ETFs de EE. UU. | Finnhub, cada 15 s | Twelve Data | Finnhub y Twelve Data, gratuitas |
| Efectivo / conversión | open.er-api.com, diaria | — | no |
| Otro activo | valor que escribes | — | — |

Las llaves se pegan en Ajustes, se validan antes de guardarse y se quedan en
el navegador. No se incluyen en las copias.

Límites conocidos:

- **Acciones**: sin llave de Finnhub no tienen precio. El plan gratuito no
  cubre bolsas fuera de EE. UU.
- **Twelve Data gratis**: 8 consultas por minuto y 800 al día. La app las
  encola y guarda los resultados, así que con muchos activos los gráficos se
  completan poco a poco la primera vez.
- **Plata, platino y paladio**: el plan gratuito no da su precio spot
  histórico. El gráfico usa la forma del ETF reescalada al precio actual y la
  app lo marca como aproximado; el cambio de 24 h de estos metales sale de los
  precios que la propia app registra mientras está abierta.
- **CoinGecko** limita peticiones por IP; si responde 429 la app reintenta sola.

## El gráfico del portfolio

La app no guarda transacciones, así que los rangos 1D, 1S, 1M y 1A responden
«¿cuánto habrían valido mis posiciones de hoy?»: cantidades actuales por el
precio pasado de cada activo. Un activo sin histórico se mantiene plano y se
nombra bajo el gráfico.

El rango **Real** es distinto: dibuja el balance que la app registró de verdad
(una foto cada media hora mientras está abierta), así que empieza vacío y se
llena con el uso.

## Datos y copias

Las posiciones se guardan en `localStorage` de ese navegador.

- **Copia automática** (solo servida con `backup_server.py`): cada dispositivo
  mantiene su copia en la máquina que sirve la app. Las copias no se listan:
  cada una se recupera con su código (Ajustes → Código de esta copia), así que
  quien comparta la app no ve las copias de los demás. Si pierdes el código,
  los archivos de `portfolio-data` llevan el código como nombre. Una copia vacía nunca reemplaza a una con posiciones, y se
  conserva la última de cada día durante 14 días en `portfolio-data\history`.
- **Manual**: Ajustes → Exportar copia / Importar copia.

Una copia contiene posiciones, preferencias, objetivo y el historial real.

## Estructura

```
index.html  styles.css  manifest.webmanifest  sw.js  serve.mjs
js/main.js       pantallas y conexión entre módulos
js/prices.js     precios en vivo
js/history.js    históricos, con cola para el límite de Twelve Data
js/series.js     cálculo del valor del portfolio en el tiempo
js/snapshots.js  registro del balance real
js/targets.js    distribución objetivo y rebalanceo
js/stats.js      máximos, mínimos y capitalización del detalle
js/backup.js     cliente de la copia automática
js/catalog.js    activos disponibles y búsqueda
js/store.js      posiciones y ajustes
js/format.js     formato de moneda y números
js/ui.js         número animado, selector, interruptor, mini-gráfico
js/motion.js     springs y gestos
js/sheet.js      hojas deslizables y avisos
js/chart.js      gráfico
js/logo.js       logos con alternativa si no cargan
server/backup_server.py     almacén de copias (Python, sin dependencias)
tools/serve-tailscale.ps1   instalador para Windows + Tailscale
tools/build-catalog.mjs     regenera js/catalog-data.js (top 100 de crypto)
tools/make-images.cjs       regenera iconos e imágenes de arranque
tests/                      pruebas de la lógica: node --test
```
