import { bot } from './bot.js';
import { TELEGRAM_CHAT_ID, TELEGRAM_TOPIC_ID } from '../config.js';
import { now, json, safeJson } from '../utils.js';
import { db } from '../db/connection.js';
import { escapeHtml, fmtPct, fmtSol, fmtUsd, short, gmgnLink } from '../format.js';
import { numSetting } from '../db/settings.js';
import { candidateSummary, compactCandidateLine, batchRevealSummary, formatPosition } from './format.js';
import { candidateButtons, batchRevealButtons, positionButtons, intentButtons } from './menus.js';
import { batchById } from '../db/decisions.js';
import { fetchSolUsdPrice } from '../enrichment/jupiter.js';

export async function sendTelegram(text, extra = {}) {
  return bot.sendMessage(TELEGRAM_CHAT_ID, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...(TELEGRAM_TOPIC_ID ? { message_thread_id: Number(TELEGRAM_TOPIC_ID) } : {}),
    ...extra,
  });
}

export async function sendCandidateAlert(candidateId, candidate, decision) {
  const sent = await sendTelegram(candidateSummary(candidate, decision), candidateButtons(candidateId, decision));
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(candidateId, candidate.token.mint, 'candidate', now(), sent.message_id, json({ candidate, decision }));
}

export async function sendBatchReveal(batchId, rows, decision, triggerCandidateId) {
  const sent = await sendTelegram(
    batchRevealSummary(batchId, rows, decision, triggerCandidateId),
    batchRevealButtons(batchId, rows, decision, triggerCandidateId),
  );
  db.prepare(`
    INSERT INTO alerts (candidate_id, mint, kind, sent_at_ms, telegram_message_id, payload_json)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    triggerCandidateId || null,
    decision.selected_mint || rows.find(row => row.id === Number(triggerCandidateId))?.candidate?.token?.mint || 'batch',
    'batch_reveal',
    now(),
    sent.message_id,
    json({ batchId, candidateIds: rows.map(row => row.id), decision, triggerCandidateId }),
  );
}

export async function sendBatch(chatId, batchId) {
  const batch = batchById(batchId);
  if (!batch) return bot.sendMessage(chatId, 'Batch not found.');
  const lines = [
    '🧭 <b>Screening Batch</b>',
    '',
    `Batch: <b>#${batchId}</b> · Decision: <b>${escapeHtml(batch.verdict)}</b> ${fmtPct(batch.confidence)}`,
    batch.reason ? `Reason: ${escapeHtml(String(batch.reason).slice(0, 500))}` : null,
    '',
    ...batch.rows.map((row, index) => compactCandidateLine(row, index + 1)),
  ];
  const keyboard = batch.rows.slice(0, 10).map((row, index) => ([{
    text: `${index + 1}. ${row.candidate.token?.symbol || short(row.candidate.token?.mint || '')}`,
    callback_data: `cand:${row.id}`,
  }]));
  keyboard.push([{ text: 'Positions', callback_data: 'menu:positions' }]);
  return bot.sendMessage(chatId, lines.filter(Boolean).join('\n'), {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function sendPositionOpen(positionId) {
  const position = db.prepare('SELECT * FROM dry_run_positions WHERE id = ?').get(positionId);
  if (!position) return;
  const label = position.execution_mode === 'live' ? 'Live buy executed' : 'Dry-run buy stored';
  const snapshot = safeJson(position.snapshot_json, {});
  const reason = snapshot?.decision?.reason;
  const confidence = snapshot?.decision?.confidence;
  const reasonLine = reason
    ? `\nReason: ${escapeHtml(String(reason).slice(0, 300))}${confidence != null ? ` (${fmtPct(confidence)} conf)` : ''}`
    : '';
  await sendTelegram(`✅ <b>${label}</b>\n\n${formatPosition(position)}${reasonLine}`, positionButtons(positionId));
}

export async function sendPositionExit(position) {
  const label = position?.execution_mode === 'live' ? 'Live exit' : 'Dry-run exit';
  const snapshot = safeJson(position.snapshot_json, {});
  const entryReason = snapshot?.decision?.reason;
  const lines = [
    `🏁 <b>${label}: ${escapeHtml(position.exitReason || position.exit_reason || '')}</b>`,
    '',
    formatPosition({ ...position, status: 'closed' }),
  ];
  if (entryReason) lines.push(`\nEntry reason: ${escapeHtml(String(entryReason).slice(0, 300))}`);
  await sendTelegram(lines.join('\n'));
}

export async function sendOpenPositionsSummary() {
  const positions = db.prepare(`SELECT * FROM dry_run_positions WHERE status = 'open' ORDER BY opened_at_ms DESC`).all();
  if (!positions.length) return;
  const solUsd = await fetchSolUsdPrice().catch(() => null);
  const totalDeployed = positions.reduce((s, p) => s + Number(p.size_sol || 0), 0);
  const totalCurrent = positions.reduce((p, pos) => {
    const pnl = pos.entry_mcap && pos.high_water_mcap
      ? (Number(pos.high_water_mcap) / Number(pos.entry_mcap) - 1) * 100 : 0;
    return p + Number(pos.size_sol || 0) * (1 + pnl / 100);
  }, 0);
  const totalPnlSol = totalCurrent - totalDeployed;
  const usdLine = solUsd
    ? ` · ~$${(totalCurrent * solUsd).toFixed(0)}`
    : '';
  const lines = [
    `📊 <b>Open Positions (${positions.length})</b>`,
    `Deployed: ${fmtSol(totalDeployed)} SOL · Current: ${fmtSol(totalCurrent)} SOL${usdLine} · Total PnL: ${fmtSol(totalPnlSol)} SOL`,
    '',
  ];
  for (const pos of positions) {
    const snapshot = safeJson(pos.snapshot_json, {});
    const reason = snapshot?.decision?.reason;
    lines.push(formatPosition(pos));
    if (reason) lines.push(`Entry reason: ${escapeHtml(String(reason).slice(0, 200))}`);
    if (solUsd) {
      const pnl = pos.entry_mcap && pos.high_water_mcap
        ? (Number(pos.high_water_mcap) / Number(pos.entry_mcap) - 1) * 100 : 0;
      const currentSol = Number(pos.size_sol || 0) * (1 + pnl / 100);
      lines.push(`Value: ${fmtSol(currentSol)} SOL (~$${(currentSol * solUsd).toFixed(2)})`);
    }
    lines.push('');
  }
  await sendTelegram(lines.join('\n'));
}

export async function sendTradeIntent(intentId, candidate, decision, isDry = false) {
  await sendTelegram([
    isDry ? '🧾 <b>Dry intent awaiting confirmation</b>' : '🧾 <b>Trade intent awaiting confirmation</b>',
    '',
    candidateSummary(candidate, decision),
    '',
    `Size: <b>${fmtSol(numSetting('dry_run_buy_sol', 0.1))} SOL</b>`,
    isDry ? 'Execution: approve to open simulated position (no real swap).' : 'Execution: confirmation required before signing.',
  ].join('\n'), intentButtons(intentId));
}
