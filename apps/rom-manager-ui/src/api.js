const BASE = '/api';

export async function fetchJson(url, opts) {
  const res = await fetch(BASE + url, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export function fetchWithBody(url, method, body) {
  return fetchJson(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Versions
export function getVersions() { return fetchJson('/versions'); }
export function getVersionGames(id, { limit, offset, q } = {}) {
  const p = new URLSearchParams();
  if (limit) p.set('limit', limit);
  if (offset) p.set('offset', offset);
  if (q) p.set('q', q);
  return fetchJson(`/versions/${id}/games${p.toString() ? '?' + p.toString() : ''}`);
}

// Browse (all games)
export function getBrowseGames({ limit, offset, sort, order, q } = {}) {
  const p = new URLSearchParams();
  if (limit) p.set('limit', limit);
  if (offset) p.set('offset', offset);
  if (sort) p.set('sort', sort);
  if (order) p.set('order', order);
  if (q) p.set('q', q);
  return fetchJson(`/browse?${p.toString()}`);
}

// Search
export function searchGames(q) {
  return fetchJson(`/search?q=${encodeURIComponent(q)}&limit=50`);
}

// Game detail
export function getGame(id) { return fetchJson(`/games/${id}`); }
export function updateGameRating(id, data) {
  return fetchWithBody(`/games/${id}/rating`, 'PUT', data);
}
export function coverUrl(id) { return `${BASE}/covers/${id}`; }

// Status
export function getStatus() { return fetchJson('/status'); }

// Collections
export function getCollections() { return fetchJson('/collections'); }
export function createCollection(data) { return fetchWithBody('/collections', 'POST', data); }
export function updateCollection(id, data) { return fetchWithBody(`/collections/${id}`, 'PUT', data); }
export function deleteCollection(id) { return fetchWithBody(`/collections/${id}`, 'DELETE'); }
export function getCollectionGames(id, { limit, offset, sort, order, mode } = {}) {
  const p = new URLSearchParams();
  if (limit) p.set('limit', limit);
  if (offset) p.set('offset', offset);
  if (sort) p.set('sort', sort);
  if (order) p.set('order', order);
  if (mode) p.set('mode', mode);
  return fetchJson(`/collections/${id}/games${p.toString() ? '?' + p.toString() : ''}`);
}
export function addCollectionVersion(id, versionId) {
  return fetchWithBody(`/collections/${id}/versions`, 'POST', { version_id: versionId });
}
export function removeCollectionVersion(id, versionId) {
  return fetchWithBody(`/collections/${id}/versions/${versionId}`, 'DELETE');
}

// Game Sets
export function getGameSets() { return fetchJson('/game-sets'); }
export function createGameSet(data) { return fetchWithBody('/game-sets', 'POST', data); }
export function updateGameSet(id, data) { return fetchWithBody(`/game-sets/${id}`, 'PUT', data); }
export function deleteGameSet(id) { return fetchWithBody(`/game-sets/${id}`, 'DELETE'); }
export function getGameSetGames(id, { limit, offset, sort, order } = {}) {
  const p = new URLSearchParams();
  if (limit) p.set('limit', limit);
  if (offset) p.set('offset', offset);
  if (sort) p.set('sort', sort);
  if (order) p.set('order', order);
  return fetchJson(`/game-sets/${id}/games${p.toString() ? '?' + p.toString() : ''}`);
}
export function addGameSetGames(id, gameEntryIds) {
  return fetchWithBody(`/game-sets/${id}/games`, 'POST', { game_entry_ids: gameEntryIds });
}
export function removeGameSetGame(id, gameId) {
  return fetchWithBody(`/game-sets/${id}/games/${gameId}`, 'DELETE');
}
export function exportGameSet(id) { return fetchJson(`/game-sets/${id}/export`); }

// Reference data
export function getPlatforms() { return fetchJson('/platforms'); }
export function getDatasets() { return fetchJson('/datasets'); }

// MAME DAT version checking
export function getMameDats() { return fetchJson('/mame-dats'); }
export function importMameVersion(collectionId, version) {
  return fetchWithBody('/mame-dats/import', 'POST', { collection_id: collectionId, version });
}

// Collection builds
export function getCollectionBuilds(id) { return fetchJson(`/collections/${id}/builds`); }
export function startCollectionBuild(id, version_id, format = 'split') {
  return fetchWithBody(`/collections/${id}/build`, 'POST', { version_id, format });
}
export function updateCollectionBuild(id, buildId, data) {
  return fetchWithBody(`/collections/${id}/builds/${buildId}`, 'PUT', data);
}

// Collection export
export function exportCollection(id, { format = 'split', version_id } = {}) {
  return fetchWithBody(`/collections/${id}/export`, 'POST', { format, version_id });
}

// CLI integration
export function cliScan(version_id, dir) {
  return fetchWithBody('/cli/scan', 'POST', { version_id, dir });
}

export function cliVerify(version_id, dir, fallback_id) {
  return fetchWithBody('/cli/verify', 'POST', { version_id, dir, fallback_id });
}

export function cliHash(file) {
  return fetchWithBody('/cli/hash', 'POST', { file });
}
