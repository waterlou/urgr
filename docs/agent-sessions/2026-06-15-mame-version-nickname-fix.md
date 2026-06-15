# MAME Version 0.37b5 Nickname Fix

**Date:** 2026-06-15

## Goal
Fix clicking on MAME version "0.37b5" doing nothing (other versions like 0.78 work fine).

## Root Cause
The progettosnaps.net MAME DATs page lists beta versions like `0.41 (0.37b5)` where `0.41` is the numeric version and `0.37b5` is the nickname. The `_urls` cache was keyed only by numeric version (`0.41`), so looking up `0.37b5` returned undefined. The HTML-reparsing fallback also compared against the numeric version, never matching the nickname. The frontend sent the nickname to the server, which couldn't find the URL. The error was silently swallowed in the UI.

## Files Changed
- `apps/rom-manager-ui/server/routes/versions.js` — `_urls` cache now also indexes by nickname; HTML fallback comparison also checks nickname
- `apps/rom-manager-ui/src/components/VersionManager.jsx` — Prefer `d.numeric` over `d.version` for import calls
- `apps/rom-manager-ui/src/components/CollectionEdit/VersionsTab.jsx` — Same preference change

## Branch
`agent/mame-version-nickname-fix`

## Commands Run
- `npm run test:api` — 17/17 passed
- `npx vite build` — built successfully
