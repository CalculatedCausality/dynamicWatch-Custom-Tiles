#!/usr/bin/env node
// Browser-level check of the offline report modal; valid synthetic JPEG tiles, no auth or network.
import { chromium } from 'playwright';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildReport, tileLayout } from '../../scripts/vexcel-capture.mjs';

const tmp = await mkdtemp(path.join(tmpdir(), 'vexcel-report-ui-'));
const browser = await chromium.launch({ headless: !process.env.HEADED });
try {
  // A 2x2 JPEG, stretched across each synthetic tile. Browser decode checks
  // below catch broken image data even when the report's SVG structure exists.
  const jpeg = '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwCGiiivkj9EP//Z';
  const bytes = Buffer.from(jpeg, 'base64');
  if (!bytes.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])) ||
      !bytes.subarray(-2).equals(Buffer.from([0xff, 0xd9]))) {
    throw new Error('Report fixture is not a complete JPEG');
  }
  const photos = {};
  const directions = ['N', 'E', 'S', 'W', 'Top'];
  for (const [index, dir] of directions.entries()) {
    const photo = { direction: dir, name: `synthetic-${dir}`, date: '2025-01-01',
      width: 1536, height: 1536, pixel: { x: 768, y: 768 } };
    const layout = tileLayout(photo, { maxZoom: true });
    photos[dir] = { ...photo, ...layout, expectedTiles: layout.tiles.length,
      marker: { x: 768 + index * 10, y: 768 },
      tiles: layout.tiles.map(({ x, y }) => ({ x, y, width: 256, height: 256, data: jpeg })) };
  }
  const filename = path.join(tmp, 'report.html');
  await writeFile(filename, buildReport('34 Cottman St, Buderim', {
    lat: -26.68860588, lon: 153.04097284, source: 'ArcGIS',
    matchedAddress: '34 Cottman Street, Buderim',
  }, photos));
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await page.goto(pathToFileURL(filename).href);
  for (const dir of directions) {
    const decoded = await page.locator(`figure[data-direction="${dir}"]`).evaluate(async (figure) => {
      const sources = [...figure.querySelectorAll('svg image')].map((image) => image.getAttribute('href'));
      await Promise.all(sources.map(async (src) => {
        const image = new Image();
        image.src = src;
        await image.decode();
        if (image.naturalWidth !== 2 || image.naturalHeight !== 2) {
          throw new Error(`Unexpected JPEG dimensions: ${image.naturalWidth}x${image.naturalHeight}`);
        }
      }));
      return sources.length;
    });
    if (decoded !== photos[dir].expectedTiles) {
      throw new Error(`${dir} decoded ${decoded} tiles; expected ${photos[dir].expectedTiles}`);
    }
  }
  await page.waitForFunction(() => document.getElementById('result-modal')?.open);
  const modal = page.locator('#result-modal');
  if (!(await modal.locator('svg').count()) ||
      !(await modal.locator('#viewer-title').textContent()).startsWith('N ·')) {
    throw new Error('North photograph was not opened automatically in the result modal');
  }
  const checkDirection = async (dir) => {
    const title = await modal.locator('#viewer-title').textContent();
    const shown = await modal.locator('svg').evaluate((svg) => ({
      tiles: svg.querySelectorAll('image').length,
      markerX: Number(svg.querySelector('circle')?.getAttribute('cx')),
    }));
    if (!title.startsWith(`${dir} ·`) || shown.tiles !== photos[dir].expectedTiles ||
        shown.markerX !== photos[dir].marker.x) {
      throw new Error(`${dir} photo was not displayed in the result modal`);
    }
  };
  await checkDirection('N');
  let dimensions = await modal.locator('svg').evaluate((svg) => ({
    width: svg.getBoundingClientRect().width,
    viewport: document.getElementById('viewer-viewport').clientWidth,
  }));
  if (Math.round(dimensions.width) !== 1536 || dimensions.width <= dimensions.viewport) {
    throw new Error('Native-resolution modal did not start at 1:1 pixels');
  }
  for (const dir of directions.slice(1)) {
    await modal.locator(`button[data-action="${dir}"]`).click();
    await checkDirection(dir);
  }
  await modal.locator('button[data-action="fit"]').click();
  dimensions = await modal.locator('svg').evaluate((svg) => ({
    width: svg.getBoundingClientRect().width,
    viewport: document.getElementById('viewer-viewport').clientWidth,
  }));
  if (Math.abs(dimensions.width - dimensions.viewport) > 1 || dimensions.width >= 1536) {
    throw new Error('Fit did not fit the viewport');
  }
  await modal.locator('button[data-action="E"]').click();
  await checkDirection('E');
  dimensions = await modal.locator('svg').evaluate((svg) => ({
    width: svg.getBoundingClientRect().width,
    viewport: document.getElementById('viewer-viewport').clientWidth,
  }));
  if (Math.abs(dimensions.width - dimensions.viewport) > 1) {
    throw new Error('Fit did not persist when switching directions');
  }
  await modal.locator('button[data-action="actual"]').click();
  if (Math.round(await modal.locator('svg').evaluate((svg) => svg.getBoundingClientRect().width)) !== 1536) {
    throw new Error('1:1 pixels did not restore native resolution');
  }
  await modal.locator('button[data-action="Top"]').click();
  await checkDirection('Top');
  const pendingDownload = page.waitForEvent('download');
  await modal.locator('button[data-action="save"]').click();
  const download = await pendingDownload;
  if (!download.suggestedFilename().endsWith('-Top.svg')) throw new Error('Incorrect image filename');
  const file = path.join(tmp, 'saved.svg');
  await download.saveAs(file);
  const saved = await readFile(file, 'utf8');
  if (!saved.includes('data:image/jpeg;base64,') || !saved.includes('<svg')) {
    throw new Error('Downloaded SVG has no embedded JPEG');
  }
  await modal.locator('button[data-action="close"]').click();
  if (await modal.evaluate((dialog) => dialog.open)) throw new Error('Modal did not close');
  await page.locator('figure[data-direction="W"] button.inspect').click();
  if (!(await modal.evaluate((dialog) => dialog.open))) throw new Error('West inspection did not reopen the result modal');
  await checkDirection('W');
  console.log('Vexcel report: five-view JPEG decode, modal auto-open, switch, fit, 1:1, save image and reopen passed');
} finally {
  await browser.close();
  await rm(tmp, { recursive: true, force: true });
}
