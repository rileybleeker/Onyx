import sharp from "sharp";
import { readFileSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(resolve(__dirname, "../public/icons/icon.svg"));
const outDir = resolve(__dirname, "../public/icons");

mkdirSync(outDir, { recursive: true });

const sizes = [
  { name: "icon-192.png", size: 192 },
  { name: "icon-512.png", size: 512 },
  { name: "apple-touch-icon.png", size: 180 },
  { name: "favicon-32.png", size: 32 },
  { name: "favicon-16.png", size: 16 },
];

for (const { name, size } of sizes) {
  await sharp(svg).resize(size, size).png().toFile(resolve(outDir, name));
  console.log(`✓ ${name} (${size}x${size})`);
}

// Also place apple-touch-icon at public root (iOS expects it there)
await sharp(svg)
  .resize(180, 180)
  .png()
  .toFile(resolve(__dirname, "../public/apple-touch-icon.png"));
console.log("✓ public/apple-touch-icon.png (180x180)");

// Favicon at public root
await sharp(svg)
  .resize(32, 32)
  .png()
  .toFile(resolve(__dirname, "../public/favicon.ico"));
console.log("✓ public/favicon.ico (32x32)");

console.log("\nDone!");
