/**
 * fileverifier.js - the launch-time integrity check, fast enough to run on every launch.
 *
 * helios-core's validate stage SHA-1/MD5-hashes every asset, library, the client jar and
 * every mod one file at a time, about 650 MB on each launch (~6 s warm, far more cold),
 * and reports progress only once per stage, so the bar sat at 0% and then jumped.
 *
 * This checks the same files with three changes:
 *   - A file whose size and mtime match the last time it hashed correctly is trusted
 *     without re-hashing. Anything new, resized or touched is hashed in full, and only
 *     a successful hash ever enters the cache.
 *   - Cache misses are hashed with bounded concurrency instead of sequentially.
 *   - Progress is reported per file (count and bytes), not per stage.
 */
const fs   = require('fs-extra')
const path = require('path')
const { calculateHash, getLibraryDir, getVersionJarPath, getMojangOS, isLibraryCompatible } = require('helios-core/common')
const { HashAlgo, MojangIndexProcessor } = require('helios-core/dl')

const CACHE_FILE = '.verified-files.json'
const CACHE_VERSION = 1

/**
 * Everything the launch needs on disk, in the shape the download stage consumes
 * ({id, hash, algo, size, url, path}). Mirrors MojangIndexProcessor.validate* and
 * DistributionIndexProcessor.validateModules.
 *
 * @param {Object} mojang An initialised MojangIndexProcessor.
 * @param {Object} server The distribution server whose modules to check.
 * @returns {Array.<Object>} The checklist.
 */
exports.buildChecklist = function(mojang, server){
    const items = []
    const objectDir = path.join(mojang.assetPath, 'objects')
    for(const [id, entry] of Object.entries(mojang.assetIndex.objects)){
        const prefix = entry.hash.substring(0, 2)
        items.push({
            id,
            hash: entry.hash,
            algo: HashAlgo.SHA1,
            size: entry.size,
            url: `${MojangIndexProcessor.ASSET_RESOURCE_ENDPOINT}/${prefix}/${entry.hash}`,
            path: path.join(objectDir, prefix, entry.hash)
        })
    }

    const versionJson = mojang.versionJson
    const libDir = getLibraryDir(mojang.commonDir)
    for(const lib of versionJson.libraries){
        if(!isLibraryCompatible(lib.rules, lib.natives)){
            continue
        }
        const artifact = lib.natives == null
            ? lib.downloads.artifact
            : lib.downloads.classifiers[lib.natives[getMojangOS()].replace('${arch}', process.arch.replace('x', ''))]
        items.push({ id: lib.name, hash: artifact.sha1, algo: HashAlgo.SHA1, size: artifact.size, url: artifact.url, path: path.join(libDir, artifact.path) })
    }

    const client = versionJson.downloads.client
    items.push({ id: `${versionJson.id} client`, hash: client.sha1, algo: HashAlgo.SHA1, size: client.size, url: client.url, path: getVersionJarPath(mojang.commonDir, versionJson.id) })

    const logFile = versionJson.logging.client.file
    items.push({ id: logFile.id, hash: logFile.sha1, algo: HashAlgo.SHA1, size: logFile.size, url: logFile.url, path: path.join(mojang.assetPath, 'log_configs', logFile.id) })

    const walk = (modules) => {
        for(const module of modules){
            const artifact = module.rawModule.artifact
            items.push({ id: module.rawModule.id, hash: artifact.MD5, algo: HashAlgo.MD5, size: artifact.size, url: artifact.url, path: module.getPath() })
            if(module.hasSubModules()){
                walk(module.subModules)
            }
        }
    }
    walk(server.modules)
    return items
}

async function loadCache(cachePath){
    try {
        const data = await fs.readJson(cachePath)
        return data.version === CACHE_VERSION && data.files != null ? data.files : {}
    } catch {
        return {}
    }
}

async function saveCache(cachePath, files){
    const tmp = cachePath + '.tmp'
    await fs.writeJson(tmp, { version: CACHE_VERSION, files })
    await fs.move(tmp, cachePath, { overwrite: true })
}

/**
 * Check every item; resolves with the ones that are missing or fail their hash.
 *
 * @param {Array.<Object>} items From buildChecklist.
 * @param {Object} options
 * @param {string} options.cacheDir Where the verified-files cache lives (the common directory).
 * @param {number} [options.concurrency=8] Parallel hashes for cache misses.
 * @param {function} [options.onProgress] ({checked, total, percent}) at most every 100 ms, plus a final call.
 * @param {function} [options.hashFile] Injectable for tests; defaults to helios-core's calculateHash.
 * @returns {Promise.<Array.<Object>>} The invalid items.
 */
exports.verifyFiles = async function(items, options){
    const cachePath = path.join(options.cacheDir, CACHE_FILE)
    const concurrency = options.concurrency ?? 8
    const hashFile = options.hashFile ?? calculateHash
    const onProgress = options.onProgress ?? (() => {})

    const cache = await loadCache(cachePath)
    const nextCache = {}
    const invalid = []
    const total = items.length
    const totalBytes = items.reduce((sum, item) => sum + (item.size ?? 0), 0) || 1
    let checked = 0
    let checkedBytes = 0
    let lastReport = 0

    const report = (force) => {
        const now = Date.now()
        if(force || now - lastReport >= 100){
            lastReport = now
            onProgress({ checked, total, percent: Math.min(100, Math.trunc((checkedBytes / totalBytes) * 100)) })
        }
    }

    const check = async (item) => {
        let stat = null
        try {
            stat = await fs.stat(item.path)
        } catch {
            stat = null
        }
        if(stat == null || !stat.isFile()){
            invalid.push(item)
        } else if(item.hash == null){
            // No hash declared: existence is all the stock validator checks too.
        } else {
            const key = item.path
            const cached = cache[key]
            if(cached != null && cached.hash === item.hash && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs){
                nextCache[key] = cached
            } else {
                let actual = null
                try {
                    actual = await hashFile(item.path, item.algo)
                } catch {
                    actual = null
                }
                if(actual === item.hash){
                    nextCache[key] = { hash: item.hash, size: stat.size, mtimeMs: stat.mtimeMs }
                } else {
                    invalid.push(item)
                }
            }
        }
        checked++
        checkedBytes += item.size ?? 0
        report(false)
    }

    let next = 0
    const worker = async () => {
        while(next < items.length){
            const item = items[next++]
            await check(item)
        }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker))
    report(true)

    try {
        await saveCache(cachePath, nextCache)
    } catch {
        // A cache we can't write only costs the next launch a full hash.
    }
    return invalid
}

exports.CACHE_FILE = CACHE_FILE
