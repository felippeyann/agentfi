/**
 * End-to-end over the real stdio transport: start `src/index.ts` as a child
 * process, speak JSON-RPC on stdin, and check that (a) every stdout line is a
 * JSON-RPC message — nothing else may be written there — and (b) tools/list
 * carries the annotations.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TOOL_ANNOTATIONS } from '../annotations.js';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

interface RpcMessage {
  jsonrpc: string;
  id?: number;
  result?: { tools?: Array<{ name: string; annotations?: unknown }> };
}

describe('stdio transport', () => {
  it('keeps stdout pure JSON-RPC and lists annotated tools', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx/esm', 'src/index.ts'], {
      cwd: packageDir,
      env: {
        ...process.env,
        MCP_TRANSPORT: 'stdio',
        AGENTFI_API_URL: 'http://agentfi-backend.test-net:3000',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const lines: string[] = [];
    let buffer = '';
    const listed = new Promise<RpcMessage>((resolvePromise, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout; stdout so far: ${lines.join('\n')}`)), 20_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        let newline = buffer.indexOf('\n');
        while (newline >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) {
            lines.push(line);
            const message = JSON.parse(line) as RpcMessage;
            if (message.id === 2) {
              clearTimeout(timer);
              resolvePromise(message);
            }
          }
          newline = buffer.indexOf('\n');
        }
      });
      child.on('error', reject);
    });

    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'stdio-test', version: '0' } },
    });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

    try {
      const response = await listed;
      for (const line of lines) {
        expect(() => JSON.parse(line), line).not.toThrow();
        expect((JSON.parse(line) as RpcMessage).jsonrpc).toBe('2.0');
      }
      const tools = response.result?.tools ?? [];
      expect(tools).toHaveLength(Object.keys(TOOL_ANNOTATIONS).length);
      for (const tool of tools) {
        expect(tool.annotations, tool.name).toEqual(TOOL_ANNOTATIONS[tool.name as keyof typeof TOOL_ANNOTATIONS]);
      }
    } finally {
      child.kill();
    }
  }, 30_000);
});
