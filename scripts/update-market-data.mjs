import { readFile, writeFile } from 'node:fs/promises';

const endpoint = 'https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList';
const sourceUrl = 'https://stockapp.finance.qq.com/';
const pageSize = 200;

async function fetchPage(offset) {
  const url = new URL(endpoint);
  Object.entries({
    _appver: '11.17.0', board_code: 'aStock', sort_type: 'priceRatio',
    direct: 'down', offset: String(offset), count: String(pageSize)
  }).forEach(([key, value]) => url.searchParams.set(key, value));
  const response = await fetch(url, { headers: { 'User-Agent': 'market-temperature/1.0' } });
  if (!response.ok) throw new Error(`腾讯排行接口返回 HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.code !== 0 || !Array.isArray(payload.data?.rank_list)) {
    throw new Error(`腾讯排行接口异常：${payload.msg || payload.code}`);
  }
  return payload.data;
}

async function fetchAllStocks() {
  const first = await fetchPage(0);
  const offsets = [];
  for (let offset = pageSize; offset < first.total; offset += pageSize) offsets.push(offset);
  const pages = [];
  for (let i = 0; i < offsets.length; i += 6) {
    pages.push(...await Promise.all(offsets.slice(i, i + 6).map(fetchPage)));
  }
  const rows = [first.rank_list, ...pages.map(page => page.rank_list)].flat();
  const unique = new Map(rows.map(row => [row.code, row]));
  if (unique.size !== first.total) {
    throw new Error(`腾讯数据不完整：应有 ${first.total} 条，实际 ${unique.size} 条`);
  }
  return [...unique.values()];
}

function summarize(rows, definition) {
  const selected = rows.filter(definition.filter);
  const result = { ...definition, total: selected.length, up: 0, down: 0, flat: 0 };
  delete result.filter;
  for (const row of selected) {
    const change = Number(row.zdf);
    if (change > 0) result.up += 1;
    else if (change < 0) result.down += 1;
    else result.flat += 1;
  }
  result.temperature = result.down ? (result.up - result.down) / result.down : null;
  return result;
}

async function fetchMarketTime() {
  try {
    const response = await fetch('https://qt.gtimg.cn/?q=sh000001');
    const text = new TextDecoder('gbk').decode(await response.arrayBuffer());
    const timestamp = text.split('~')[30];
    if (!/^\d{14}$/.test(timestamp)) return null;
    return `${timestamp.slice(0, 4)}-${timestamp.slice(4, 6)}-${timestamp.slice(6, 8)}T${timestamp.slice(8, 10)}:${timestamp.slice(10, 12)}:${timestamp.slice(12, 14)}+08:00`;
  } catch {
    return null;
  }
}

const rows = await fetchAllStocks();
const definitions = [
  { key: 'shanghai', name: '上证', short: '上证', code: 'SSE', desc: '沪市主板（不含科创板）', filter: row => row.stock_type === 'GP-A' && row.code.startsWith('sh') },
  { key: 'star', name: '科创板', short: '科创', code: 'STAR', desc: '科创板个股涨跌广度', filter: row => row.stock_type === 'GP-A-KCB' },
  { key: 'chinext', name: '创业板', short: '创业', code: 'CHINEXT', desc: '创业板个股涨跌广度', filter: row => row.stock_type === 'GP-A-CYB' }
];
const data = {
  source: '腾讯财经',
  source_url: sourceUrl,
  generated_at: new Date().toISOString(),
  market_time: await fetchMarketTime(),
  total_records: rows.length,
  formula: '(上涨家数-下跌家数)/下跌家数',
  markets: definitions.map(definition => summarize(rows, definition))
};

const outputPath = new URL('../market-data.json', import.meta.url);
if (process.env.FORCE_UPDATE !== 'true') {
  try {
    const previous = JSON.parse(await readFile(outputPath, 'utf8'));
    if (data.market_time && previous.market_time === data.market_time) {
      console.log(`行情日期未变化（${data.market_time}），今天不是交易日或收盘数据已保存，跳过写入。`);
      process.exit(0);
    }
  } catch {
    // 首次运行或旧文件不可读时正常生成。
  }
}
await writeFile(outputPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(data, null, 2));
