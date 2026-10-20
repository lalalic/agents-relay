import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const FILE = fileURLToPath(new URL('../skills/agents-relay/troubleshooter-qa.md', import.meta.url));
const qaHash = (content: string): string => createHash('sha256').update(content).digest('hex');

export async function handleTroubleshooterQa(req: IncomingMessage, res: ServerResponse): Promise<void> {
      try {
        const current = await readFile(FILE, 'utf8');
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ text: current, hash: qaHash(current) }));
          return;
        }
        if (req.method === 'PUT') {
          if (req.headers['content-type']?.split(';')[0] !== 'application/json') { res.writeHead(415); res.end('Expected JSON'); return; }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of req) {
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > 128 * 1024) { res.writeHead(413); res.end('Q&A too large'); return; }
            chunks.push(buffer);
          }
          const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!body || typeof body !== 'object' || !('text' in body) || !('hash' in body) || typeof body.text !== 'string' || typeof body.hash !== 'string') { res.writeHead(400); res.end('Invalid Q&A payload'); return; }
          if (body.hash !== qaHash(current)) { res.writeHead(409); res.end('Q&A changed on disk; reload before saving'); return; }
          if (Buffer.byteLength(body.text) > 128 * 1024) { res.writeHead(413); res.end('Q&A too large'); return; }
          await writeFile(FILE, body.text, 'utf8');
          res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ hash: qaHash(body.text) }));
          return;
        }
        res.writeHead(405, { allow: 'GET, PUT' }); res.end('Method not allowed');
      } catch (error) {
        res.writeHead(500); res.end(error instanceof Error ? error.message : String(error));
      }
      return;
}
