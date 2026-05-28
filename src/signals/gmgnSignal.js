import { fetchGmgnMarketSignals, gmgnBackoffActive } from '../enrichment/gmgn.js';
import { now, pruneSeen } from '../utils.js';
import { storeSignalEvent } from './trending.js';

const seenSignals = new Map();
let candidateHandler = null;

export function setSmartSignalHandler(fn) {
  candidateHandler = fn;
}

export async function fetchGmgnSmartSignals() {
  if (!candidateHandler) return;
  if (gmgnBackoffActive('token')) return;

  const signals = await fetchGmgnMarketSignals({ mcMin: 5000, mcMax: 2000000 });
  if (!signals.length) return;

  pruneSeen(seenSignals, 10 * 60 * 1000);
  let triggered = 0;

  for (const signal of signals) {
    const mint = signal?.token_address;
    if (!mint || !String(mint).endsWith('pump')) continue;

    // Deduplicate per 5-minute bucket
    const bucket = Math.floor(now() / (5 * 60 * 1000));
    const key = `gmgn_signal:${mint}:${bucket}`;
    if (seenSignals.has(key)) continue;
    seenSignals.set(key, now());

    const trendingToken = {
      address: mint,
      mint,
      market_cap: Number(signal?.market_cap || signal?.trigger_mc || 0),
      volume: Number(signal?.cur_data?.volume ?? 0),
      swaps: Number(signal?.cur_data?.swaps ?? 0),
      signal_times: Number(signal?.signal_times || 1),
      trigger_mc: Number(signal?.trigger_mc || 0),
      seenAt: now(),
      source: 'gmgn_smart_signal',
    };

    storeSignalEvent(mint, 'gmgn_smart_signal', 'gmgn_signal_type_12', signal);
    triggered++;

    await candidateHandler({ mint, trendingToken, route: 'gmgn_smart_signal' });
  }

  console.log(`[gmgn:signal] ${signals.length} signals, ${triggered} new`);
}
