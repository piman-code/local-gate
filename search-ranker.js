"use strict";

function sanitizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function tokenize(text) {
  return sanitizeText(text)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣_\-/:.\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function overlapScore(queryTokens, targetSet, weight = 1) {
  if (queryTokens.length === 0 || targetSet.size === 0) {
    return 0;
  }
  let hits = 0;
  queryTokens.forEach((token) => {
    if (targetSet.has(token)) {
      hits += 1;
    }
  });
  return hits * weight;
}

function rankContextPackItems(items, options = {}) {
  const query = sanitizeText(options.query || "");
  const topK = Math.max(1, Number(options.topK) || 8);
  const folderWeights = options.folderWeights && typeof options.folderWeights === "object"
    ? options.folderWeights
    : {};

  const queryTokens = tokenize(query);
  const scored = items
    .map((item, index) => {
      const path = sanitizeText(item && item.path);
      const mentionPath = sanitizeText(item && item.mentionPath);
      const preview = sanitizeText(item && item.preview);
      const folderPath = sanitizeText(item && item.folderPath);
      const pathTokens = tokenSet(`${path} ${mentionPath}`);
      const previewTokens = tokenSet(preview);
      const folderBoost = Number(folderWeights[folderPath] || 0);
      const score =
        overlapScore(queryTokens, pathTokens, 2.4) +
        overlapScore(queryTokens, previewTokens, 1.1) +
        folderBoost +
        (queryTokens.length === 0 ? Math.max(0, 1 - index / 200) : 0);
      return { item, score, index };
    })
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      return a.index - b.index;
    });

  const out = [];
  const seen = new Set();
  for (const entry of scored) {
    const key = sanitizeText(entry.item && (entry.item.mentionPath || entry.item.path));
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(entry.item);
    if (out.length >= topK) {
      break;
    }
  }
  return out;
}

function buildFolderWeightMap(folderPaths = []) {
  const cleaned = Array.isArray(folderPaths) ? folderPaths.map((entry) => sanitizeText(entry)).filter(Boolean) : [];
  const out = {};
  cleaned.forEach((folder, index) => {
    out[folder] = Math.max(0.25, 1 - index * 0.08);
  });
  return out;
}

module.exports = {
  buildFolderWeightMap,
  rankContextPackItems,
  tokenize,
};
