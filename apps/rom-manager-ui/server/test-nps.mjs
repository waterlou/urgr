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
    })

    after(() => {
      try { db.run('DROP TABLE IF EXISTS game_entries') } catch {}
      try { db.run('DROP TABLE IF EXISTS rom_entries') } catch {}
      try { db.run('DROP TABLE IF EXISTS set_versions') } catch {}
      try { db.run('DROP TABLE IF EXISTS collection_versions') } catch {}
      try { db.run('DROP TABLE IF EXISTS game_state') } catch {}
    })

    it('throws on unknown platform', async () => {
      await assert.rejects(() => importNps('INVALID', 1), /Unknown NPS platform/)
    })

    it('imports games from mock PSV TSV', async () => {
      // Create a version for import
      db.run('INSERT INTO set_versions (source, version) VALUES (?, ?)', ['NPS', 'PSV'])
      const idResult = db.exec('SELECT last_insert_rowid() as id')
      const versionId = idResult[0]?.values[0]?.[0]
      assert.ok(versionId)

      // Mock TSV data (simulating real NPS format)
      const originalFetch = globalThis.fetch
      let fetchCount = 0
      globalThis.fetch = async (url) => {
        fetchCount++
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

      const result = await importNps('PSV', versionId)

      // Verify: MISSING PKG, Theme, Demo, and only-us-no-siblings games excluded
      // 6 rows imported: 10 Second Ninja X (US+EU) = 1 parent + 1 clone, Persona 4 Golden (US+JP+EU+ASIA) = 1 parent + 3 clones
      assert.equal(result.gamesImported, 6, 'should create 6 game entries')

      // Check parent/clone structure
      const games = db.exec(`
        SELECT g.name, g.region, g.cloneof, g.title_id, g.content_id
        FROM game_entries g WHERE g.version_id = ?
        ORDER BY g.name, g.region`, [versionId])
      const rows = games[0]?.values || []
      assert.equal(rows.length, 6)

      // 10 Second Ninja X: US is parent, EU is clone
      const ninjaRows = rows.filter(r => r[0] === '10 Second Ninja X')
      assert.equal(ninjaRows.length, 2)

      const ninjaUS = ninjaRows.find(r => r[1] === 'US')
      assert.ok(ninjaUS, 'US variant exists')
      assert.equal(ninjaUS[2], null, 'US is parent (cloneof = null)')
      assert.equal(ninjaUS[3], 'PCSE00001', 'US has correct title_id')
      assert.equal(ninjaUS[4], 'UP4395-PCSE00001_00-GAME', 'US has correct content_id')

      const ninjaEU = ninjaRows.find(r => r[1] === 'EU')
      assert.ok(ninjaEU, 'EU variant exists')
      assert.equal(ninjaEU[2], '10 Second Ninja X', 'EU is clone of parent')
      assert.equal(ninjaEU[3], 'PCSB00001', 'EU has correct title_id')

      // Persona 4 Golden: US is parent, JP/EU/ASIA are clones
      const p4Rows = rows.filter(r => r[0] === 'Persona 4 Golden')
      assert.equal(p4Rows.length, 4)

      const p4US = p4Rows.find(r => r[1] === 'US')
      assert.ok(p4US, 'US parent exists')
      assert.equal(p4US[2], null, 'US is parent')

      // Check ROM filenames use exact PKG filename
      const roms = db.exec(`
        SELECT r.filename, r.subtype FROM rom_entries r
        JOIN game_entries g ON g.id = r.game_entry_id
        WHERE g.version_id = ? AND g.name = '10 Second Ninja X' AND g.region = 'US'`, [versionId])
      const usRoms = roms[0]?.values || []
      assert.equal(usRoms.length, 1)
      assert.ok(usRoms[0][0].endsWith('.pkg'), 'ROM filename ends with .pkg')
      assert.ok(usRoms[0][0].includes('PCSE00001'), 'ROM filename contains title_id')
      assert.equal(usRoms[0][1], 'game', 'subtype is game')

      // Verify DUPLICATE SCENARIO: re-importing same version skips existing
      const result2 = await importNps('PSV', versionId)
      assert.equal(result2.gamesImported, 0, 're-import should skip all')

      // Verify that MISSING PKG, Theme, Demo were excluded
      const excluded = db.exec(`
        SELECT g.name FROM game_entries g WHERE g.version_id = ?
        AND (g.name LIKE '%MISSING%' OR g.name LIKE '%Theme%' OR g.name LIKE '%Demo%')`, [versionId])
      assert.equal(excluded[0]?.values?.length || 0, 0, 'MISSING/Themes/Demos not imported')

      globalThis.fetch = originalFetch
    })

    it('handles multi-region TSV values', async () => {
      const originalFetch = globalThis.fetch
      let fetchCount = 0
      globalThis.fetch = async (url) => {
        fetchCount++
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

      db.run('INSERT INTO set_versions (source, version) VALUES (?, ?)', ['NPS', 'TEST'])
      const idResult = db.exec('SELECT last_insert_rowid() as id')
      const versionId = idResult[0]?.values[0]?.[0]

      const result = await importNps('PSV', versionId)
      // Multi-region "US, EU" splits into 2 variants: parent (US) + clone (EU)
      assert.equal(result.gamesImported, 2, 'multi-region splits into 2 entries')

      const games = db.exec(`
        SELECT g.name, g.region, g.cloneof FROM game_entries g WHERE g.version_id = ?
        ORDER BY g.region`, [versionId])
      const rows = games[0]?.values || []
      assert.equal(rows.length, 2)
      assert.equal(rows[0][1], 'EU', 'EU variant')
      assert.equal(rows[1][1], 'US', 'US parent')

      globalThis.fetch = originalFetch
    })
  })
})
