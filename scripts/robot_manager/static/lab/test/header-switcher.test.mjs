// Optional rendered regression; no dependency installation:
// LAB_PLAYWRIGHT_MODULE=/path/to/playwright LAB_BROWSER=chromium
// LAB_BROWSER_EXECUTABLE=/path/to/browser node --test test/header-switcher.test.mjs
// Repeat with firefox. Real browser zoom is covered by the separate screenshot matrix.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const modulePath = process.env.LAB_PLAYWRIGHT_MODULE;
const executablePath = process.env.LAB_BROWSER_EXECUTABLE;
const mime = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

test(
  'rendered header: bounded switcher, current name, ellipsis and compact labels',
  {
    skip:
      !modulePath || !executablePath
        ? 'set LAB_PLAYWRIGHT_MODULE and LAB_BROWSER_EXECUTABLE for rendered checks'
        : false,
  },
  async (t) => {
    const playwright = createRequire(import.meta.url)(modulePath);
    const server = createServer(async (req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
      if (!file.startsWith(root)) {
        res.writeHead(403).end();
        return;
      }
      try {
        res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
        res.end(await readFile(file));
      } catch {
        res.writeHead(404).end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    let browser;
    try {
      browser = await playwright[process.env.LAB_BROWSER || 'chromium'].launch({
        executablePath,
        headless: true,
      });
      const page = await browser.newPage();
      await page.addInitScript(() => {
        // A loopback-only transport fixture; no robot or running bridge is needed.
        window.WebSocket = class {
          static OPEN = 1;
          constructor(url) {
            if (new URL(url).hostname !== '127.0.0.1') throw Error('loopback only');
            this.readyState = 0;
            setTimeout(() => {
              this.readyState = 1;
              this.onopen?.({});
              this.onmessage?.({
                data: JSON.stringify({
                  type: 'hello',
                  protocol: 1,
                  robot: { name: 'lab-robot-0123456789' },
                  streams: {},
                  read_only: false,
                }),
              });
            }, 0);
          }
          send() {}
          close() {
            this.readyState = 3;
          }
        };
      });
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      for (const width of [1280, 1180, 1091, 1090, 821, 820, 640, 590, 410]) {
        await page.setViewportSize({ width, height: 900 });
        for (const course of ['series', 'rl', 'keymap'])
          await t.test(`${width}px #${course}`, async () => {
            await page.goto(`http://127.0.0.1:${server.address().port}/#${course}`);
            await page.waitForFunction(() =>
              document.querySelector('#courseSwitcher summary').getAttribute('aria-label'),
            );
            await page.evaluate(async () => {
              const link = await import('/js/live/robot-link.js');
              link.connectRobot('ws://127.0.0.1:8897');
            });
            await page.waitForFunction(
              () => !document.querySelector('#labHeaderStop button')?.disabled,
            );
            const expectedOrder = [
              'labHeaderStop',
              'robotLinkOpen',
              ...(course === 'series' ? [] : ['seriesHome']),
              'courseSwitcher',
            ];
            await page.locator('.brand').focus();
            const focused = [];
            for (const _ of expectedOrder) {
              await page.keyboard.press('Tab');
              focused.push(
                await page.evaluate(() => {
                  const e = document.activeElement;
                  return e.closest('#labHeaderStop')?.id || e.id || e.closest('details')?.id;
                }),
              );
            }
            assert.deepEqual(focused, expectedOrder, 'Tab order must follow the visible controls');
            const positions = await page.evaluate(
              (ids) =>
                ids.map((id) => {
                  const e =
                    id === 'courseSwitcher'
                      ? document.querySelector('#courseSwitcher summary')
                      : id === 'labHeaderStop'
                        ? document.querySelector('#labHeaderStop button')
                        : document.getElementById(id);
                  return e.getBoundingClientRect().x;
                }),
              expectedOrder,
            );
            assert(positions.every((x, i) => !i || x > positions[i - 1]));
            assert.equal(
              await page.evaluate(
                () =>
                  matchMedia('(min-width: 601px) and (max-width: 1090.98px)').matches &&
                  matchMedia('(min-width: 1091px)').matches,
              ),
              false,
            );
            if (width >= 1180) {
              assert(
                await page
                  .locator('#robotLinkName')
                  .evaluate((e) => e.clientWidth >= e.scrollWidth),
              );
            }
            const actual = await page.evaluate(() => {
              const header = document.querySelector('.site-header'),
                box = document.querySelector('#courseSwitcher');
              const summary = box.querySelector('summary'),
                title = document.querySelector('#currentCourseTitle');
              const short = box.querySelector('.switcher-short'),
                label = box.querySelector('.switcher-label');
              const rect = (e) => {
                const r = e.getBoundingClientRect();
                return { top: r.top, bottom: r.bottom, height: r.height };
              };
              return {
                header: rect(header),
                box: rect(box),
                summary: rect(summary),
                state: rect(document.querySelector('#liveHeaderStatus')),
                caption: title.textContent,
                title: title.title,
                accessible: summary.getAttribute('aria-label'),
                titleVisible: getComputedStyle(title).display !== 'none',
                shortVisible: getComputedStyle(short).display !== 'none',
                labelVisible: getComputedStyle(label).display !== 'none',
                ellipsis: getComputedStyle(title).textOverflow,
                nowrap: getComputedStyle(title).whiteSpace,
                arrowTop: parseFloat(getComputedStyle(summary, '::after').top),
                arrowLeft:
                  summary.getBoundingClientRect().right -
                  parseFloat(getComputedStyle(summary).borderRightWidth) -
                  parseFloat(getComputedStyle(summary, '::after').right) -
                  parseFloat(getComputedStyle(summary, '::after').width),
                textRight: (getComputedStyle(title).display === 'none'
                  ? short
                  : title
                ).getBoundingClientRect().right,
                clipped: title.scrollWidth > title.clientWidth,
              };
            });
            assert.equal(actual.header.height, width >= 1091 ? 109 : 88);
            assert.equal(actual.box.height, 44);
            assert.equal(actual.summary.height, 44);
            if (width < 1091) assert(actual.box.bottom <= actual.state.top + 0.01);
            assert(actual.shortVisible && !actual.labelVisible);
            assert.equal(actual.titleVisible, width > 820);
            assert.equal(actual.title, actual.caption);
            assert(actual.accessible.includes(actual.caption));
            assert(actual.accessible.includes('教材を切り替える'));
            assert(Math.abs(actual.arrowTop - 22) <= 1);
            assert(actual.textRight + 3 <= actual.arrowLeft, 'text must leave space for the arrow');
            if (width > 820) {
              assert.equal(actual.ellipsis, 'ellipsis');
              assert.equal(actual.nowrap, 'nowrap');
            }
            if (width === 821 && course === 'keymap')
              assert(actual.clipped, 'the real long title is ellipsized');
            await page.locator('#courseSwitcher summary').click();
            assert(await page.locator('#lessonNav').isVisible());
            assert.equal(
              await page.locator('.site-header').evaluate((e) => e.getBoundingClientRect().height),
              width >= 1091 ? 109 : 88,
            );
            assert.equal(
              await page
                .locator('#courseSwitcher')
                .evaluate((e) => e.getBoundingClientRect().height),
              44,
            );
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#courseSwitcher').evaluate((e) => e.open), false);
            if (course !== 'series') {
              await page.locator('#seriesHome').click();
              await page.waitForURL('**/#series');
            }
          });
      }
      assert.deepEqual(errors, []);
    } finally {
      if (browser) await browser.close();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
