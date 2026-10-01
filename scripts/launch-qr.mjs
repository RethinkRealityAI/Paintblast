#!/usr/bin/env node
// Prints a scannable QR code for launching PaintBlast MR on a Meta Quest headset.
//
// Usage:
//   npm run qr       → QR for the deployed production URL (zero-friction path)
//   npm run qr:dev   → QR for this machine's LAN dev server (run `npm run dev` first)
//
// How the Quest side works: with passthrough on, glance at the QR code on your
// monitor — Horizon OS detects it automatically and shows an "Open link"
// pill; tap it and the game opens in Quest Browser. Then press "Enter AR".

import qrcode from 'qrcode-terminal';
import { networkInterfaces } from 'node:os';

const DEPLOY_URL = process.env.PAINTBLAST_URL ?? 'https://paintblast-mr.netlify.app';
const DEV_PORT = 8083; // must match server.port in vite.config.ts

function lanAddress() {
  const candidates = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) {
        candidates.push(a.address);
      }
    }
  }
  // Prefer classic private LAN ranges (Wi-Fi/Ethernet) over virtual adapters.
  const preferred = candidates.find((ip) =>
    /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip),
  );
  return preferred ?? candidates[0];
}

const dev = process.argv.includes('--dev');
let url = DEPLOY_URL;

if (dev) {
  const ip = lanAddress();
  if (!ip) {
    console.error(
      'No LAN IPv4 address found. Connect to Wi-Fi/Ethernet and try again.',
    );
    process.exit(1);
  }
  url = `https://${ip}:${DEV_PORT}`;
}

console.log('');
console.log('  PaintBlast MR — scan with your Quest');
console.log(`  ${url}`);
console.log('');
qrcode.generate(url, { small: true });
console.log('');
console.log('  1. Put on your Quest with passthrough on.');
console.log('  2. Glance at this QR code on your monitor and tap the "Open link" pill.');
console.log('     (Quest 3 / 3S detect QR codes automatically in passthrough.)');
console.log('  3. In Quest Browser, press "Enter AR" and start blasting.');
if (dev) {
  console.log('');
  console.log('  Dev-server note: the local HTTPS certificate is self-signed, so');
  console.log('  Quest Browser will warn once — choose Advanced → Proceed.');
  console.log('  Your Quest must be on the same Wi-Fi network as this PC.');
}
console.log('');
