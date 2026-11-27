// Test helper: a port the operating system reports free on 127.0.0.1 (listen on port 0, read the port, close it).
// The test files run in parallel, each with its own Anvil: fixed random ranges could collide with each other, or
// with ports already in use on the machine (a running demo or session).
import { createServer } from 'node:net';

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}
