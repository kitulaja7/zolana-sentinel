import fs from 'node:fs';
import { config } from './config.js';

function main() {
  const har = JSON.parse(fs.readFileSync(config.ZOLANA_HAR_PATH, 'utf8'));
  const entries = har.log.entries || [];
  const api = entries.filter((entry) => entry.request.url.includes('play.zolana.gg/api/'));
  const grouped = new Map();

  for (const entry of api) {
    const url = new URL(entry.request.url);
    const key = `${entry.request.method} ${url.pathname}`;
    const current = grouped.get(key) || { count: 0, statuses: {}, samples: [] };
    current.count += 1;
    current.statuses[entry.response.status] = (current.statuses[entry.response.status] || 0) + 1;
    if (current.samples.length < 3) {
      current.samples.push({
        query: Object.fromEntries(url.searchParams),
        body: entry.request.postData?.text ? safeJson(entry.request.postData.text) : null,
        response: entry.response.content?.text ? safeJson(entry.response.content.text) : null,
      });
    }
    grouped.set(key, current);
  }

  const report = [...grouped.entries()]
    .sort((a, b) => b[1].count - a[1].count)
    .map(([endpoint, info]) => ({ endpoint, ...info }));

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync('data/har-summary.json', JSON.stringify(report, null, 2));
  console.log(`Wrote data/har-summary.json (${report.length} API endpoints)`);
}

function safeJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value.slice(0, 500);
  }
}

main();
