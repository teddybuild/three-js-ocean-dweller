// Shared headless-browser launcher (GPU-accelerated Chrome: ANGLE/D3D11 on Windows, Vulkan + WebGPU on Linux).
import puppeteer from 'puppeteer-core';
import { existsSync } from 'node:fs';

const CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

export async function launch({ width = 1920, height = 1080 } = {}) {
  const executablePath = CANDIDATES.find((p) => existsSync(p));
  if (!executablePath) throw new Error('No Chrome/Edge found; set CHROME_PATH');
  const browser = await puppeteer.launch({
    executablePath,
    headless: 'new',
    protocolTimeout: 0,
    args: [
      // (Linux: these three flags give a hardware WebGPU adapter in headless Chrome 156 on the RTX 5080, 2026-10-29)
      ...(process.platform === 'linux' ? ['--use-angle=vulkan', '--enable-features=Vulkan', '--enable-unsafe-webgpu'] : ['--use-angle=d3d11']),
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-webgl',
      '--disable-gpu-watchdog',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--autoplay-policy=no-user-gesture-required',
      `--window-size=${width},${height}`,
    ],
    defaultViewport: { width, height, deviceScaleFactor: 1 },
  });
  return browser;
}

export async function openApp(browser, url, { width, height }) {
  const page = await browser.newPage();
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url, { waitUntil: 'load', timeout: 120000 });
  await page.waitForFunction(() => window.app || window.engine || document.querySelector('.err'), { timeout: 60000 });
  const err = await page.evaluate(() => document.querySelector('.err')?.textContent);
  if (err) throw new Error(err);
  return page;
}
