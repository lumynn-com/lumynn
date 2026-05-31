import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "https://127.0.0.1:4177/";
const outDir = process.env.VISUAL_OUT_DIR ?? "artifacts/visual";

const cases = [
  {
    name: "login-desktop-dark",
    colorScheme: "dark",
    theme: "dark",
    viewport: { width: 1440, height: 960 }
  },
  {
    name: "login-mobile-dark",
    colorScheme: "dark",
    theme: "dark",
    viewport: { width: 390, height: 844 }
  },
  {
    name: "login-desktop-light",
    colorScheme: "light",
    theme: "light",
    viewport: { width: 1440, height: 960 }
  }
];

await mkdir(outDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  for (const testCase of cases) {
    const context = await browser.newContext({
      colorScheme: testCase.colorScheme,
      deviceScaleFactor: 1,
      ignoreHTTPSErrors: true,
      viewport: testCase.viewport
    });
    await context.addInitScript((theme) => {
      window.localStorage.setItem("owd_theme", theme);
    }, testCase.theme);
    const page = await context.newPage();
    await page.goto(baseURL, { waitUntil: "networkidle" });
    await page.locator(".login-card").waitFor({ state: "visible", timeout: 10_000 });

    const metrics = await page.evaluate(() => {
      const card = document.querySelector(".login-card");
      const mark = document.querySelector(".login-mark");
      const bodyText = document.body.innerText.trim();
      const rect = card?.getBoundingClientRect();
      const background = getComputedStyle(document.body).backgroundColor;
      return {
        bodyTextLength: bodyText.length,
        cardWidth: rect ? Math.round(rect.width) : 0,
        cardHeight: rect ? Math.round(rect.height) : 0,
        background,
        theme: document.documentElement.dataset.theme,
        markVisible: Boolean(mark && mark.offsetWidth > 0 && mark.offsetHeight > 0)
      };
    });

    if (metrics.bodyTextLength < 20 || metrics.cardWidth < 260 || metrics.cardHeight < 260 || !metrics.markVisible) {
      throw new Error(`${testCase.name}: login screen failed visual sanity check ${JSON.stringify(metrics)}`);
    }
    if (metrics.theme !== testCase.theme) {
      throw new Error(`${testCase.name}: expected ${testCase.theme} theme, got ${metrics.theme ?? "unset"}`);
    }
    const channelValues = metrics.background.match(/\d+/g)?.slice(0, 3).map(Number) ?? [];
    const brightness = channelValues.length === 3
      ? (channelValues[0] + channelValues[1] + channelValues[2]) / 3
      : 0;
    if (testCase.theme === "light" && brightness < 160) {
      throw new Error(`${testCase.name}: expected light background, got ${metrics.background}`);
    }
    if (testCase.theme === "dark" && brightness > 80) {
      throw new Error(`${testCase.name}: expected dark background, got ${metrics.background}`);
    }

    const screenshotPath = join(outDir, `${testCase.name}.png`);
    const screenshot = await page.screenshot({ path: screenshotPath, fullPage: true });
    if (screenshot.byteLength < 10_000) {
      throw new Error(`${testCase.name}: screenshot too small (${screenshot.byteLength} bytes)`);
    }
    console.log(`${testCase.name}: ${screenshotPath}`);
    await context.close();
  }
} finally {
  await browser.close();
}
