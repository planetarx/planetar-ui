/*
 * Flow tab — observed topology, particles, and click-to-trace.
 *
 * Publishes a three-envelope causation chain (frame → detection → chat)
 * through the bridge WS, then asserts the graph derived the topology and the
 * trace panel walks the chain. Works in both bridge modes: with the real
 * broker the chain round-trips the bus; in mock mode the bridge self-echoes.
 */

import { expect, openApp, test } from './fixtures';
import type { Page } from '@playwright/test';

/** Publish envelopes in order, threading each ack id into the next causation. */
async function publishChain(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    return new Promise<string[]>((resolve, reject) => {
      const ws = new WebSocket('ws://127.0.0.1:9100');
      const timer = setTimeout(() => reject(new Error('publish chain timed out')), 8000);
      const specs = [
        { topic: 'eo.frame', schemaName: 'planetar.eo.frame.v1', payload: { source_id: 'cam-test', seq: 1 } },
        { topic: 'eo.detection', schemaName: 'planetar.eo.detection.v1', payload: { source_id: 'cam-test', cls: 'boat', conf: 0.91 } },
        { topic: 'chat.pac.eo-chips', schemaName: 'chat.v1.Message', payload: { text: 'detection over test cam', author: { id: 'agent-eo', name: 'EO Agent' } } },
      ];
      const ids: string[] = [];
      const next = (): void => {
        if (ids.length === specs.length) {
          clearTimeout(timer);
          ws.close();
          resolve(ids);
          return;
        }
        const spec = specs[ids.length];
        ws.send(JSON.stringify({
          type: 'publish',
          envelope: {
            ...spec,
            source: spec.topic.startsWith('chat.') ? 'agent-eo' : 'planetar-eo',
            causationId: ids.length ? ids[ids.length - 1] : '',
          },
        }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data)) as { type: string; id?: string };
        if (msg.type === 'ack' && msg.id) {
          ids.push(msg.id);
          next();
        }
      };
      ws.onopen = next;
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('bridge ws error'));
      };
    });
  });
}

test('flow tab derives topology from published traffic', async ({ page }) => {
  await openApp(page);
  await page.locator('.tab').filter({ hasText: 'Flow' }).click();
  await expect(page.locator('.flow-tab')).toBeVisible();

  await publishChain(page);

  const flow = page.locator('.flow-tab');
  await expect
    .poll(async () => Number(await flow.getAttribute('data-msg-total')), { timeout: 5_000 })
    .toBeGreaterThanOrEqual(3);
  await expect
    .poll(async () => Number(await flow.getAttribute('data-lane-count')), { timeout: 5_000 })
    .toBeGreaterThanOrEqual(2); // eo + chat.pac

  // observed producer node + bus + lanes are on screen
  await expect(page.locator('.flow-producer').filter({ hasText: 'planetar-eo' })).toBeVisible();
  await expect(page.locator('.flow-bus-head')).toContainText('planetar-broker');
  await expect(page.locator('.flow-lane').filter({ hasText: 'eo' }).first()).toBeVisible();

  // structural sinks are always present
  await expect(page.locator('.flow-consumer').filter({ hasText: 'planetar-ui' })).toBeVisible();
  await expect(page.locator('.flow-consumer').filter({ hasText: 'WAL' })).toBeVisible();
});

test('clicking a ticker message opens its causal trace', async ({ page }) => {
  await openApp(page);
  await page.locator('.tab').filter({ hasText: 'Flow' }).click();
  await expect(page.locator('.flow-tab')).toBeVisible();

  const ids = await publishChain(page);
  const tail = ids[ids.length - 1];

  // the chain tail is the newest ticker row
  const row = page.locator('.flow-ticker-row').filter({ hasText: 'chat.pac.eo-chips' }).first();
  await expect(row).toBeVisible({ timeout: 5_000 });
  await row.click();

  await expect(page.locator('.flow-tab')).toHaveAttribute('data-selected-trace', tail);
  const panel = page.locator('.trace-panel');
  await expect(panel).toBeVisible();

  // two ancestors (frame ← detection ← chat), walked from the live buffer
  await expect(panel.locator('.trace-row-marker').filter({ hasText: '↑' })).toHaveCount(2, {
    timeout: 5_000,
  });
  await expect(panel).toContainText('eo.frame');
  await expect(panel).toContainText('eo.detection');

  // hop timeline shows the envelope's own nanosecond clocks
  await expect(panel.locator('.trace-hop')).not.toHaveCount(0);
  await expect(panel).toContainText('created at source');

  // Esc clears the selection and the panel
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(page.locator('.flow-tab')).toHaveAttribute('data-selected-trace', '');
});
