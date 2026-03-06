import path from 'path';
import fs from 'fs';
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';

function serveCorpus(): Plugin {
  const corpusRoot = path.resolve(__dirname, '..', 'public_domain_dump', 'html');
  return {
    name: 'serve-corpus',
    configureServer(server) {
      server.middlewares.use('/corpus', (req, res, next) => {
        const filePath = path.join(corpusRoot, decodeURIComponent(req.url || ''));
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          res.setHeader('Content-Type', 'text/html; charset=utf-8');
          res.setHeader('Access-Control-Allow-Origin', '*');
          fs.createReadStream(filePath).pipe(res);
        } else {
          res.statusCode = 404;
          res.end('Not found');
        }
      });
    },
  };
}

function saveOutput(): Plugin {
  const outputDir = path.resolve(__dirname, 'output');
  return {
    name: 'save-output',
    configureServer(server) {
      server.middlewares.use('/api/save-file', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end('Method not allowed');
          return;
        }
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { filename, content } = JSON.parse(body) as { filename: string; content: string };
            if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
            const filePath = path.join(outputDir, filename);
            fs.writeFileSync(filePath, content, 'utf-8');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ ok: true, path: filePath }));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: String(err) }));
          }
        });
      });
    },
  };
}

export default defineConfig({
  server: {
    port: 3000,
    host: '0.0.0.0',
  },
  plugins: [react(), serveCorpus(), saveOutput()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
