#!/usr/bin/env node
// Regenerates the landing page's "scan to play" QR image.
// Run after changing the production URL: node scripts/gen-qr-asset.mjs
import QRCode from 'qrcode';

const URL = process.env.PAINTBLAST_URL ?? 'https://paintblast-mr.netlify.app';

await QRCode.toFile('public/landing/qr-play.png', URL, {
  width: 480,
  margin: 2,
  color: { dark: '#0b0b10', light: '#f5f2ec' },
});
console.log(`QR for ${URL} -> public/landing/qr-play.png`);
