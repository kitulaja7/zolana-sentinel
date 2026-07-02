import { setTimeout as sleep } from 'node:timers/promises';
import { config } from './config.js';
import { logger } from './logger.js';

// 2captcha Cloudflare Turnstile solver. Dormant by default — the Zolana API is
// wallet-signed (not browser-gated), so a challenge is rare. If the client ever hits
// a Cloudflare Turnstile page, this returns a token to pass through. Requires the
// page URL + sitekey (scraped from the challenge HTML).
export function captchaEnabled() {
  return Boolean(config.ZOLANA_2CAPTCHA_KEY);
}

// Extract the Turnstile sitekey from a challenge HTML page, if present.
export function extractSitekey(html) {
  const m = /data-sitekey=["']([^"']+)["']/i.exec(html || '')
    || /sitekey["']?\s*[:=]\s*["']([^"']+)["']/i.exec(html || '');
  return m?.[1] || null;
}

// Solve a Turnstile challenge via 2captcha. Returns the token string or null.
export async function solveTurnstile(pageUrl, sitekey) {
  if (!captchaEnabled() || !sitekey) return null;
  const key = config.ZOLANA_2CAPTCHA_KEY;
  try {
    const inRes = await fetch('https://2captcha.com/in.php', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        key, method: 'turnstile', sitekey, pageurl: pageUrl, json: '1',
      }),
    }).then((r) => r.json());
    if (inRes.status !== 1) { logger.warn({ err: inRes.request }, '2captcha submit failed'); return null; }
    const id = inRes.request;

    // Poll for the result (Turnstile usually solves in ~10-30s).
    for (let i = 0; i < 24; i += 1) {
      await sleep(5000);
      const out = await fetch(`https://2captcha.com/res.php?key=${key}&action=get&id=${id}&json=1`)
        .then((r) => r.json());
      if (out.status === 1) return out.request;
      if (out.request !== 'CAPCHA_NOT_READY') { logger.warn({ err: out.request }, '2captcha solve failed'); return null; }
    }
  } catch (error) {
    logger.warn({ message: error.message }, '2captcha error');
  }
  return null;
}
