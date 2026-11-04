import { test, expect, openApp } from './fixtures';

// The "Vessels (AIS)" count must match what the map draws: only the current
// Operation's vessels. The store holds every Operation's fleet (all
// vessel.ais.position goes to every client); on bb that is Victoria + the
// wider orca box, none of it Hormuz.
test('the vessel count on the Hormuz operation leaves out other operations\' vessels', async ({ page }) => {
  await openApp(page);
  await page.locator('.rail-server[title="Strait of Hormuz"]').click();
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:9100');
    ws.onopen = () => {
      const pos = (mmsi: number, lat: number, lon: number, serverId: string) => ws.send(JSON.stringify({
        type: 'publish', envelope: { topic: 'vessel.ais.position', source: 'test-fixture',
          schemaName: 'vessel.ais.Position.v1',
          payload: { mmsi, name: `TEST ${serverId}`, lat, lon, sog: 3, cog: 90,
            lastSeenNs: String(BigInt(Date.now()) * 1_000_000n), serverId, simulated: true } } }));
      pos(999000302, 48.42, -123.37, 'pac'); // another Operation's vessel: in the store, not on this map
      pos(999000301, 26.7, 56.35, 'hormuz');
      setTimeout(() => { ws.close(); resolve(); }, 250);
    };
    ws.onerror = () => reject(new Error('bridge ws failed'));
  }));
  const count = page.locator('.map-layer-row', { hasText: 'Vessels (AIS)' }).locator('.map-layer-count');
  await expect(count).toHaveText('1', { timeout: 10_000 });
  await page.waitForTimeout(1500); // both envelopes in: still only the Hormuz vessel counts
  await expect(count).toHaveText('1');
});
