#!/usr/bin/env node
/**
 * Build the downloadable MT5 bridge package.
 *
 * The site is static, so the package is produced at build time into
 * `public/downloads/vaelor-mt5-bridge.zip`. The zip writer is dependency-free
 * (node:zlib + a CRC32 table) so `npm run build` never needs a new package.
 *
 * Included: the bridge application, launcher scripts, requirements, env
 * template, README and a generated START-HERE.txt.
 * Excluded: the venv, local database, tokens, tests and caches.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'mt5-bridge');
const outDir = path.join(root, 'public', 'downloads');
const outFile = path.join(outDir, 'vaelor-mt5-bridge.zip');

if (!existsSync(source)) {
  console.error(`[pack-bridge] missing source directory: ${source}`);
  process.exit(1);
}

const INCLUDED = [
  'README.md',
  'requirements.txt',
  '.env.example',
  'run.ps1',
  'run.cmd',
];

const FOLDERS = [
  ['app', (name) => name.endsWith('.py')],
  ['tools', (name) => name.endsWith('.py')],
];

const START_HERE = `VAELOR MT5 BRIDGE - START HERE
=============================

This folder connects your own MetaTrader 5 terminal to the Vaelor Execution page.
Nothing is uploaded: the bridge runs on your PC and only talks to 127.0.0.1.

WHAT YOU NEED
-------------
1. Windows 10 or 11 (MetaTrader5's Python package is Windows-only).
2. MetaTrader 5 installed and logged in to a demo or live account.
3. Python 3.11 or newer - install from https://www.python.org/downloads/
   (tick "Add python.exe to PATH"), or install uv from
   https://docs.astral.sh/uv/. The launcher finds either one.

FIRST RUN
---------
1. Double-click run.cmd.
2. The first run creates a private Python environment and installs the bridge
   dependencies. This can take a few minutes and needs internet access once.
3. The console prints the URL and token you need, and saves them to two
   files next to run.cmd:

     connect.txt   <- open this: URL and token, ready to paste
     token.txt     <- just the token

     URL   : http://127.0.0.1:8899
     Token : <a long random string>
     Mode  : auto (falls back to simulation)

   If port 8899 is already used the launcher sorts it out by itself: it
   either finds the bridge already running there (and gives you its URL and
   token in connect.txt) or starts on the next free port (8899-8925).

4. Open the Vaelor Execution page, paste the URL and Token, then click Connect.
5. Pick your terminal from the detected list and connect. If the terminal is
   logged in, the account appears immediately.

KEEP THE WINDOW OPEN
--------------------
The console window IS the bridge. While you trade it must stay open - you can
minimise it, but closing it stops the bridge and the page goes offline. The
window never closes by itself: if anything goes wrong (missing Python, failed
install, port already used, a crashed server) it stops, prints the reason in
plain English, and waits for you to press a key, so you can read the message.

ABOUT AUTOTRADING
-----------------
Reading prices, positions and history works as soon as the account is logged in.
Sending real orders also requires AutoTrading to be enabled in MetaTrader 5:

  * press the "AutoTrading" button in the terminal toolbar, and
  * enable Tools > Options > Expert Advisors > Allow algorithmic trading.

The bridge never enables that for you and never stores your password.

LIVE TRADING INTERLOCK
----------------------
Real orders are refused unless BOTH are true:
  * mt5-bridge/.env contains ALLOW_LIVE_TRADES=1, and
  * you type LIVE in the Execution page confirmation.

Default is simulation, which is safe: no broker order is ever sent.

STOPPING
--------
Close the console window or press Ctrl+C. Nothing is left running.

IF SOMETHING GOES WRONG
-----------------------
* "The bridge is ALREADY RUNNING" - nothing is wrong: your URL and token
  were just saved to connect.txt next to run.cmd. Open it, paste the two
  lines into the site, and click Connect.
* Port conflict - handled automatically: the launcher probes the port and
  either reuses the running bridge or starts on the next free one. The URL
  it chose is always in connect.txt.
* "No suitable Python was found" - install Python 3.11+ from python.org,
  tick "Add python.exe to PATH", and run run.cmd again.
* "Dependency installation failed" - check your internet connection and run
  run.cmd again.
* Wrong token on the site - open connect.txt next to run.cmd and copy the
  exact lines inside it.
`;

function crc32(buffer) {
  if (!crc32.table) {
    crc32.table = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crc32.table[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = crc32.table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, date: day };
}

/** Minimal store/deflate zip writer. */
function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const entry of entries) {
    const name = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
    const raw = entry.data;
    const compressed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, compressed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(raw.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

const entries = [];
for (const file of INCLUDED) {
  const full = path.join(source, file);
  if (!existsSync(full)) {
    console.warn(`[pack-bridge] skip missing ${file}`);
    continue;
  }
  entries.push({ name: file, data: readFileSync(full) });
}

for (const [folder, filter] of FOLDERS) {
  const dir = path.join(source, folder);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).sort()) {
    if (!filter(name)) continue;
    const full = path.join(dir, name);
    if (!statSync(full).isFile()) continue;
    entries.push({ name: `${folder}/${name}`, data: readFileSync(full) });
  }
}

entries.unshift({ name: 'START-HERE.txt', data: Buffer.from(START_HERE, 'utf8') });

mkdirSync(outDir, { recursive: true });
const zip = buildZip(entries);
writeFileSync(outFile, zip);

const digest = createHash('sha256').update(zip).digest('hex').slice(0, 16);
console.log(
  `[pack-bridge] ${entries.length} files -> ${path.relative(root, outFile)} ` +
    `(${(zip.length / 1024).toFixed(1)} KiB, sha256 ${digest}...)`,
);
