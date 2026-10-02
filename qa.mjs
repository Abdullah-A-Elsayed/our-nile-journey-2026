import { chromium, request } from "playwright";
import fs from "node:fs";

const BASE = "http://127.0.0.1:4173";
const outDir = "qa-artifacts";
fs.mkdirSync(outDir, { recursive: true });

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const browser = await chromium.launch({ headless: true });
const api = await request.newContext({
  ignoreHTTPSErrors: true,
  extraHTTPHeaders: { "User-Agent": "Mozilla/5.0 GitHub-Pages-QA" }
});

const viewports = [
  { name: "mobile", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 }
];

const results = [];

for (const vp of viewports) {
  const context = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
  const page = await context.newPage();

  const pageErrors = [];
  const consoleErrors = [];
  const failedRequests = [];

  page.on("pageerror", e => pageErrors.push(String(e)));
  page.on("console", msg => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("requestfailed", req => {
    failedRequests.push({ url: req.url(), type: req.resourceType(), error: req.failure()?.errorText || "unknown" });
  });

  const response = await page.goto(BASE, { waitUntil: "networkidle", timeout: 60000 });
  assert(response && response.ok(), `${vp.name}: homepage did not return 2xx`);

  // Force all sections into the viewport at least once so CSS background images are requested.
  await page.evaluate(async () => {
    const max = document.documentElement.scrollHeight;
    for (let y = 0; y <= max; y += 500) {
      window.scrollTo(0, y);
      await new Promise(r => setTimeout(r, 40));
    }
    window.scrollTo(0, 0);
  });

  // Wait for all lazy images to decode after scrolling and verify pixels exist.
  await page.waitForTimeout(250);
  const imageDiagnostics = await page.evaluate(async () => {
    const imgs = [...document.querySelectorAll("img")];
    await Promise.all(imgs.map(async img => {
      if (!img.complete) await new Promise(resolve => {
        img.addEventListener("load", resolve, { once:true });
        img.addEventListener("error", resolve, { once:true });
        setTimeout(resolve, 5000);
      });
      try { if (img.decode) await img.decode(); } catch {}
    }));
    return imgs.map(img => ({
      src: img.getAttribute("src"),
      currentSrc: img.currentSrc,
      complete: img.complete,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight
    }));
  });

  for (const img of imageDiagnostics) {
    assert(img.complete, `${vp.name}: image did not finish loading: ${img.src}`);
    assert(img.naturalWidth > 0 && img.naturalHeight > 0, `${vp.name}: image did not decode/render: ${img.src}`);
    assert((img.src || "").startsWith("assets/fast/"), `${vp.name}: runtime image is not using optimized local asset: ${img.src}`);
  }
  const familyImg = imageDiagnostics.find(x => (x.src || "").includes("family-final.webp"));
  assert(familyImg && familyImg.naturalWidth > 0, `${vp.name}: family image is missing or broken`);

  const basic = await page.evaluate(() => {
    const ids = [...document.querySelectorAll("[id]")].map(x => x.id);
    const hashLinks = [...document.querySelectorAll('a[href^="#"]')].map(a => a.getAttribute("href").slice(1));
    const budget = [...document.querySelectorAll("input[data-budget]")].map(i => Number(i.value || 0));
    const nav = [...document.querySelectorAll(".sticky .nav a")].map(a => {
      const r = a.getBoundingClientRect();
      return { text: a.textContent.trim(), left: r.left, right: r.right, width: r.width, height: r.height };
    });
    const bgUrls = [...new Set(
      [...document.querySelectorAll(".hero,.photo,.tile")]
        .flatMap(el => [...getComputedStyle(el).backgroundImage.matchAll(/url\(["']?(.*?)["']?\)/g)].map(m => m[1]))
    )];
    return {
      title: document.title,
      days: document.querySelectorAll(".day").length,
      places: document.querySelectorAll(".tile").length,
      guides: document.querySelectorAll(".guide details").length,
      budgetInputs: budget.length,
      checklist: document.querySelectorAll("input[data-check]").length,
      budgetSum: budget.reduce((a,b) => a+b, 0),
      nav,
      missingTargets: hashLinks.filter(id => !ids.includes(id)),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      bgUrls,
      namesPresent: ["عبد الله","إيمان","رقية","علي"].every(n => document.body.innerText.includes(n))
    };
  });

  assert(basic.title.includes("رحلتنا على النيل"), `${vp.name}: unexpected title`);
  assert(basic.days === 5, `${vp.name}: expected 5 day cards, got ${basic.days}`);
  assert(basic.places === 4, `${vp.name}: expected 4 place tiles, got ${basic.places}`);
  assert(basic.guides === 8, `${vp.name}: expected 8 guide stories, got ${basic.guides}`);
  assert(basic.budgetInputs === 5, `${vp.name}: expected 5 budget inputs`);
  assert(basic.checklist === 5, `${vp.name}: expected 5 checklist inputs`);
  assert(basic.budgetSum === 14000, `${vp.name}: default budget should total 14,000 EGP`);
  assert(basic.missingTargets.length === 0, `${vp.name}: broken internal anchors: ${basic.missingTargets.join(", ")}`);
  assert(basic.overflow <= 1, `${vp.name}: horizontal overflow detected: ${basic.overflow}px`);
  assert(basic.namesPresent, `${vp.name}: family names missing`);
  for (const item of basic.nav) {
    assert(item.width > 0 && item.height > 0, `${vp.name}: hidden nav item ${item.text}`);
    assert(item.left >= -1 && item.right <= vp.width + 1, `${vp.name}: nav item clipped: ${item.text}`);
  }

  // Guide accordions.
  const summaries = page.locator(".guide details summary");
  for (let i = 0; i < await summaries.count(); i++) {
    await summaries.nth(i).click();
    assert(await page.locator(".guide details").nth(i).evaluate(el => el.open), `${vp.name}: guide accordion ${i+1} did not open`);
  }

  // Budget calculation + persistence.
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  const firstBudget = page.locator('input[data-budget]').first();
  await firstBudget.fill("4000");
  await page.waitForTimeout(50);
  assert(await firstBudget.inputValue() === "4000", `${vp.name}: budget field did not update`);
  assert(await page.locator("#budgetState").innerText() === "داخل الميزانية ✓", `${vp.name}: budget state incorrect at 15,000`);
  await page.reload({ waitUntil: "domcontentloaded" });
  assert(await page.locator('input[data-budget]').first().inputValue() === "4000", `${vp.name}: budget localStorage persistence failed`);

  // Checklist persistence.
  const firstCheck = page.locator('input[data-check]').first();
  await firstCheck.check();
  await page.reload({ waitUntil: "domcontentloaded" });
  assert(await page.locator('input[data-check]').first().isChecked(), `${vp.name}: checklist localStorage persistence failed`);

  // Verify every background image endpoint directly.
  const imageChecks = [];
  for (const url of basic.bgUrls) {
    const r = await api.get(url, { timeout: 30000 });
    imageChecks.push({ url, status: r.status(), ok: r.ok() });
    assert(r.ok(), `${vp.name}: image failed HTTP check: ${r.status()} ${url}`);
  }

  const imageRequestFailures = failedRequests.filter(x => x.type === "image");
  assert(imageRequestFailures.length === 0, `${vp.name}: browser image request failures: ${JSON.stringify(imageRequestFailures)}`);
  assert(pageErrors.length === 0, `${vp.name}: page JS errors: ${pageErrors.join(" | ")}`);

  await page.screenshot({ path: `${outDir}/${vp.name}.png`, fullPage: true });
  results.push({
    viewport: vp,
    overflowPx: basic.overflow,
    navItems: basic.nav.map(x => x.text),
    imageChecks,
    consoleErrors,
    pageErrors,
    failedRequests,
    imageDiagnostics
  });

  await page.evaluate(() => localStorage.clear());
  await context.close();
}

fs.writeFileSync(`${outDir}/qa-results.json`, JSON.stringify(results, null, 2));
console.log("QA PASSED");
console.log(JSON.stringify(results.map(r => ({
  viewport: r.viewport.name,
  overflowPx: r.overflowPx,
  images: r.imageChecks.map(i => i.status),
  consoleErrors: r.consoleErrors.length,
  failedRequests: r.failedRequests.length
})), null, 2));

await api.dispose();
await browser.close();
