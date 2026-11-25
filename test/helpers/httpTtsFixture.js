const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

async function httpTtsFixture(t, reply) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'podcast-http-tts-'));
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const pieces = [];
    for await (const bytes of req) pieces.push(bytes);
    const request = { headers: req.headers, body: JSON.parse(Buffer.concat(pieces)) };
    requests.push(request);
    const resource = req.headers['x-api-resource-id'];
    const speaker = request.body.req_params?.speaker || '';
    if (!speaker.startsWith('S_') && ((resource === 'seed-tts-1.0' && speaker.endsWith('_uranus_bigtts')) ||
        (resource === 'seed-tts-2.0' && /_(?:moon|mars)_bigtts$/.test(speaker)))) {
      res.writeHead(422).end();
      return;
    }
    reply(res, request);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { endpoint: 'http://127.0.0.1:' + server.address().port, outputPath: path.join(dir, 'line.mp3'), requests };
}

module.exports = { httpTtsFixture };
