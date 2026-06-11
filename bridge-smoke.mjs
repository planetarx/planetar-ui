import { WebSocket } from 'ws';
const ws = new WebSocket('ws://127.0.0.1:9100');
let count = 0;
ws.on('open', () => {
  console.log('open');
  ws.send(JSON.stringify({ type: 'subscribe', topics: ['chat.pac.ais-anomalies'] }));
  setTimeout(() => {
    ws.send(JSON.stringify({
      type: 'publish',
      envelope: {
        topic: 'chat.pac.ais-anomalies',
        source: 'smoke-test',
        schemaName: 'chat.v1.Message',
        payload: { text: 'hello from smoke test', author: { id: 'smoke', name: 'smoke' } },
      },
    }));
  }, 600);
});
ws.on('message', (raw) => {
  count++;
  const msg = JSON.parse(raw.toString());
  if (msg.type === 'envelope') {
    const e = msg.envelope;
    console.log(`#${count} ${msg.type}  topic=${e.topic} source=${e.source} text=${e.payload?.text?.slice(0, 60)}`);
  } else {
    console.log(`#${count} ${msg.type}  ${JSON.stringify(msg).slice(0, 80)}`);
  }
  if (count >= 4) { ws.close(); process.exit(0); }
});
ws.on('error', (e) => { console.error('error', e.message); process.exit(1); });
setTimeout(() => { console.log('timeout'); process.exit(2); }, 5000);
