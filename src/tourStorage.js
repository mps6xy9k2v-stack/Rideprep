/* global window */
// Saved-tour persistence layer.
//
// Two-key schema (chosen over a single big blob so re-planning one
// tour doesn't rewrite N×100 KB on every save):
//
//   rideprep:savedTours:v1           — index: array<TourMeta>
//   rideprep:savedTour:v1:<id>       — full state per tour (TourBlob)
//
// TourMeta = { id, name, from, to, totalKm, totalAscent, stageCount,
//              startDate, savedAt }
// TourBlob = { tour, geometry, stops, dailyKm, startDate }
//
// Reads return defaults on failure (corrupt JSON, missing key, etc.).
// Writes detect QuotaExceededError and return { ok:false, reason:"quota" }
// so callers can surface a friendly message instead of failing silently.

(() => {

const INDEX_KEY = "rideprep:savedTours:v1";
const BLOB_PREFIX = "rideprep:savedTour:v1:";

// Legacy keys we migrate from. The ridePrep:tours/ridePrep:tour:<id>
// pair was introduced earlier in this PR; ridePrep:tourState was the
// singleton predating multi-tour. The dedupe-flag below stays under the
// old name so we don't re-run the dedup pass after this rename.
const LEGACY_INDEX_KEY = "ridePrep:tours";
const LEGACY_BLOB_PREFIX = "ridePrep:tour:";
const LEGACY_SINGLETON_KEY = "ridePrep:tourState";
const RENAME_FLAG_KEY = "rideprep:savedTours:rename";
const RENAME_FLAG_VALUE = "v1";

function warn(...args) { try { console.warn("[savedTours]", ...args); } catch {} }

function safeGet(key) {
  try { return window.localStorage.getItem(key); }
  catch (e) { warn("getItem failed for", key, e); return null; }
}

function safeSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
    return { ok: true };
  } catch (e) {
    // QuotaExceededError shows up under different names across browsers:
    // - "QuotaExceededError" (most), "QUOTA_EXCEEDED_ERR" (legacy WebKit),
    // - code 22 / 1014, or message containing 'quota'.
    const name = (e && e.name) || "";
    const code = (e && e.code) || 0;
    const isQuota =
      name === "QuotaExceededError" ||
      name === "QUOTA_EXCEEDED_ERR" ||
      code === 22 || code === 1014 ||
      /quota/i.test(String(e && e.message || ""));
    warn(isQuota ? "quota exceeded on" : "setItem failed for", key, e);
    return { ok: false, reason: isQuota ? "quota" : "error", error: e };
  }
}

function safeRemove(key) {
  try { window.localStorage.removeItem(key); }
  catch (e) { warn("removeItem failed for", key, e); }
}

// Notify same-tab listeners that the saved-tours list mutated. The
// browser's `storage` event only fires in OTHER tabs, so the Training
// and Weather tabs need this signal to refresh when the user saves /
// deletes a tour in this same tab. `kind` is one of "save" / "delete" /
// "clear" / "migrate" — receivers usually just refetch the index.
function notify(kind, detail) {
  try {
    window.dispatchEvent(new CustomEvent("rideprep:tour-saved", {
      detail: { kind, ...(detail || {}) },
    }));
  } catch {}
}

function readIndex() {
  const raw = safeGet(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    warn("index JSON parse failed; resetting to empty", e);
    return [];
  }
}

function writeIndex(list) {
  return safeSet(INDEX_KEY, JSON.stringify(list));
}

function readBlob(id) {
  const raw = safeGet(BLOB_PREFIX + id);
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (e) { warn("blob JSON parse failed for", id, e); return null; }
}

function writeBlob(id, blob) {
  return safeSet(BLOB_PREFIX + id, JSON.stringify(blob));
}

function deleteBlob(id) {
  safeRemove(BLOB_PREFIX + id);
}

// ── Migration from older key names ─────────────────────────────────────────
// Runs once per browser. If both old AND new keys exist (e.g. user has
// two tabs open during the upgrade) we prefer the new one.
function migrateFromLegacyKeys() {
  if (safeGet(RENAME_FLAG_KEY) === RENAME_FLAG_VALUE) return;
  try {
    // First, lift the pre-multi-tour singleton — saved tours from way
    // back when there was only one slot.
    const singletonRaw = safeGet(LEGACY_SINGLETON_KEY);
    if (singletonRaw) {
      try {
        const legacy = JSON.parse(singletonRaw);
        if (legacy && legacy.tour && legacy.tour.from && legacy.tour.to) {
          // We don't have a stable ID here without normalizeAddressForId
          // which lives in tour.jsx. Use a synthetic key and let the
          // dedupe pass in tour.jsx merge it later.
          const synthId = `legacy-${Date.now().toString(36)}`;
          const meta = {
            id: synthId,
            name: `${legacy.tour.from} → ${legacy.tour.to}`,
            from: legacy.tour.from,
            to: legacy.tour.to,
            totalKm: legacy.tour.totalKm || 0,
            totalAscent: legacy.tour.totalAscent || 0,
            stageCount: (legacy.tour.stages || []).length,
            startDate: legacy.startDate || null,
            savedAt: Date.now() - 1,
          };
          // Don't blow away an existing INDEX_KEY entry — append.
          const next = readIndex();
          next.push(meta);
          writeIndex(next);
          writeBlob(synthId, {
            tour: legacy.tour,
            geometry: legacy.geometry || null,
            stops: legacy.stops || [legacy.tour.from, legacy.tour.to],
            dailyKm: legacy.dailyKm || 120,
            startDate: legacy.startDate || null,
          });
        }
      } catch (e) { warn("legacy singleton parse failed", e); }
      safeRemove(LEGACY_SINGLETON_KEY);
    }

    // Then, rename ridePrep:tours -> rideprep:savedTours:v1 and each
    // ridePrep:tour:<id> -> rideprep:savedTour:v1:<id>. Only writes the
    // new keys if the new ones don't already hold data.
    const legacyRaw = safeGet(LEGACY_INDEX_KEY);
    if (legacyRaw) {
      try {
        const legacyList = JSON.parse(legacyRaw);
        if (Array.isArray(legacyList) && legacyList.length) {
          const existing = readIndex();
          const haveIds = new Set(existing.map((t) => t.id));
          const merged = existing.slice();
          for (const entry of legacyList) {
            if (!entry || !entry.id || haveIds.has(entry.id)) continue;
            const oldBlobRaw = safeGet(LEGACY_BLOB_PREFIX + entry.id);
            if (oldBlobRaw) safeSet(BLOB_PREFIX + entry.id, oldBlobRaw);
            merged.push(entry);
            haveIds.add(entry.id);
          }
          writeIndex(merged);
        }
      } catch (e) { warn("legacy index parse failed", e); }
      // Sweep old blob keys.
      try {
        for (let i = 0; i < window.localStorage.length; i++) {
          const k = window.localStorage.key(i);
          if (k && k.startsWith(LEGACY_BLOB_PREFIX)) safeRemove(k);
        }
      } catch (e) { warn("legacy blob sweep failed", e); }
      safeRemove(LEGACY_INDEX_KEY);
    }
  } finally {
    safeSet(RENAME_FLAG_KEY, RENAME_FLAG_VALUE);
  }
}

migrateFromLegacyKeys();

// ── Public API ─────────────────────────────────────────────────────────────

function loadSavedTours() { return readIndex(); }

function loadTourBlob(id) { return readBlob(id); }

// Build/update the index entry + write the per-tour blob. Returns
// { ok, id, reason? } so callers can distinguish quota failures from
// other errors (and from no-op when the input is invalid).
function saveTour({ tour, geometry, stops, stopCoords, dailyKm, startDate, id, name } = {}) {
  if (!tour || !tour.from || !tour.to) return { ok: false, reason: "invalid" };
  if (!id) return { ok: false, reason: "invalid-id" };
  const meta = {
    id,
    name: name || `${tour.from} → ${tour.to}`,
    from: tour.from,
    to: tour.to,
    totalKm: tour.totalKm || 0,
    totalAscent: tour.totalAscent || 0,
    stageCount: Array.isArray(tour.stages) ? tour.stages.length : 0,
    startDate: startDate || null,
    savedAt: Date.now(),
  };
  const list = readIndex();
  const idx = list.findIndex((t) => t.id === id);
  if (idx >= 0) list[idx] = meta;
  else list.push(meta);
  const ixWrite = writeIndex(list);
  if (!ixWrite.ok) return { ok: false, reason: ixWrite.reason, id };
  const blobWrite = writeBlob(id, { tour, geometry, stops, stopCoords, dailyKm, startDate });
  if (!blobWrite.ok) return { ok: false, reason: blobWrite.reason, id };
  notify("save", { id });
  return { ok: true, id };
}

function deleteTour(id) {
  const list = readIndex().filter((t) => t.id !== id);
  writeIndex(list);
  deleteBlob(id);
  notify("delete", { id });
}

function clearAllTours() {
  // Wipe blobs first so we don't orphan them if something crashes between.
  const list = readIndex();
  for (const t of list) deleteBlob(t.id);
  // Defensive sweep in case the index drifted out of sync with blobs.
  try {
    for (let i = window.localStorage.length - 1; i >= 0; i--) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(BLOB_PREFIX)) safeRemove(k);
    }
  } catch {}
  safeRemove(INDEX_KEY);
  notify("clear");
}

// ── Low-level helpers used by migrations only ──────────────────────────────
// Used by the in-PR dedupe pass in tour.jsx (which needs to rename a
// blob without re-writing it through saveTour). Not part of the
// general API surface.
function _writeBlobRaw(id, blob) { return writeBlob(id, blob); }
function _writeIndexRaw(list) { return writeIndex(list); }
function _deleteBlobRaw(id) { deleteBlob(id); }

window.RP_TourStorage = {
  // Public
  loadSavedTours, loadTourBlob, saveTour, deleteTour, clearAllTours,
  // Aliases kept for back-compat with callers that pre-dated this file.
  readToursIndex: loadSavedTours,
  readTourBlob: loadTourBlob,
  // Internal-use, prefixed with _: for migrations / tests only.
  _writeBlobRaw, _writeIndexRaw, _deleteBlobRaw,
  // Keys exposed so other tabs can listen to `storage` events on them.
  TOURS_INDEX_KEY: INDEX_KEY,
  TOUR_BLOB_PREFIX: BLOB_PREFIX,
};

})();
