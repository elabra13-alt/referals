import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { renderMarketingHomePage } from '../src/modules/links/marketing-template.js';
import { renderLandingPage } from '../src/modules/links/landing-template.js';
import type { LinkPreviewDto } from '../src/modules/links/links.schemas.js';

/** Override with PREVIEW_PORT=xxxx when 3333 is taken (e.g. by a stale preview instance). */
const PORT = Number(process.env.PREVIEW_PORT ?? 3333);

const mockPreview: LinkPreviewDto = {
  link_slug: 'valeria-serum-facial-iluminador-glow',
  creator: {
    name: 'Valeria Skincare',
    handle: 'valeria.skincare',
  },
  product: {
    name: 'Sérum Facial Iluminador Glow',
    price: '650.00',
    currency: 'MXN',
    category: 'beauty',
  },
  status: 'active',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
  const nonce = randomBytes(16).toString('base64');

  // Set CSP headers matching production
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}'`,
      "connect-src 'self'",
      "img-src 'self' data:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ].join('; ')
  );

  // Mock code issuance endpoint
  if (req.method === 'POST' && url.pathname === '/v1/codes/request') {
    let rawBody = '';
    req.on('data', (chunk) => { rawBody += chunk; });
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(201);
      res.end(
        JSON.stringify({
          code: 'REF-VALER-7K2X',
          discount_percent: 15,
          expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
          // Public storefront (what buyers can open), never the merchant admin.
          auto_apply_url: 'https://x7cpq5-z3.myshopify.com/discount/REF-VALER-7K2X',
        })
      );
    });
    return;
  }

  // Buyer landing page
  if (url.pathname.startsWith('/r/')) {
    const html = renderLandingPage(mockPreview, {
      nonce,
      codeRequestUrl: '/v1/codes/request',
    });
    res.writeHead(200);
    res.end(html);
    return;
  }

  // Marketing homepage
  const html = renderMarketingHomePage({
    nonce,
    demoLinkSlug: 'valeria-serum-facial-iluminador-glow',
  });
  res.writeHead(200);
  res.end(html);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n🚀 Servidor de Auditoría Referrals activo en:`);
  console.log(`👉 Homepage:     http://localhost:${PORT}/`);
  console.log(`👉 Landing Demo: http://localhost:${PORT}/r/valeria-serum-facial-iluminador-glow\n`);
});
