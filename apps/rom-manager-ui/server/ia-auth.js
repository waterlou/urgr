// IA auth module — stores cookies and S3 keys for authenticated IA access.
// Single-user, in-memory (resets on server restart).

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

  // Parse cookie values (strip "; expires=..." suffixes)
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

// Cookie header for IA fetch requests (for HTTP stream downloads)
export function getCookieHeader() {
  return authState?.cookieString || '';
}
