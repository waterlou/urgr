// IA auth module — stores cookies and S3 keys for authenticated IA access.
// Credentials are loaded from data/.env on server startup.

import fs from 'fs';
import { envFile } from './paths.js';

let authState = null;

export function getAuth() {
  return authState;
}

export function isAuthenticated() {
  return authState !== null;
}

export async function setAuth(username, password) {
  const resp = await fetch('https://archive.org/services/xauthn/?op=login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: username, password }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`IA auth server returned HTTP ${resp.status}: ${text.slice(0, 100)}`);
  }
  let data;
  try { data = await resp.json(); }
  catch { throw new Error('IA auth returned non-JSON response'); }
  if (!data.success) {
    const msg = data.error || 'unknown error';
    throw new Error(msg === 'account_bad_password' ? 'Incorrect password' : msg);
  }
  const vals = data.values;

  const loggedInUser = vals.cookies['logged-in-user'].split(';')[0];
  const loggedInSig = vals.cookies['logged-in-sig'].split(';')[0];

  authState = {
    username: vals.email,
    password,
    screenname: vals.screenname,
    s3: vals.s3,
    cookieString: `logged-in-user=${loggedInUser}; logged-in-sig=${loggedInSig}`,
    loggedInUser,
    loggedInSig,
  };
  return authState;
}

export function clearAuth() {
  authState = null;
}

export function getCookieHeader() {
  return authState?.cookieString || '';
}

// Load IA credentials from .env file and authenticate.
// Call on server startup — credentials are stored by the Settings page.
export async function loadFromEnv() {
  try {
    if (!fs.existsSync(envFile)) return null;
    const text = fs.readFileSync(envFile, 'utf-8');
    let username = '', password = '';
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key === 'IA_USERNAME') username = val;
      else if (key === 'IA_PASSWORD') password = val;
    }
    if (username && password) {
      console.log(`[ia-auth] Logging in as ${username}...`);
      await setAuth(username, password);
      console.log(`[ia-auth] Login successful (screenname: ${authState.screenname})`);
      return authState;
    }
  } catch (e) {
    console.error('[ia-auth] Failed to load from env:', e.message);
  }
  return null;
}
