// Renders the app icon and the iOS launch images, and rewrites the launch-image
// <link> tags in index.html. Needs Playwright with Chromium.
//
//   node tools/make-images.cjs
//
// iOS shows a launch image only when one matches the device's exact size, so
// each iPhone screen size gets its own file, in light and dark.

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const C = 2 * Math.PI * 118, GAP = 72;
const arc = (start, frac, color) =>
  `<circle cx="256" cy="256" r="118" fill="none" stroke="${color}" stroke-width="46" stroke-linecap="round" stroke-dasharray="${(frac * C - GAP).toFixed(1)} 9999" stroke-dashoffset="${(-(start * C + GAP / 2)).toFixed(1)}" transform="rotate(-90 256 256)"/>`;
const mark = ink => arc(0, 0.52, '#34d27b') + arc(0.52, 0.30, ink) + arc(0.82, 0.18, '#77777d');

const icon = pad => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="100%" height="100%">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1d1d20"/><stop offset="1" stop-color="#060607"/></linearGradient></defs>
  <rect width="512" height="512" fill="url(#bg)"/>
  <g transform="translate(256 256) scale(${pad}) translate(-256 -256)">${mark('#f5f5f7')}</g></svg>`;

// Portrait sizes in CSS pixels and their pixel ratio.
const PHONES = [
  [440, 956, 3], [430, 932, 3], [428, 926, 3], [420, 912, 3], [414, 896, 3], [414, 896, 2],
  [402, 874, 3], [393, 852, 3], [390, 844, 3], [375, 812, 3], [375, 667, 2],
];
const THEMES = { light: { bg: '#f2f2f7', ink: '#0b0b0d' }, dark: { bg: '#000000', ink: '#f5f5f7' } };

(async () => {
  const browser = await chromium.launch();
  const shoot = async (file, w, h, dpr, html) => {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
    await page.setContent(`<body style="margin:0">${html}</body>`);
    await page.screenshot({ path: path.join(root, file), clip: { x: 0, y: 0, width: w, height: h } });
    await page.close();
  };

  fs.mkdirSync(path.join(root, 'icons'), { recursive: true });
  for (const [name, size, pad] of [['icon-512.png', 512, 1], ['icon-192.png', 192, 1], ['apple-touch-icon.png', 180, 1], ['icon-maskable-512.png', 512, 0.78]]) {
    await shoot(`icons/${name}`, size, size, 1, `<div style="width:${size}px;height:${size}px">${icon(pad)}</div>`);
  }

  fs.mkdirSync(path.join(root, 'splash'), { recursive: true });
  const links = [];
  for (const [w, h, dpr] of PHONES) {
    for (const [theme, c] of Object.entries(THEMES)) {
      const file = `splash/${w}x${h}-${dpr}x-${theme}.png`;
      await shoot(file, w, h, dpr, `<div style="width:${w}px;height:${h}px;background:${c.bg};display:grid;place-items:center">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="84" height="84">${mark(c.ink)}</svg></div>`);
      links.push(`<link rel="apple-touch-startup-image" media="(device-width: ${w}px) and (device-height: ${h}px) and (-webkit-device-pixel-ratio: ${dpr}) and (orientation: portrait) and (prefers-color-scheme: ${theme})" href="${file}">`);
    }
  }
  await browser.close();

  const index = path.join(root, 'index.html');
  const html = fs.readFileSync(index, 'utf8');
  const start = html.indexOf('<!-- splash:start'), end = html.indexOf('<!-- splash:end -->');
  if (start < 0 || end < 0) throw new Error('splash markers not found in index.html');
  const head = html.slice(0, html.indexOf('\n', start) + 1);
  fs.writeFileSync(index, head + links.join('\n') + '\n' + html.slice(end));
  const bytes = fs.readdirSync(path.join(root, 'splash')).reduce((n, f) => n + fs.statSync(path.join(root, 'splash', f)).size, 0);
  console.log(`icons: 4, launch images: ${links.length} (${Math.round(bytes / 1024)} KB)`);
})().catch(e => { console.error(e); process.exit(1); });
