/* Generates Discord Rich Presence assets in build/discord-assets from the mk branding. */
const fs = require('node:fs/promises');
const path = require('node:path');
const sharp = require('sharp');

const SRC = path.join(__dirname, '..', 'mk.png');
const OUT_DIR = path.join(__dirname, '..', 'build', 'discord-assets');
const SIZE = 512;

const COLORS = {
  pink: '#ff3b64',
  white: '#f5f2ed',
};

function toBuffer(markup) {
  return Buffer.from(markup);
}

function createSmallBackgroundSvg() {
  return toBuffer(`
    <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="256" cy="256" r="150" fill="${COLORS.pink}"/>
    </svg>
  `);
}

function createStateIconSvg(kind) {
  if (kind === 'play') {
    return toBuffer(`
      <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M204 177.5C204 163.4 219.5 154.9 231.3 162.9L342.2 238.4C352.2 245.2 352.2 259.8 342.2 266.6L231.3 342.1C219.5 350.1 204 341.6 204 327.5V177.5Z" fill="#F5F2ED"/>
      </svg>
    `);
  }

  if (kind === 'pause') {
    return toBuffer(`
      <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="190" y="170" width="44" height="172" rx="18" fill="#F5F2ED"/>
        <rect x="278" y="170" width="44" height="172" rx="18" fill="#F5F2ED"/>
      </svg>
    `);
  }

  return toBuffer(`
    <svg width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="188" cy="256" r="22" fill="#F5F2ED"/>
      <circle cx="256" cy="256" r="22" fill="#F5F2ED"/>
      <circle cx="324" cy="256" r="22" fill="#F5F2ED"/>
    </svg>
  `);
}

async function buildLargeAsset() {
  const logo = await sharp(SRC)
    .resize(384, 384, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  await sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: logo, left: 64, top: 64 },
    ])
    .png()
    .toFile(path.join(OUT_DIR, 'monochrome.png'));
}

async function buildStateAsset(kind) {
  await sharp({
    create: {
      width: SIZE,
      height: SIZE,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite([
      { input: createSmallBackgroundSvg() },
      { input: createStateIconSvg(kind) },
    ])
    .png()
    .toFile(path.join(OUT_DIR, `${kind}.png`));
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  await buildLargeAsset();
  await Promise.all(['play', 'pause', 'idle'].map((kind) => buildStateAsset(kind)));

  console.log(`Discord assets generated in ${OUT_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});