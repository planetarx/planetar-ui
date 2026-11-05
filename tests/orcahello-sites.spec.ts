import { test, expect, openApp } from './fixtures';

// OrcaHello detections reach the vic map off the bus (acoustic.orcahello, published by
// planetar-acoustic/orcahello): each hydrophone becomes a site on the Hydrophones layer.
test('an acoustic.orcahello detection puts its hydrophone on the map', async ({ page }) => {
  await openApp(page);
  const map = page.locator('[data-acoustic-count]');
  await expect(map).toHaveAttribute('data-acoustic-count', /\d+/);
  const before = Number(await map.getAttribute('data-acoustic-count'));
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:9100');
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'publish', envelope: { topic: 'acoustic.orcahello', source: 'test-fixture',
          schemaName: 'acoustic.OrcaHello.v1',
          payload: { id: `test-${Date.now()}`, timestamp: new Date().toISOString(), confidence: 50,
            reviewed: false, found: null, tagList: [], audioUri: null, spectrogramUri: null,
            location: { id: 'test_site_playwright', name: 'TEST site', latitude: 48.4, longitude: -123.4 },
            simulated: true } } }));
      setTimeout(() => { ws.close(); resolve(); }, 250);
    };
    ws.onerror = () => reject(new Error('bridge ws failed'));
  }));
  await expect(map).toHaveAttribute('data-acoustic-count', String(before + 1), { timeout: 10_000 });
});
