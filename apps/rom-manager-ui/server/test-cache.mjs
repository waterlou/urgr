import { describe, it, before } from 'node:test'
import { strict as assert } from 'node:assert'
import { access } from 'fs/promises'
import { join } from 'path'
import { mkdtempSync, existsSync, mkdirSync, writeFileSync, readdirSync } from 'fs'
import os from 'os'
import { CACHE_SOURCES, findLocalFile } from './mediaCache.js'

// Sample URLs for each cache source
const SAMPLE_URLS = {
  arcadedb: 'https://adb.arcadeitalia.net/?mame=sf2&type=ingame&resize=0',
  'libretro-thumbnails': 'https://thumbnails.libretro.com/Nintendo%20-%20Super%20Nintendo%20Entertainment%20System/Named_Boxarts/Final%20Fantasy%20VI.png',
  'sony-store': 'https://apollo2.dl.playstation.net/cdn/UP1023/PCSE00428_00/rcMDHVFovw33fzy7nnh7WtTWGo47CmzL.png',
  igdb: 'https://images.igdb.com/igdb/image/upload/t_cover_big/co6g5s.jpg',
}

// Sample game name that should NOT match any real game (to avoid DB interference)
const TEST_GAME = '__cache_test__'
const TEST_PLATFORM = 'test'

describe('Media Cache', () => {

  describe('CACHE_SOURCES config', () => {
    it('has 4 cache sources', () => {
      assert.equal(CACHE_SOURCES.length, 4)
    })

    it('each source has required fields', () => {
      for (const s of CACHE_SOURCES) {
        assert.ok(s.name, `missing name in ${JSON.stringify(s)}`)
        assert.ok(s.hostPattern, `missing hostPattern in ${s.name}`)
        assert.ok(s.cacheDir, `missing cacheDir in ${s.name}`)
        assert.ok(s.mountPrefix, `missing mountPrefix in ${s.name}`)
        assert.ok(s.timeout > 0, `invalid timeout in ${s.name}`)
        assert.ok(s.mountPrefix.endsWith('/'), `mountPrefix should end with / in ${s.name}`)
      }
    })

    it('each source dir exists or can be created', async () => {
      for (const s of CACHE_SOURCES) {
        try {
          await access(s.cacheDir)
        } catch {
          // dir doesn't exist yet (expected for empty caches)
          // should be creatable by parent
          const parent = join(s.cacheDir, '..')
          await access(parent)
        }
      }
    })
  })

  describe('URL pattern matching', () => {
    for (const source of CACHE_SOURCES) {
      it(`${source.name} matches its sample URL`, () => {
        const url = SAMPLE_URLS[source.name]
        assert.ok(url, `no sample URL for ${source.name}`)
        assert.ok(url.includes(source.hostPattern),
          `${source.name} hostPattern '${source.hostPattern}' should match '${url}'`)
      })
    }

    it('arcadedb does not match igdb URL', () => {
      assert.ok(!SAMPLE_URLS.igdb.includes(CACHE_SOURCES[0].hostPattern))
    })

    it('igdb does not match sony-store URL', () => {
      assert.ok(!SAMPLE_URLS['sony-store'].includes(CACHE_SOURCES[3].hostPattern))
    })
  })

  describe('findLocalFile', () => {
    let tmpDir
    before(async () => {
      tmpDir = mkdtempSync(join(os.tmpdir(), 'cache-test-'))
      // Create test cache files
      const { mkdirSync, writeFileSync } = await import('fs')
      mkdirSync(join(tmpDir, 'testgame'), { recursive: true })
      writeFileSync(join(tmpDir, 'testgame', 'title.jpg'), 'fake-jpeg-data')
      writeFileSync(join(tmpDir, 'testgame', 'ingame.png'), 'fake-png-data')
      writeFileSync(join(tmpDir, 'testgame', 'video.mp4'), 'fake-mp4-data')
    })

    it('finds existing file by name + extension', async () => {
      const found = await findLocalFile(tmpDir, 'testgame', 'title')
      assert.ok(found, 'should find title.jpg')
      assert.ok(found.endsWith('title.jpg'), `expected title.jpg, got ${found}`)
    })

    it('finds file with different extension via scan', async () => {
      const found = await findLocalFile(tmpDir, 'testgame', 'ingame')
      assert.ok(found, 'should find ingame.png')
      assert.ok(found.endsWith('ingame.png'), `expected ingame.png, got ${found}`)
    })

    it('returns null for missing game', async () => {
      const found = await findLocalFile(tmpDir, 'nonexistent', 'title')
      assert.equal(found, null)
    })

    it('returns null for missing media type', async () => {
      const found = await findLocalFile(tmpDir, 'testgame', 'screenshot')
      assert.equal(found, null)
    })

    it('finds .mp4 video file', async () => {
      const found = await findLocalFile(tmpDir, 'testgame', 'video')
      assert.ok(found, 'should find video.mp4')
      assert.ok(found.endsWith('video.mp4'))
    })
  })

  describe('cache directory structure', () => {
    it('creates game subdirectories at cache root', () => {
      for (const s of CACHE_SOURCES) {
        const parent = join(s.cacheDir, '..')
        assert.ok(existsSync(parent), `parent dir ${parent} should exist`)
      }
    })
  })
})
