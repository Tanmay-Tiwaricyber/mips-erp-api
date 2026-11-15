/**
 * serve.js — runs the webapp demo AND mounts erp-proxy.js, so you can see the
 * exact wiring your ERP backend needs.
 *
 *   cd examples/webapp
 *   MIPS_ERP_API_URL=http://localhost:3000 \
 *   MIPS_ERP_USER=2026BT0683 MIPS_ERP_PASS='…' \
 *   node serve.js                     # → http://localhost:4200
 *
 * In your own ERP, the only lines that matter are the two marked "WIRE THIS".
 */
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createErpProxy } from '../server-plugin/erp-proxy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4200);

const app = express();

// WIRE THIS (1/2) — mount the proxy at a path your clients call.
app.use(
  '/api/erp',
  // NOTE: no credentials here. Each user signs in with their OWN user id and
  // password; the proxy maps every token to that one user's ERP session.
  createErpProxy({
    apiBase: process.env.MIPS_ERP_API_URL || 'http://localhost:3000',
  })
);

// WIRE THIS (2/2) — static assets for the frontend (Next/Vite/etc. replace this).
app.use(express.static(__dirname));

app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error('[proxy]', err.code || err.message);
  res.status(status).json({ error: { code: err.code || 'INTERNAL', message: err.message } });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`webapp demo + proxy on http://localhost:${PORT}`);
  console.log(`  upstream API : ${process.env.MIPS_ERP_API_URL || 'http://localhost:3000'}`);
  console.log(`  auth model   : per-user (each visitor enters their own credentials)`);
});
