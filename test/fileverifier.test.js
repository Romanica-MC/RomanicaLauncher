const test   = require('node:test')
const assert = require('node:assert')
const crypto = require('crypto')
const fs     = require('fs-extra')
const os     = require('os')
const path   = require('path')

const { verifyFiles } = require('../app/assets/js/fileverifier')

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex')

async function fixture(t){
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imperium-verify-'))
    t.after(() => fs.remove(dir))
    const write = async (name, content) => {
        const p = path.join(dir, name)
        await fs.writeFile(p, content)
        return { id: name, path: p, hash: sha1(Buffer.from(content)), algo: 'sha1', size: Buffer.byteLength(content), url: `https://example.invalid/${name}` }
    }
    return { dir, write }
}

// Counts real hashes so the tests can tell a cache hit from a re-hash.
function countingHasher(){
    const calls = []
    const hashFile = async (p) => {
        calls.push(p)
        return sha1(await fs.readFile(p))
    }
    return { hashFile, calls }
}

test('valid files pass, and a second run trusts the cache instead of re-hashing', async (t) => {
    const { dir, write } = await fixture(t)
    const items = [await write('a', 'alpha'), await write('b', 'bravo')]
    const first = countingHasher()
    assert.deepStrictEqual(await verifyFiles(items, { cacheDir: dir, hashFile: first.hashFile }), [])
    assert.strictEqual(first.calls.length, 2)

    const second = countingHasher()
    assert.deepStrictEqual(await verifyFiles(items, { cacheDir: dir, hashFile: second.hashFile }), [])
    assert.strictEqual(second.calls.length, 0, 'unchanged files must not be re-hashed')
})

test('a file changed after caching is re-hashed and caught', async (t) => {
    const { dir, write } = await fixture(t)
    const item = await write('a', 'alpha')
    await verifyFiles([item], { cacheDir: dir })
    await fs.writeFile(item.path, 'tampered')
    const hasher = countingHasher()
    const invalid = await verifyFiles([item], { cacheDir: dir, hashFile: hasher.hashFile })
    assert.deepStrictEqual(invalid.map(i => i.id), ['a'])
    assert.strictEqual(hasher.calls.length, 1)
})

test('missing files and wrong hashes are reported, and failures never enter the cache', async (t) => {
    const { dir, write } = await fixture(t)
    const good = await write('good', 'ok')
    const bad = { ...(await write('bad', 'content')), hash: sha1(Buffer.from('something else')) }
    const missing = { id: 'missing', path: path.join(dir, 'nope'), hash: sha1(Buffer.from('x')), algo: 'sha1', size: 1, url: 'u' }
    const invalid = await verifyFiles([good, bad, missing], { cacheDir: dir })
    assert.deepStrictEqual(invalid.map(i => i.id).sort(), ['bad', 'missing'])

    // The bad file must be hashed again next time, not trusted from the cache.
    const hasher = countingHasher()
    await verifyFiles([bad], { cacheDir: dir, hashFile: hasher.hashFile })
    assert.strictEqual(hasher.calls.length, 1)
})

test('progress counts every file and finishes at 100%', async (t) => {
    const { dir, write } = await fixture(t)
    const items = []
    for(let i = 0; i < 20; i++){
        items.push(await write(`f${i}`, `content ${i}`))
    }
    const updates = []
    await verifyFiles(items, { cacheDir: dir, onProgress: (p) => updates.push(p) })
    const last = updates[updates.length - 1]
    assert.deepStrictEqual(last, { checked: 20, total: 20, percent: 100 })
    for(let i = 1; i < updates.length; i++){
        assert.ok(updates[i].checked >= updates[i - 1].checked, 'progress must not go backwards')
    }
})

test('an unreadable cache file is ignored, not fatal', async (t) => {
    const { dir, write } = await fixture(t)
    await fs.writeFile(path.join(dir, '.verified-files.json'), '{not json')
    assert.deepStrictEqual(await verifyFiles([await write('a', 'alpha')], { cacheDir: dir }), [])
})
