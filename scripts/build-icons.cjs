/* Generates build/icon.png (512x512) and build/icon.ico (multi-size) from mk.png. */
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');
const pngToIco = require('png-to-ico').default;

const SRC = path.join(__dirname, '..', 'mk.png');
const OUT_DIR = path.join(__dirname, '..', 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  // Square 512x512 PNG (electron-builder uses this for Linux/macOS fallback).
  const png512 = path.join(OUT_DIR, 'icon.png');
  await sharp(SRC).resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(png512);

  // Multi-size ICO for Windows (NSIS installer + executable).
  const buffers = await Promise.all(
    ICO_SIZES.map((size) =>
      sharp(SRC).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer(),
    ),
  );
  const icoBuffer = await pngToIco(buffers);
  await fs.writeFile(path.join(OUT_DIR, 'icon.ico'), icoBuffer);

  console.log(`Icons generated in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
