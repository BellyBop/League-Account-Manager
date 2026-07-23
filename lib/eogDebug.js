'use strict';

// Debug aid for the LCU integration. eog-stats-block was originally
// investigated as a possible source of real per-game LP, but inspecting a
// real captured block confirmed it carries no LP or ranked-tier field at
// all (just combat stats and XP/IP rewards) — see
// lib/leagueClientApi.js's computeRankedLpDelta for where that number
// actually comes from instead (diffing current-ranked-stats before/after).
// This snapshot capture is kept around as a general debugging aid for the
// LCU integration, not because eog-stats-block still has an open question.

const path = require('path');
const { writeJson, readJson, dataDir } = require('./store');

const eogDebugPath = () => path.join(dataDir(), 'lastEogDebug.json');

function saveEogDebugSnapshot(eogStats) {
  try {
    writeJson(eogDebugPath(), { capturedAt: new Date().toISOString(), eogStats });
  } catch (e) {
    // Best-effort only — never let a debug capture break the real feature.
  }
}

// A rolling log of every gameflow phase actually observed (not just
// transitions), so if a game end still isn't caught, there's something to
// inspect afterward — did polling stop happening, run too slowly, or skip
// straight over EndOfGame between two samples — rather than guessing again.
const phaseTracePath = () => path.join(dataDir(), 'phaseTrace.json');
const MAX_TRACE_ENTRIES = 80; // ~20 min of history at a 15s poll interval

function appendPhaseTrace(phase) {
  try {
    const trace = readJson(phaseTracePath(), []);
    trace.push({ t: new Date().toISOString(), phase });
    while (trace.length > MAX_TRACE_ENTRIES) trace.shift();
    writeJson(phaseTracePath(), trace);
  } catch (e) {
    // Best-effort only.
  }
}

module.exports = { saveEogDebugSnapshot, appendPhaseTrace };
