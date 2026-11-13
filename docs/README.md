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

## De dónde salen los precios

| Clase | Fuente | Frecuencia | Llave |
| --- | --- | --- | --- |
| Crypto listada en Coinbase | Coinbase Exchange (WebSocket) | tick a tick | no |
| Resto de crypto | CoinGecko | cada 60 s | no |
| Oro, plata, platino, paladio | gold-api.com | cada 30 s | no |
| Acciones y ETFs de EE. UU. | Finnhub | cada 15 s | sí, gratuita |
| Efectivo / conversión de moneda | open.er-api.com | diaria | no |
| Otro activo | valor que escribes | — | — |

Límites conocidos:

- **Acciones**: sin llave de Finnhub no tienen precio. La llave se pega en
  Ajustes y se guarda solo en el navegador. El plan gratuito no cubre bolsas
  fuera de EE. UU.
- **Metales**: la fuente no da precio de referencia. El cambio de 24 h se
  calcula con los precios que la propia app registra mientras está abierta, así
  que solo aparece si la abriste más o menos a esa hora el día anterior.
- **Gráficos**: solo crypto tiene histórico gratuito.
- **CoinGecko** limita peticiones por IP; si responde 429 la app reintenta sola.

## Datos

Todo se guarda en `localStorage` de ese navegador. Ajustes → Exportar copia /
Importar copia para moverlo a otro dispositivo. La copia no incluye la llave.

## Estructura

```
index.html  styles.css  manifest.webmanifest  sw.js  serve.mjs
js/main.js      pantallas y conexión entre módulos
js/prices.js    motor de precios en vivo
js/catalog.js   activos disponibles y búsqueda
js/store.js     posiciones y ajustes
js/format.js    formato de moneda y números
js/motion.js    springs y gestos
js/sheet.js     hojas deslizables y avisos
js/chart.js     gráfico
js/logo.js      logos con alternativa si no cargan
tools/build-catalog.mjs   regenera js/catalog-data.js (top 100 de crypto)
```
