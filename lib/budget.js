'use strict';
// Token-budget fitting for factmesh's prompt injection. Estimation is chars/4 — the standard rough
// heuristic; deliberately conservative is impossible (chars/4 UNDERestimates on dense text), so callers
// should treat the budget as approximate and leave headroom. Zero-dependency, no tokenizer.

function estimateTokens(s) {
  return Math.ceil(String(s == null ? '' : s).length / 4);
}

// Greedy fit: walk the fact lines (already rank-ordered by Lichen's retrieval) and keep them while they fit.
// A single line that doesn't fit whole is truncated to the remaining budget with an ellipsis rather than
// dropped, so a small budget still yields partial context. Returns { lines, usedTokens, dropped }.
function fitBudget(lines, budgetTokens) {
  const out = [];
  let used = 0;
  let dropped = 0;
  const budget = Math.max(0, budgetTokens | 0);
  for (const line of lines || []) {
    const cost = estimateTokens(line);
    if (used + cost <= budget) {
      out.push(line);
      used += cost;
    } else {
      const remaining = budget - used;
      if (remaining >= 8) { // fewer than ~8 tokens left isn't worth a fragment
        out.push(String(line).slice(0, remaining * 4 - 1) + '…');
        used = budget;
      } else {
        dropped++;
      }
      break; // rank-ordered: once we're full, the rest only get less relevant
    }
  }
  dropped += Math.max(0, (lines || []).length - out.length - dropped);
  return { lines: out, usedTokens: used, dropped };
}

module.exports = { estimateTokens, fitBudget };
