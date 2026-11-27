import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { inflateSync } from 'node:zlib';
import { resolve } from 'node:path';

function decodePngAlphaBounds(filePath) {
  const bytes = requireBuffer(filePath);
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${filePath}: PNG signature`);
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  assert.equal(bytes[24], 8, `${filePath}: expected 8-bit PNG`);
  assert.equal(bytes[25], 6, `${filePath}: expected RGBA PNG with alpha`);

  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
    if (type === 'IEND') break;
  }

  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  let previous = new Uint8Array(stride);
  let minX = width, minY = height, maxX = -1, maxY = -1, transparentPixels = 0;
  const paeth = (a, b, c) => {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };

  for (let y = 0; y < height; y++) {
    const rowOffset = y * (stride + 1);
    const filter = raw[rowOffset];
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const value = raw[rowOffset + 1 + i];
      const left = i >= 4 ? row[i - 4] : 0;
      const up = previous[i];
      const upperLeft = i >= 4 ? previous[i - 4] : 0;
      if (filter === 0) row[i] = value;
      else if (filter === 1) row[i] = (value + left) & 255;
      else if (filter === 2) row[i] = (value + up) & 255;
      else if (filter === 3) row[i] = (value + Math.floor((left + up) / 2)) & 255;
      else if (filter === 4) row[i] = (value + paeth(left, up, upperLeft)) & 255;
      else assert.fail(`${filePath}: unsupported PNG filter ${filter}`);
    }
    for (let x = 0; x < width; x++) {
      if (row[x * 4 + 3] === 0) {
        transparentPixels++;
        continue;
      }
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    previous = row;
  }
  return { width, height, minX, minY, maxX, maxY, transparentPixels };
}

function requireBuffer(relativePath) {
  // Synchronous read keeps the PNG row decoder straightforward and these files are small.
  return readFileSync(resolve(relativePath));
}

const config = JSON.parse(await readFile('app.json', 'utf8')).expo;
assert.equal(config.icon, './assets/images/icon.png');
assert.equal(config.ios.icon, './assets/images/icon.png');
assert.equal(config.android.adaptiveIcon.foregroundImage, './assets/images/android-icon-foreground.png');
assert.equal(config.android.adaptiveIcon.monochromeImage, './assets/images/android-icon-monochrome.png');
assert.equal(config.android.adaptiveIcon.backgroundColor, '#121212');
assert.equal(config.web.favicon, './assets/images/favicon.png');
const splashPlugin = config.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === 'expo-splash-screen')[1];
assert.equal(splashPlugin.image, './assets/images/splash-icon.png');
assert.equal(splashPlugin.backgroundColor, '#121212');
assert.equal(splashPlugin.imageWidth, 160);

const icon = decodePngAlphaBounds('assets/images/icon.png');
const foreground = decodePngAlphaBounds('assets/images/android-icon-foreground.png');
const monochrome = decodePngAlphaBounds('assets/images/android-icon-monochrome.png');
const splash = decodePngAlphaBounds('assets/images/splash-icon.png');
const mark = decodePngAlphaBounds('assets/images/mathwake-mark.png');
const favicon = decodePngAlphaBounds('assets/images/favicon.png');
for (const asset of [icon, foreground, monochrome, splash, mark]) {
  assert.deepEqual([asset.width, asset.height], [1024, 1024]);
}
assert.deepEqual([favicon.width, favicon.height], [256, 256]);
assert.equal(icon.transparentPixels, 0, 'iOS app icon must have an opaque background');
for (const asset of [foreground, monochrome]) {
  assert.ok(asset.transparentPixels > 0, 'Adaptive icon foreground must preserve transparency');
  assert.ok(asset.maxX - asset.minX + 1 <= 626, 'Adaptive icon artwork must fit the 66×66 safe width');
  assert.ok(asset.maxY - asset.minY + 1 <= 626, 'Adaptive icon artwork must fit the 66×66 safe height');
}

const splashSource = await readFile('src/components/animated-icon.tsx', 'utf8');
const rootLayout = await readFile('src/app/_layout.tsx', 'utf8');
assert.match(splashSource, /useReducedMotion/);
assert.match(splashSource, /Wake up\. Solve\. Grow\./);
assert.match(splashSource, /SplashScreen\.hideAsync\(\)/);
assert.match(splashSource, /if \(reduceMotion\) setVisible\(false\)/);
assert.match(rootLayout, /<AnimatedSplashOverlay\s*\/>/);
assert.equal((rootLayout.match(/<AnimatedSplashOverlay\s*\/>/g) ?? []).length, 1);
assert.ok(splashSource.includes("require('@/assets/images/mathwake-mark.png')"));

console.log('Hasil: logo PNG, safe area adaptive Android, konfigurasi icon/splash, tagline, reduced-motion dan root-only overlay (lulus).');
