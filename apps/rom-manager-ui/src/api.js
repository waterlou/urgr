const BASE = '/api';

export async function fetchJson(url, opts) {
  const res = await fetch(BASE + url, opts);
  const body = await res.text();
  if (!res.ok) {
    let detail = '';
    try { detail = JSON.parse(body).error || body; } catch { detail = body.slice(0, 200); }
    throw new Error(`HTTP ${res.status}${detail ? ': ' + detail : ''}`);
  }
  try {
    return JSON.parse(body);
  } catch (e) {
    console.error(`fetchJson parse error for ${url}:`, body.slice(0, 200));
    throw new Error(`Response is not JSON: ${e.message}`);
  }
}

export function fetchWithBody(url, method, body) {
  return fetchJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ==============================
// Status
// ==============================
export function getStatus() { return fetchJson('/status'); }

// ==============================
// Platforms (reference)
// ==============================
export function getPlatforms() { return fetchJson('/platforms'); }

// ==============================
// Collections
// ==============================
export function getCollections() { return fetchJson('/collections'); }
export function createCollection(data) { return fetchWithBody('/collections', 'POST', data); }
export function updateCollection(id, data) { return fetchWithBody(`/collections/${id}`, 'PUT', data); }
export function deleteCollection(id) { return fetchWithBody(`/collections/${id}`, 'DELETE'); }
export function getCollectionGames(id, { limit, offset, sort, order, q, parents_only, favourites_only, roms_only } = {}) {
  const p = new URLSearchParams();
  if (limit) p.set('limit', limit);
  if (offset) p.set('offset', offset);
  if (sort) p.set('sort', sort);
  if (order) p.set('order', order);
  if (q) p.set('q', q);
  if (parents_only) p.set('parents_only', parents_only);
  if (favourites_only) p.set('favourites_only', favourites_only);
  if (roms_only) p.set('roms_only', roms_only);
  return fetchJson(`/collections/${id}/games${p.toString() ? '?' + p.toString() : ''}`);
}

export function addCollectionVersion(id, versionId) {
  return fetchWithBody(`/collections/${id}/versions`, 'POST', { version_id: versionId });
}
export function getCollectionVersions(id) {
  return fetchJson(`/collections/${id}/versions`);
}
export function removeCollectionVersion(id, versionId) {
  return fetchWithBody(`/collections/${id}/versions/${versionId}`, 'DELETE');
}

// Long-running operations (return jobId)
export function scanCollection(id, version_id, dir) {
  return fetchWithBody(`/collections/${id}/scan`, 'POST', { version_id, dir });
}
export function verifyCollection(id, version_id, dir, fallback_id) {
  return fetchWithBody(`/collections/${id}/verify`, 'POST', { version_id, dir, fallback_id });
}
export function downloadFromIA(id, item, file_pattern, dest_dir) {
  return fetchWithBody(`/collections/${id}/download-ia`, 'POST', { item, file_pattern, dest_dir });
}
export function iaListFiles(url, pattern) {
  return fetchWithBody('/ia/list', 'POST', { url, pattern });
}
export function iaDownloadEntry(url, entry, collection_id) {
  return fetchWithBody('/ia/download', 'POST', { url, entry, collection_id });
}

// Builds
export function getCollectionBuilds(id) { return fetchJson(`/collections/${id}/builds`); }
export function startCollectionBuild(id, version_id, format = 'split') {
  return fetchWithBody(`/collections/${id}/builds`, 'POST', { version_id, format });
}
export function updateCollectionBuild(id, buildId, data) {
  return fetchWithBody(`/collections/${id}/builds/${buildId}`, 'PUT', data);
}
export function runCollectionBuild(id, buildId, { source, import_dir, base_dir, update } = {}) {
  return fetchWithBody(`/collections/${id}/builds/${buildId}/run`, 'POST', { source, import_dir, base_dir, update });
}
export function collectionBuild(id, version_id, import_dir, scan = false) {
  return fetchWithBody(`/collections/${id}/build`, 'POST', { version_id, import_dir, scan });
}

// Exports
export function exportCollection(id, { format = 'split', version_id } = {}) {
  return fetchWithBody(`/collections/${id}/exports`, 'POST', { format, version_id });
}

// ==============================
// Game Sets
// ==============================
export function getGameSets() { return fetchJson('/game-sets'); }
export function createGameSet(data) { return fetchWithBody('/game-sets', 'POST', data); }
export function updateGameSet(id, data) { return fetchWithBody(`/game-sets/${id}`, 'PUT', data); }
export function deleteGameSet(id) { return fetchWithBody(`/game-sets/${id}`, 'DELETE'); }
export function getGameSetGames(id, { limit, offset, sort, order, q } = {}) {
  const p = new URLSearchParams();
  if (limit) p.set('limit', limit);
  if (offset) p.set('offset', offset);
  if (sort) p.set('sort', sort);
  if (order) p.set('order', order);
  if (q) p.set('q', q);
  return fetchJson(`/game-sets/${id}/games${p.toString() ? '?' + p.toString() : ''}`);
}
export function addGameSetGames(id, gameEntryIds) {
  return fetchWithBody(`/game-sets/${id}/games`, 'POST', { game_entry_ids: gameEntryIds });
}
export function removeGameSetGame(id, gameId) {
  return fetchWithBody(`/game-sets/${id}/games/${gameId}`, 'DELETE');
}
export function exportGameSet(id) { return fetchJson(`/game-sets/${id}/exports`); }

// ==============================
// Games (global)
// ==============================
export function getGames({ limit, offset, sort, order, q, collection_id, version_id, parents_only, favourites_only, roms_only } = {}) {
  const p = new URLSearchParams();
  if (limit) p.set('limit', limit);
  if (offset) p.set('offset', offset);
  if (sort) p.set('sort', sort);
  if (order) p.set('order', order);
  if (q) p.set('q', q);
  if (collection_id) p.set('collection_id', collection_id);
  if (version_id) p.set('version_id', version_id);
  if (parents_only) p.set('parents_only', parents_only);
  if (favourites_only) p.set('favourites_only', favourites_only);
  if (roms_only) p.set('roms_only', roms_only);
  return fetchJson(`/games?${p.toString()}`);
}

export function getGame(id) { return fetchJson(`/games/${id}`); }
export function updateGameRating(id, data) {
  return fetchWithBody(`/games/${id}/rating`, 'PUT', data);
}
export function coverUrl(id) { return `${BASE}/games/${id}/cover?_=${Date.now()}`; }

// ==============================
// Versions
// ==============================
export function getVersions() { return fetchJson('/versions'); }
export function getVersionGames(id, { limit, offset, q } = {}) {
  const p = new URLSearchParams();
  if (limit) p.set('limit', limit);
  if (offset) p.set('offset', offset);
  if (q) p.set('q', q);
  return fetchJson(`/versions/${id}/games${p.toString() ? '?' + p.toString() : ''}`);
}

export function getAvailableVersions(source) {
  const qs = source ? `?source=${encodeURIComponent(source)}` : '';
  return fetchJson(`/versions/available${qs}`);
}
export function importOnlineVersion(collectionId, version, source, refresh) {
  return fetchWithBody('/versions/import-online', 'POST', { collection_id: collectionId, version, source, refresh });
}
export function importDat(content) {
  return fetchWithBody('/versions/import-dat', 'POST', { content });
}

// ==============================
// Scraper
// ==============================
export function scraperSearch(query, platform) {
  return fetchWithBody('/scraper/search', 'POST', { query, platform });
}
export function scraperScrape(file, game_name, platform) {
  return fetchWithBody('/scraper/scrape', 'POST', { file, game_name, platform });
}
export function hashFile(file) {
  return fetchWithBody('/scraper/hash', 'POST', { file });
}
export function scrapeGameMetadata(gameId) {
  return fetchWithBody(`/games/${gameId}/scrape`, 'POST');
}
export function batchScrapeGameMetadata(gameIds, overwrite) {
  return fetchWithBody('/games/batch-scrape', 'POST', { game_ids: gameIds, overwrite });
}
export function getScrapeJobs() {
  return fetchJson('/games/scrape-jobs');
}
export function scraperDetail(gameId, source) {
  return fetchWithBody('/scraper/detail', 'POST', { game_id: gameId, source });
}

// ==============================
// Settings
// ==============================
export function testIgdbConnection(client_id, client_secret) {
  return fetchWithBody('/settings/test-igdb', 'POST', { client_id, client_secret });
}
export function testTgdbConnection(api_key) {
  return fetchWithBody('/settings/test-tgdb', 'POST', { api_key });
}

// ==============================
// Jobs (SSE progress)
// ==============================
export function getJobStatus(jobId) {
  return fetchJson(`/jobs/${jobId}`);
}

export function subscribeJobSSE(jobId, { onProgress, onResult, onError, onDone }) {
  const evtSource = new EventSource(`${BASE}/jobs/${jobId}`);
  evtSource.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'progress') onProgress?.(msg);
    else if (msg.type === 'result') { onResult?.(msg.data); onDone?.(); evtSource.close(); }
    else if (msg.type === 'error') { onError?.(msg.error); evtSource.close(); }
    else if (msg.type === 'cancelled') { evtSource.close(); }
    else if (msg.type === 'done') { onDone?.(); evtSource.close(); }
    else if (msg.type === 'failed') { onError?.(msg.error); evtSource.close(); }
  };
  evtSource.onerror = () => { evtSource.close(); onError?.('Connection lost'); };
  return evtSource;
}

export function cancelJob(jobId) {
  return fetchWithBody(`/jobs/${jobId}/cancel`, 'POST');
}

// ==============================
// Settings (.env)
// ==============================
export function getSettings() { return fetchJson('/settings'); }
export function saveSettings(data) { return fetchWithBody('/settings', 'PUT', data); }
