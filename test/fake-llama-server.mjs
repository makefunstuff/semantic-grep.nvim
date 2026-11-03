#!/usr/bin/env node
// A stand-in for llama.cpp's llama-server in the tests: `--port N` (and `--model FILE`, which must exist), /health
// and an OpenAI-compatible /v1/embeddings with the fake's vectors. It writes its arguments to $FAKE_LLAMA_LOG, a line
// each start, and stops on SIGTERM.
import {appendFileSync, existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {fakeVector} from './fake-embedder.mjs';

const args = process.argv.slice(2);
const flag = name => args[args.indexOf(name) + 1];
if (!existsSync(flag('--model'))) {
  process.stderr.write(`error: failed to load model '${flag('--model')}'\n`);
  process.exit(1);
}
if (process.env.FAKE_LLAMA_LOG) appendFileSync(process.env.FAKE_LLAMA_LOG, `${JSON.stringify({pid: process.pid, args, cuda: process.env.CUDA_VISIBLE_DEVICES ?? null})}\n`);
const server = createServer((request, response) => {
  if (request.url === '/health') {
    response.writeHead(200, {'content-type': 'application/json'});
    return response.end('{"status":"ok"}');
  }
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    const asked = JSON.parse(body || '{}');
    response.writeHead(200, {'content-type': 'application/json'});
    response.end(JSON.stringify({data: asked.input.map((text, index) => ({index, embedding: [...fakeVector(text)]}))}));
  });
});
server.listen(Number(flag('--port')), flag('--host') ?? '127.0.0.1');
process.on('SIGTERM', () => server.close(() => process.exit(0)));
