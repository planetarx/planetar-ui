import type { ConsoleMessage, Page } from '@playwright/test';
import { test, expect, openApp } from './fixtures';

function attachConsoleCapture(page: Page) {
  const errors: string[] = [];
  const warns: string[] = [];
  page.on('console', (msg: ConsoleMessage) => {
    if (msg.type() === 'error') errors.push(msg.text());
    if (msg.type() === 'warning') warns.push(msg.text());
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return { errors, warns };
}

/**
 * Deterministically register the vessel-477123400 ("KESTREL III") channel by
 * publishing a `vessel.ais.fleet` "appeared" event straight to the bridge.
 * planetar-ais's mock broadcasts a moored vessel only every ~3 min (ITU-R),
 * so waiting on its natural cadence made these tests flaky.
 */
async function seedVesselChannel(page: Page): Promise<void> {
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:9100');
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'publish',
          envelope: {
            topic: 'vessel.ais.fleet',
            source: 'test-fixture',
            schemaName: 'vessel.ais.Fleet.v1',
            payload: {
              event: 'appeared',
              mmsi: 477123400,
              channelId: 'pac-v-477123400',
              channelName: 'vessel-477123400',
              serverId: 'pac',
              topic: 'chat.pac.vessel-477123400',
              vessel: {
                mmsi: 477123400, name: 'KESTREL III', type: 'fishing',
                flag: 'HK', lat: 48.43, lon: -123.37, sog: 8.1, cog: 37,
              },
            },
          },
        }));
        setTimeout(() => { ws.close(); resolve(); }, 250);
      };
      ws.onerror = () => reject(new Error('bridge ws failed'));
    });
  });
}

test('loads without console errors and renders the shell', async ({ page }) => {
  const { errors } = attachConsoleCapture(page);
  await openApp(page);
  await expect(page.locator('.app')).toBeVisible();
  await expect(page.locator('.rail')).toBeVisible();
  await expect(page.locator('.pane').first()).toBeVisible();
  await expect(page.locator('.tabs')).toBeVisible();
  await expect(page.locator('.inspector')).toBeVisible();
  // Give the broker a beat to connect
  await page.waitForTimeout(800);
  expect(errors, errors.join('\n---\n')).toEqual([]);
});

test('connects to the bridge and shows live status', async ({ page }) => {
  await openApp(page);
  // status dot in channel header should not have "offline" class
  const dot = page.locator('.pane-header .status-dot').first();
  await expect(dot).toBeVisible();
  await expect.poll(async () => {
    const cls = await dot.getAttribute('class');
    return cls?.includes('offline') ? 'offline' : 'live';
  }, { timeout: 5000 }).toBe('live');
});

test('receives at least one synthetic envelope on the default channel', async ({ page }) => {
  const { errors } = attachConsoleCapture(page);
  await openApp(page);
  // wait up to 15s (bridge sends hello within ~1s of subscribe)
  await expect(page.locator('.conv-msg')).not.toHaveCount(0, { timeout: 15_000 });
  expect(errors).toEqual([]);
});

test('entity tokens fill the Inspector when clicked', async ({ page }) => {
  await openApp(page);
  // Wait until at least one entity token appears (synthetic phrases include ⟦MMSI ...⟧)
  const token = page.locator('.entity-token').first();
  await expect(token).toBeVisible({ timeout: 20_000 });
  const label = await token.textContent();
  await token.click();
  // Inspector should now show the entity id
  const inspector = page.locator('.inspector');
  await expect(inspector).toContainText('MMSI', { timeout: 2000 }).catch(async () => {
    // fall back: the entity id appears verbatim
    if (label) await expect(inspector).toContainText(label.replace(/[⟦⟧]/g, '').trim());
  });
});

test('publishing a message echoes it back into the stream', async ({ page }) => {
  await openApp(page);
  // wait until input is enabled (bus connected)
  const input = page.locator('#message-input');
  await expect(input).toBeEnabled({ timeout: 5000 });
  const marker = `hello-from-pw-${Date.now()}`;
  await input.fill(marker);
  await input.press('Enter');
  await expect(page.locator('.conv-body', { hasText: marker })).toBeVisible({ timeout: 3000 });
});

test('switching channels swaps the stream', async ({ page }) => {
  await openApp(page);
  // Wait for first channel's stream to populate
  await expect(page.locator('.conv-msg')).not.toHaveCount(0, { timeout: 15_000 });
  // Click sar-detections channel
  await page.locator('.channel-item', { hasText: 'sar-detections' }).click();
  // Conversation header title (scoped to .conversation to avoid the channels pane)
  await expect(page.locator('.conversation .ph-title')).toHaveText('sar-detections');
  // Input placeholder reflects the new channel
  await expect(page.locator('#message-input')).toHaveAttribute('placeholder', /sar-detections/);
});

test('keystrokes hide and reveal panes', async ({ page }) => {
  await openApp(page);
  await page.waitForSelector('.app');
  // Hide data pane
  await page.keyboard.press('Control+Shift+D');
  await expect(page.locator('.tabs')).toHaveCount(0);
  // Show again
  await page.keyboard.press('Control+Shift+D');
  await expect(page.locator('.tabs')).toBeVisible();
  // Hide channel list
  await page.keyboard.press('Control+Shift+S');
  await expect(page.locator('.channels-section').first()).toHaveCount(0);
  await page.keyboard.press('Control+Shift+S');
  await expect(page.locator('.channels-section').first()).toBeVisible();
  // Reset
  await page.keyboard.press('Control+Shift+0');
});

test('help overlay toggles', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+Shift+/');
  await expect(page.locator('.help-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.help-panel')).toHaveCount(0);
});

test('Map tab renders the MapLibre canvas at a visible size', async ({ page }) => {
  await openApp(page);
  // The Map tab is the default active tab in the data pane on first load.
  // Ensure the canvas mounted; this is a strong signal that MapLibre + WebGL
  // initialised without error.
  const canvas = page.locator('.map-canvas .maplibregl-canvas');
  await expect(canvas).toBeVisible({ timeout: 8000 });

  // Regression: MapLibre captures container dims at construction. Inside a
  // flex/resizable pane, the canvas used to come up sized to a few pixels and
  // only fixed itself when the divider was dragged. The ResizeObserver in
  // MapTab now grows it on first frame. Assert it's actually visible-sized.
  await expect.poll(async () => {
    const box = await canvas.boundingBox();
    return box ? Math.min(box.width, box.height) : 0;
  }, { timeout: 5_000 }).toBeGreaterThan(100);
});

test('Map tab receives at least one vessel from vessel.ais.position when AIS is running', async ({ page }) => {
  await openApp(page);
  // The visible legend overlay was removed; .map-tab carries an invisible
  // data-vessel-count attribute so the ingest path stays test-observable.
  // If planetar-ais isn't running this times out — the message says so.
  await expect.poll(async () => {
    const v = await page.locator('.map-tab').getAttribute('data-vessel-count');
    return v ? Number(v) : 0;
  }, { timeout: 15_000, message: 'no vessel envelopes on vessel.ais.position — is planetar-ais running?' }).toBeGreaterThan(0);
});

test('Inspector "Open channel" switches the conversation to the vessel channel', async ({ page }) => {
  await openApp(page);

  // Precondition: the fleet listener must register the vessel channel before
  // the Inspector button can appear. Seed it deterministically.
  await seedVesselChannel(page);
  await expect(
    page.locator('.channel-item').filter({ hasText: 'vessel-477123400' }),
  ).toBeVisible({ timeout: 5_000 });

  // Publish a chat message with an embedded MMSI entity token, then click it.
  const input = page.locator('#message-input');
  await expect(input).toBeEnabled({ timeout: 5_000 });
  await input.fill('check ⟦MMSI 477123400⟧');
  await input.press('Enter');

  const token = page.locator('.entity-token').filter({ hasText: 'MMSI 477123400' }).first();
  await expect(token).toBeVisible({ timeout: 5_000 });
  await token.click();

  await expect(page.locator('.inspector')).toContainText('477123400');

  const openBtn = page.locator('.inspector-action').filter({ hasText: 'Open channel' });
  await expect(openBtn).toBeVisible({ timeout: 5_000 });
  await openBtn.click();

  // Conversation header now points at the vessel channel.
  await expect(page.locator('.conversation .ph-title')).toHaveText('vessel-477123400');

  // Same button, when the current channel is already the vessel one, becomes
  // disabled and re-labels.
  await expect(page.locator('.inspector-action')).toBeDisabled();
  await expect(page.locator('.inspector-action')).toContainText('viewing this channel');
});

test('Map drag disables follow-mode, Recenter button restores it', async ({ page }) => {
  await openApp(page);

  // Establish a selection so follow-mode has something to track. Seed the
  // KESTREL III channel deterministically, then publish its MMSI token.
  await seedVesselChannel(page);
  await expect(
    page.locator('.channel-item').filter({ hasText: 'vessel-477123400' }),
  ).toBeVisible({ timeout: 5_000 });

  const input = page.locator('#message-input');
  await expect(input).toBeEnabled({ timeout: 5_000 });
  await input.fill('look at ⟦MMSI 477123400⟧');
  await input.press('Enter');

  const token = page.locator('.entity-token').filter({ hasText: 'MMSI 477123400' }).first();
  await expect(token).toBeVisible({ timeout: 5_000 });
  await token.click();
  // Inspector populates, follow-mode is engaged → no button yet.
  await expect(page.locator('.inspector')).toContainText('477123400');
  await expect(page.locator('.map-recenter')).toHaveCount(0);

  // Drag the canvas. MapLibre fires 'movestart' with an `originalEvent`,
  // tripping the follow-mode-off handler.
  const canvas = page.locator('.maplibregl-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('canvas has no bounding box');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 120, cy + 80, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator('.map-recenter')).toBeVisible({ timeout: 2_000 });

  // Click Recenter → follow re-engages, button hides again.
  await page.locator('.map-recenter').click();
  await expect(page.locator('.map-recenter')).toHaveCount(0, { timeout: 2_000 });
});

test('Map canvas stays square after "Open channel" (no horizontal stretch)', async ({ page }) => {
  await openApp(page);

  await seedVesselChannel(page);
  await expect(
    page.locator('.channel-item').filter({ hasText: 'vessel-477123400' }),
  ).toBeVisible({ timeout: 5_000 });

  // Select the vessel + open its channel — this is the exact gesture that
  // historically left the canvas internal width frozen while the data pane's
  // CSS width grew, producing horizontally-stretched ovals.
  const input = page.locator('#message-input');
  await expect(input).toBeEnabled({ timeout: 5_000 });
  await input.fill('look at ⟦MMSI 477123400⟧');
  await input.press('Enter');
  const token = page.locator('.entity-token').filter({ hasText: 'MMSI 477123400' }).first();
  await expect(token).toBeVisible({ timeout: 5_000 });
  await token.click();
  const openBtn = page.locator('.inspector-action').filter({ hasText: 'Open channel' });
  await expect(openBtn).toBeVisible({ timeout: 5_000 });
  await openBtn.click();
  await expect(page.locator('.conversation .ph-title')).toHaveText('vessel-477123400');

  // The canvas internal width should equal its CSS width × devicePixelRatio
  // (within a few px of rounding). Anything else means MapLibre captured
  // dimensions before the layout settled.
  await expect.poll(async () => {
    return page.evaluate(() => {
      const c = document.querySelector('.maplibregl-canvas') as HTMLCanvasElement | null;
      if (!c) return { ok: false, ratio: 0, internal: 0, css: 0 };
      const css = c.getBoundingClientRect().width;
      const internal = c.width;
      const expected = css * (window.devicePixelRatio || 1);
      const ratio = expected > 0 ? internal / expected : 0;
      return { ok: Math.abs(1 - ratio) < 0.05, ratio, internal, css };
    });
  }, { timeout: 4_000, message: 'canvas internal width drifted from CSS width — stretching expected' }).toMatchObject({ ok: true });
});

test('chat holds scroll position when scrolled up; pill jumps to bottom', async ({ page }) => {
  await openApp(page);
  const input = page.locator('#message-input');
  await expect(input).toBeEnabled({ timeout: 5_000 });

  // Build enough message height to make the stream scrollable.
  for (let i = 0; i < 30; i++) {
    await input.fill(`scroll-test line ${i}`);
    await input.press('Enter');
  }
  await expect(
    page.locator('.conv-body', { hasText: 'scroll-test line 29' }),
  ).toBeVisible({ timeout: 6_000 });

  const stream = page.locator('.conv-stream');
  expect(await stream.evaluate((el) => el.scrollHeight > el.clientHeight + 50)).toBe(true);

  // Scroll to the top — disengages bottom-follow.
  await stream.evaluate((el) => { el.scrollTop = 0; });
  await page.waitForTimeout(80); // let the scroll listener run

  // Publish from an independent WS connection: our own sends snap back to the
  // bottom, so we need a message that arrives while we stay scrolled up.
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:9100');
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'publish',
          envelope: {
            topic: 'chat.pac.ais-anomalies',
            source: 'scroll-test-bot',
            schemaName: 'chat.v1.Message',
            payload: { text: 'external scroll-test message', author: { id: 'bot', name: 'bot' } },
          },
        }));
        setTimeout(() => { ws.close(); resolve(); }, 250);
      };
      ws.onerror = () => reject(new Error('bridge ws failed'));
    });
  });

  // Pill appears; the stream did NOT force-scroll.
  const pill = page.locator('.conv-jump');
  await expect(pill).toBeVisible({ timeout: 5_000 });
  await expect(pill).toContainText(/new message/);
  expect(await stream.evaluate((el) => el.scrollTop)).toBeLessThan(150);

  // Click the pill → jump to bottom, pill clears.
  await pill.click();
  await expect(pill).toHaveCount(0);
  expect(
    await stream.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight),
  ).toBeLessThan(100);
});

test('Map layer control renders and ingests a detection stream', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('.map-canvas .maplibregl-canvas')).toBeVisible({ timeout: 8000 });

  // One toggle row per layer: Vessels / SAR / Tracks / Hydrophones.
  await expect(page.locator('.map-layer-row')).toHaveCount(4);

  // Publish an acoustic.detect envelope from an independent WS connection so
  // the hydrophone layer's count climbs deterministically.
  await page.evaluate(() => {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:9100');
      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'publish',
          envelope: {
            topic: 'acoustic.detect',
            source: 'test-fixture',
            schemaName: 'planetar.acoustic.detect',
            payload: {
              clip_id: 'TEST-01:1', site_code: 'TEST-01', site_name: 'Test Site',
              lat: 48.5, lon: -123.4, network: 'TEST', source: 'test://',
              start_ns: 1, dur_s: 4, snr_db: 9, band_hz: [100, 4000],
              peak_freq_hz: 1000, detected: true,
            },
          },
        }));
        setTimeout(() => { ws.close(); resolve(); }, 250);
      };
      ws.onerror = () => reject(new Error('bridge ws failed'));
    });
  });

  await expect.poll(async () => {
    const v = await page.locator('.map-tab').getAttribute('data-acoustic-count');
    return v ? Number(v) : 0;
  }, { timeout: 5_000, message: 'acoustic.detect did not reach the detections store' }).toBeGreaterThan(0);

  // Toggling a layer checkbox flips its state.
  const sarToggle = page.locator('.map-layer-row').filter({ hasText: 'SAR detections' }).locator('input');
  await expect(sarToggle).toBeChecked();
  await sarToggle.uncheck();
  await expect(sarToggle).not.toBeChecked();
});
