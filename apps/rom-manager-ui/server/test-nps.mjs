import { describe, it, before, after } from 'node:test'
import { strict as assert } from 'node:assert'
import os from 'os'
import { join } from 'path'
import { mkdtempSync } from 'fs'
import { parseTsvLine, parseTsv, shouldIgnore, normalizeForGroup, importNps, NPS_PLATFORM_MAP } from './nps.js'
import { initDb, getDb } from './db.js'

describe('NPS import', () => {

  describe('parseTsvLine', () => {
    it('splits tab-separated values', () => {
      assert.deepEqual(parseTsvLine('a\tb\tc'), ['a', 'b', 'c'])
    })
    it('handles quoted fields', () => {
      assert.deepEqual(parseTsvLine('a\t"b c"\td'), ['a', 'b c', 'd'])
    })
    it('handles empty fields', () => {
      assert.deepEqual(parseTsvLine('a\t\tc'), ['a', '', 'c'])
    })
    it('handles single field', () => {
      assert.deepEqual(parseTsvLine('hello'), ['hello'])
    })
    it('handles quoted field with tabs inside', () => {
      assert.deepEqual(parseTsvLine('"a\tb"\tc'), ['a\tb', 'c'])
    })
  })

  describe('parseTsv', () => {
    it('parses headers and rows', () => {
      const tsv = 'Name\tAge\nAlice\t30\nBob\t25'
      const rows = parseTsv(tsv)
      assert.equal(rows.length, 2)
      assert.equal(rows[0].Name, 'Alice')
      assert.equal(rows[0].Age, '30')
      assert.equal(rows[1].Name, 'Bob')
      assert.equal(rows[1].Age, '25')
    })
    it('returns empty array for empty input', () => {
      assert.deepEqual(parseTsv(''), [])
    })
    it('trims whitespace in values', () => {
      const tsv = 'Name\tValue\n  hello  \t  world  '
      const rows = parseTsv(tsv)
      assert.equal(rows[0].Name, 'hello')
      assert.equal(rows[0].Value, 'world')
    })
    it('trims headers', () => {
      const tsv = '  Name  \t  Value  \nfoo\tbar'
      const rows = parseTsv(tsv)
      assert.equal(rows[0].Name, 'foo')
      assert.equal(rows[0].Value, 'bar')
    })
  })

  describe('shouldIgnore', () => {
    it('ignores themes', () => {
      assert.ok(shouldIgnore('Some Theme'))
      assert.ok(shouldIgnore('Custom Theme Pack'))
    })
    it('ignores demos', () => {
      assert.ok(shouldIgnore('Game Demo'))
      assert.ok(shouldIgnore('Demo Version'))
    })
    it('allows normal games', () => {
      assert.ok(!shouldIgnore('10 Second Ninja X'))
      assert.ok(!shouldIgnore('Persona 4 Golden'))
    })
    it('is case insensitive', () => {
      assert.ok(shouldIgnore('THEME'))
      assert.ok(shouldIgnore('DEMO'))
    })
  })

  describe('normalizeForGroup', () => {
    it('removes firmware suffix (3.61+!)', () => {
      assert.equal(normalizeForGroup('Game Name (3.61+!)'), 'Game Name')
    })
    it('removes firmware suffix [3.63]', () => {
      assert.equal(normalizeForGroup('Game Name [3.63]'), 'Game Name')
    })
    it('removes both suffixes', () => {
      assert.equal(normalizeForGroup('Game Name (3.61+!) [3.63]'), 'Game Name')
    })
    it('handles no suffix', () => {
      assert.equal(normalizeForGroup('10 Second Ninja X'), '10 Second Ninja X')
    })
    it('trims whitespace', () => {
      assert.equal(normalizeForGroup('  Game Name  '), 'Game Name')
    })
  })

  describe('importNps', () => {
    let db, dbPath

    before(() => {
      dbPath = join(mkdtempSync(join(os.tmpdir(), 'nps-test-')), 'test.db')
      initDb(dbPath)
      db = getDb()
      db.run("INSERT INTO collections (name, slug, dataset_preset) VALUES (?, ?, ?)", ['NPS Test', 'nps-test', 'nps'])
    })

    after(() => {
      try { db.run('DROP TABLE IF EXISTS games') } catch {}
      try { db.run('DROP TABLE IF EXISTS game_rom_sets') } catch {}
      try { db.run('DROP TABLE IF EXISTS game_rom_files') } catch {}
      try { db.run('DROP TABLE IF EXISTS set_versions') } catch {}
      try { db.run('DROP TABLE IF EXISTS collection_versions') } catch {}
      try { db.run('DROP TABLE IF EXISTS game_state') } catch {}
    })

    it('throws on unknown platform', async () => {
      await assert.rejects(() => importNps('INVALID', 1), /Unknown NPS platform/)
    })

    it('imports games from mock PSV TSV', async () => {
      db.run('INSERT INTO set_versions (collection_id, version) VALUES (?, ?)', [1, 'PSV'])
      const idResult = db.exec('SELECT last_insert_rowid() as id')
      const versionId = idResult[0]?.values[0]?.[0]
      assert.ok(versionId)

      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url) => {
        if (url.includes('PSV_GAMES.tsv')) {
          return {
            ok: true,
            text: async () => [
              'Title ID\tRegion\tName\tPKG direct link\tzRIF\tContent ID\tLast Modification Date\tOriginal Name\tFile Size\tSHA256\tRequired FW\tApp Version',
              'PCSE00001\tUS\t10 Second Ninja X\thttp://example.com/UP4395-PCSE00001_00-GAME_bg_1_hash.pkg\t\tUP4395-PCSE00001_00-GAME\t2024-01-01\t10 Second Ninja X\t12345\taaaa\t3.6\t1',
              'PCSB00001\tEU\t10 Second Ninja X\thttp://example.com/EP4395-PCSB00001_00-GAME_bg_1_hash.pkg\t\tEP4395-PCSB00001_00-GAME\t2024-01-01\t10 Second Ninja X\t12345\tbbbb\t3.6\t1',
              'PCSJ00001\tJP\tPersona 4 Golden\thttp://example.com/JP4395-PCSJ00001_00-GAME_bg_1_hash.pkg\t\tJP4395-PCSJ00001_00-GAME\t2024-01-01\tPersona 4 Golden JP\t12345\tcccc\t3.6\t1',
              'PCSE00002\tUS\tPersona 4 Golden\thttp://example.com/UP4395-PCSE00002_00-GAME_bg_1_hash.pkg\t\tUP4395-PCSE00002_00-GAME\t2024-01-01\tPersona 4 Golden\t12345\tdddd\t3.6\t1',
              'PCSB00002\tEU\tPersona 4 Golden\thttp://example.com/EP4395-PCSB00002_00-GAME_bg_1_hash.pkg\t\tEP4395-PCSB00002_00-GAME\t2024-01-01\tPersona 4 Golden\t12345\teeee\t3.6\t1',
              'PCSA00001\tASIA\tPersona 4 Golden\thttp://example.com/ASIA-PCSA00001_00-GAME_bg_1_hash.pkg\t\tASIA-PCSA00001_00-GAME\t2024-01-01\tPersona 4 Golden\t12345\tffff\t3.6\t1',
              'PCSE99999\tUS\tMISSING\tMISSING\t\tPCSE99999\t2024-01-01\t\t0\t\t3.6\t1',
              'PCSD00001\tUS\tSome Theme\thttp://example.com/theme.pkg\t\tPCSD00001\t2024-01-01\t\t0\t\t3.6\t1',
              'PCSE88888\tUS\tGame Demo\thttp://example.com/demo.pkg\t\tPCSE88888\t2024-01-01\t\t0\t\t3.6\t1',
            ].join('\n'),
          }
        }
        return { ok: true, text: async () => '' }
      }

      const result = await importNps('PSV', versionId, 1)

      // 2 game names, 6 ROM files (US+EU for Ninja, JP+US+EU+ASIA for P4G)
      assert.equal(result.gamesImported, 2, 'should create 2 games')
      assert.equal(result.romsImported, 6, 'should create 6 ROM files')

      // Check games table
      const games = db.exec(`
        SELECT g.name, g.platform, g.region, g.description, g.content_id
        FROM games g
        JOIN game_rom_sets grs ON grs.game_id = g.id
        WHERE grs.version_id = ?
        ORDER BY g.name`, [versionId])
      const rows = games[0]?.values || []
      assert.equal(rows.length, 2)

      // 10 Second Ninja X (parent = US) — name is now title_id
      const ninjaRow = rows.find(r => r[0] === 'PCSE00001')
      assert.ok(ninjaRow, '10 Second Ninja X (PCSE00001) exists')
      assert.equal(ninjaRow[1], 'PSV', 'platform set')
      assert.equal(ninjaRow[2], 'US', 'region from US variant')
      assert.equal(ninjaRow[3], '10 Second Ninja X', 'description is game name')

      // Persona 4 Golden (parent = US)
      const p4Row = rows.find(r => r[0] === 'PCSB00582')
      assert.ok(p4Row, 'Persona 4 Golden (PCSB00582) exists')

      // Check ROM files for Ninja (US + EU)
      const ninjaRoms = db.exec(`
        SELECT grf.filename, grf.subtype FROM game_rom_files grf
        JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
        JOIN games g ON g.id = grs.game_id
        WHERE g.description = ? AND grs.version_id = ?
        ORDER BY grf.filename`, ['10 Second Ninja X', versionId])
      const ninjaRomRows = ninjaRoms[0]?.values || []
      assert.equal(ninjaRomRows.length, 2, 'Ninja has 2 ROM files (US + EU)')
      assert.ok(ninjaRomRows.some(r => r[0].includes('PCSE00001')), 'US variant ROM')
      assert.ok(ninjaRomRows.some(r => r[0].includes('PCSB00001')), 'EU variant ROM')

      // Check ROM files for Persona 4 (JP + US + EU + ASIA)
      const p4Roms = db.exec(`
        SELECT grf.filename, grf.subtype FROM game_rom_files grf
        JOIN game_rom_sets grs ON grs.id = grf.rom_set_id
        JOIN games g ON g.id = grs.game_id
        WHERE g.description = 'Persona 4 Golden' AND grs.version_id = ?
        ORDER BY grf.filename`, [versionId])
      const p4RomRows = p4Roms[0]?.values || []
      assert.equal(p4RomRows.length, 4, 'P4G has 4 ROM files (JP+US+EU+ASIA)')
      assert.equal(p4RomRows[0][1], 'game', 'subtype is game')

      // Verify MISSING PKG, Theme, Demo were excluded
      const excluded = db.exec(`
        SELECT g.name FROM games g
        JOIN game_rom_sets grs ON grs.game_id = g.id
        WHERE grs.version_id = ?
        AND (g.description LIKE '%MISSING%' OR g.description LIKE '%Theme%' OR g.description LIKE '%Demo%')`, [versionId])
      assert.equal(excluded[0]?.values?.length || 0, 0, 'MISSING/Themes/Demos not imported')

      // Verify re-import skips existing
      const result2 = await importNps('PSV', versionId, 1)
      assert.equal(result2.gamesImported, 0, 're-import should skip all')
      assert.equal(result2.romsImported, 0, 're-import should skip all ROMs')

      globalThis.fetch = originalFetch
    })

    it('handles multi-region TSV values', async () => {
      const originalFetch = globalThis.fetch
      globalThis.fetch = async (url) => {
        if (url.includes('_GAMES.tsv')) {
          return {
            ok: true,
            text: async () => [
              'Title ID\tRegion\tName\tPKG direct link\tzRIF\tContent ID\tLast Modification Date\tOriginal Name\tFile Size\tSHA256\tRequired FW\tApp Version',
              'PCSX00001\tUS, EU\tMulti Region Game\thttp://example.com/multi.pkg\t\tPCSX00001\t2024-01-01\t\t100\taaa\t3.6\t1',
            ].join('\n'),
          }
        }
        return { ok: true, text: async () => '' }
      }

      db.run('INSERT INTO set_versions (collection_id, version) VALUES (?, ?)', [1, 'TEST'])
      const idResult = db.exec('SELECT last_insert_rowid() as id')
      const versionId = idResult[0]?.values[0]?.[0]

      const result = await importNps('PSV', versionId, 1)
      // Multi-region "US, EU" splits into 2 variants, but they're the same PKG filename
      // so only 1 ROM file with dedup
      assert.equal(result.gamesImported, 1, '1 game row')
      assert.equal(result.romsImported, 1, '1 ROM file (same PKG for both regions)')

      globalThis.fetch = originalFetch
    })
  })
})
