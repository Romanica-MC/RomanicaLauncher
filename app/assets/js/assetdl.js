/**
 * assetdl.js — Romanica launcher asset download pipeline.
 *
 * Forked from helios-core 2.3.0's FullRepair
 * (dist/dl/receivers/FullRepairReceiver.js receiver, dist/dl/AssetGaurdTransmitter.js
 * transmitter). Re-diff against those files when pulling in upstream fixes.
 *
 * Two roles in one module:
 *
 *  1. When forked as a child process (by ImperiumRepair.spawnReceiver),
 *     it acts as the receiver: validates the selected server's files and
 *     downloads the invalid ones. It extends the stock helios-core
 *     FullRepair protocol with two additional messages so the UI can show
 *     per-artifact progress and retry state:
 *
 *       { response: 'downloadFile',  name, index, count, percent }
 *       { response: 'downloadRetry', name, attempt, max, delayMs }
 *
 *     Each artifact is retried up to MAX_RETRIES times with exponential
 *     backoff (1s / 2s / 4s) before the whole sync is declared failed.
 *
 *     Unlike upstream, EVERY completed download is verified against the
 *     distro hash regardless of the received size: a same-size corrupt
 *     file must never pass. A mismatch deletes the file and counts as a
 *     failed attempt, so the retry ladder applies; after the final attempt
 *     the sync fails with "<file> failed verification" and the game is
 *     never spawned. SHA-256 is preferred whenever the distro carries it
 *     (artifact.sha256), with MD5 kept as the fallback.
 *
 *  2. When required from the renderer (landing.js), it exports
 *     ImperiumRepair, the transmitter half. It mirrors the public surface
 *     of helios-core's FullRepair (spawnReceiver/destroyReceiver/
 *     childProcess/verifyFiles/download) so it can be dropped in without
 *     touching the rest of the launch flow.
 *
 * The receiver reimplements the validate/download stages with
 * helios-core's public API (DistributionAPI, MojangIndexProcessor,
 * DistributionIndexProcessor) so the behavior stays identical to the
 * upstream FullRepairReceiver, with the retry, verification and per-file
 * events added.
 */

const childProcess = require('child_process')
const fs = require('fs-extra')
const path = require('path')
const got = require('got')
const { pipeline } = require('stream/promises')

const { LoggerUtil } = require('helios-core')
const { DistributionAPI, validateLocalFile } = require('helios-core/common')
const { buildChecklist, verifyFiles } = require('./fileverifier')
const {
    MojangIndexProcessor,
    DistributionIndexProcessor,
    getExpectedDownloadSize
} = require('helios-core/dl')

const log = LoggerUtil.getLogger('AssetDL')

/* Receiver constants. */

// Retries per artifact after the initial attempt (3 retries => 4 attempts total).
const MAX_RETRIES = 3
// Base delay for the exponential backoff: 1s, 2s, 4s.
const RETRY_BASE_DELAY_MS = Number.parseInt(process.env.ASSETDL_RETRY_BASE_MS || '1000', 10) || 1000
// Parallel downloads, matches helios-core's downloadQueue concurrency.
const CONCURRENCY = 15
// Minimum interval between per-file progress messages for a single file (~4/s).
const FILE_EVENT_MIN_INTERVAL_MS = 250

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Build a safe file name from a module id when the distribution-provided
 * name is absent (issue #14): every maven component is squashed into a
 * slug, so a missing component can never leak the literal string
 * "undefined" into a file name.
 *
 * @param {string} id The module id (e.g. "com.modrinth.sodium:0.9.3").
 * @returns {string} Slugified file name ending in ".jar".
 */
function fallbackFilenameFromId(id) {
    let slug = id == null ? '' : String(id)
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
    if(slug === 'undefined' || slug === 'null' || slug === 'nan') {
        slug = ''
    }
    return `${slug || 'module'}.jar`
}

/**
 * A local path is unnameable when any of its segments was produced from an
 * `undefined` maven component (helios-core renders a missing version as the
 * literal string "undefined", e.g. ".../sodium/0.9.3/undefined/0.9.3-undefined.jar").
 *
 * @param {string} targetPath The asset's destination path.
 * @returns {boolean} True when the path contains an "undefined" segment.
 */
function hasUndefinedSegment(targetPath) {
    return path.normalize(targetPath)
        .split(path.sep)
        .some(segment => segment === 'undefined' || segment === 'undefined.jar')
}

/**
 * Refuse to download any artifact whose destination contains an
 * "undefined" path segment. Such a path means the distribution module's
 * maven id is malformed (a missing component); writing the file would
 * recreate the "...-undefined.jar" litter of issue #14. The sync fails
 * with an actionable error instead, naming the slugified file name the
 * generator fallback would have produced.
 *
 * @param {Array.<{id: string, path: string}>} assets Assets about to be downloaded.
 * @throws {Error} displayable error naming the first offending module.
 */
function assertNoUndefinedPaths(assets) {
    for(const asset of assets) {
        if(hasUndefinedSegment(asset.path)) {
            const displayable = `File ${path.basename(asset.path)} has an invalid name.`
            const cause = `distribution module ${asset.id} resolved to "${asset.path}" — its id is missing a maven component (expected "${fallbackFilenameFromId(asset.id)}"). The pack index must be fixed; refusing to download as "undefined".`
            const wrapped = new Error(`${displayable} (${cause})`)
            wrapped.displayable = `${displayable}<br><span style="font-size: 10px;">${cause}</span>`
            throw wrapped
        }
    }
}

/**
 * Convert a caught error into a user displayable message,
 * mirroring helios-core FullRepairReceiver.parseError.
 */
function parseDisplayableError(error) {
    if(error instanceof got.RequestError) {
        if(error?.request?.requestUrl) {
            log.debug(`Error during request to ${error.request.requestUrl}`)
        }
        if(error instanceof got.HTTPError) {
            return `Error during request (HTTP Response ${error.response.statusCode})`
        } else if(error.name === 'RequestError') {
            return `Request received no response (${error.code}).`
        } else if(error instanceof got.TimeoutError) {
            return `Request timed out (${error.timings.phases.total}ms).`
        } else if(error instanceof got.ParseError) {
            return 'Request received unexepected body (Parse Error).'
        } else if(error instanceof got.ReadError) {
            return `Read Error (${error.code}): ${error.message}.`
        }
        return 'Error during request.'
    }
    return undefined
}

/* Receiver implementation. */

const receiver = {
    processors: [],
    assets: [],
    sha256ById: {}
}

/**
 * Pick the strongest hash an asset can be verified with: the distro's
 * sha256 when it carries one, the processor-provided hash otherwise
 * (MD5 for distro modules, SHA-1 for Mojang artifacts).
 *
 * @param {Object} asset An asset produced by the validate stage.
 * @param {{[id: string]: string}} sha256ById sha256 hashes keyed by module id.
 * @returns {{algo: string, hash: string}} The verification to run.
 */
function pickVerification(asset, sha256ById) {
    const sha256 = sha256ById?.[asset.id]
    if(typeof sha256 === 'string' && sha256.length > 0) {
        return { algo: 'sha256', hash: sha256 }
    }
    return { algo: asset.algo, hash: asset.hash }
}

/**
 * Walk the server's module tree and index every artifact that carries a
 * sha256, so downloads can be verified against it in pickVerification.
 *
 * @param {Array.<Object>} modules Distribution modules (raw model objects).
 * @returns {{[id: string]: string}} sha256 hashes keyed by module id.
 */
function collectSha256(modules) {
    const sha256ById = {}
    const walk = (mods) => {
        for(const module of mods ?? []){
            const artifact = module.rawModule?.artifact
            if(typeof artifact?.sha256 === 'string' && artifact.sha256.length > 0) {
                sha256ById[module.rawModule.id] = artifact.sha256
            }
            walk(module.subModules ?? [])
        }
    }
    walk(modules)
    return sha256ById
}

/**
 * Validate stage: the files helios-core's FullRepairReceiver.validate checks, via fileverifier.
 */
async function receiverValidate(message) {
    const api = new DistributionAPI(
        message.launcherDirectory,
        message.commonDirectory,
        message.instanceDirectory,
        null, // Local pull only, the main process handles refreshes.
        message.devMode
    )
    const distribution = await api.getDistributionLocalLoadOnly()
    const server = distribution.getServerById(message.serverId)

    // Index distro-declared sha256 hashes for the download-stage verification.
    receiver.sha256ById = collectSha256(server?.modules ?? [])

    const mojangIndexProcessor = new MojangIndexProcessor(message.commonDirectory, server.rawServer.minecraftVersion)
    const distributionIndexProcessor = new DistributionIndexProcessor(message.commonDirectory, distribution, message.serverId)

    receiver.processors = [
        mojangIndexProcessor,
        distributionIndexProcessor
    ]

    for(const processor of receiver.processors) {
        await processor.init()
    }

    // Same files helios-core's validate stage checks, but cached, parallel and
    // reported per file (see fileverifier.js).
    receiver.assets = await verifyFiles(buildChecklist(mojangIndexProcessor, server), {
        cacheDir: message.commonDirectory,
        onProgress: ({ checked, total, percent }) => {
            process.send({ response: 'validateProgress', percent, checked, total })
        }
    })
    process.send({ response: 'validateComplete', invalidCount: receiver.assets.length })
}

/**
 * Download stage with per-artifact retry and per-file progress events.
 *
 * @param {Object} message Optional. May carry an `assets` array to
 * download instead of the set produced by the validate stage. The
 * transmitter never sends one; it exists so the stage can be driven
 * standalone (diagnostics, tests).
 */
async function receiverDownload(message = {}) {
    if(Array.isArray(message.assets)) {
        receiver.assets = message.assets
    }
    const assets = receiver.assets
    // Issue #14: never write a file whose name was built from an undefined
    // maven component. Fail the sync before a single byte is fetched.
    assertNoUndefinedPaths(assets)
    const count = assets.length
    const expectedTotalSize = getExpectedDownloadSize(assets)
    log.debug(`Downloading ${count} artifacts, expected size ${expectedTotalSize} bytes.`)
    assets.forEach(({ id }) => log.debug(`Asset Requires Download: ${id}`))

    // Aggregate progress accounting, robust to a file restarting after a retry.
    const receivedEach = {}
    let received = 0
    let currentPercent = expectedTotalSize > 0 ? -1 : 100

    // Per-file progress throttling state.
    const lastFileEmit = {}

    function sendAggregateProgress() {
        if(expectedTotalSize <= 0) {
            return
        }
        const nextPercent = Math.max(0, Math.min(100, Math.trunc((received / expectedTotalSize) * 100)))
        if(nextPercent !== currentPercent) {
            currentPercent = nextPercent
            process.send({ response: 'downloadProgress', percent: currentPercent })
        }
    }

    function sendFileProgress(asset, index, transferredThisFile) {
        const now = Date.now()
        if(lastFileEmit[asset.id] != null && (now - lastFileEmit[asset.id]) < FILE_EVENT_MIN_INTERVAL_MS) {
            return
        }
        lastFileEmit[asset.id] = now
        let percent = null
        if(asset.size > 0) {
            percent = Math.max(0, Math.min(100, Math.trunc((transferredThisFile / asset.size) * 100)))
        }
        process.send({ response: 'downloadFile', name: path.basename(asset.path), index, count, percent })
    }

    /**
     * Stream a single artifact to disk, updating aggregate + per-file progress.
     */
    async function streamArtifact(asset, index) {
        await fs.ensureDir(path.dirname(asset.path))
        const downloadStream = got.stream(asset.url)
        const fileWriterStream = fs.createWriteStream(asset.path)
        downloadStream.on('downloadProgress', ({ transferred }) => {
            const previous = receivedEach[asset.id] || 0
            if(transferred > previous) {
                received += transferred - previous
                receivedEach[asset.id] = transferred
                sendAggregateProgress()
                sendFileProgress(asset, index, transferred)
            }
        })
        try {
            await pipeline(downloadStream, fileWriterStream)
        } finally {
            fileWriterStream.destroy()
        }
    }

    /**
     * Download one artifact with bounded retry and exponential backoff.
     * Every completed download is verified against the distro hash; a
     * mismatch deletes the file and counts as a failed attempt so the
     * same ladder applies as for network errors. Emits a downloadRetry
     * message before each retry so the UI can display a "retrying (n/3)"
     * state.
     */
    async function downloadArtifact(asset, index) {
        const name = path.basename(asset.path)
        const verification = pickVerification(asset, receiver.sha256ById)
        for(let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if(attempt > 0) {
                const delayMs = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1)
                log.warn(`Retry ${attempt}/${MAX_RETRIES} for ${asset.id} in ${delayMs}ms.`)
                process.send({ response: 'downloadRetry', name, attempt, max: MAX_RETRIES, delayMs })
                await sleep(delayMs)
                // Restart accounting for this artifact so the aggregate bar stays truthful.
                received -= receivedEach[asset.id] || 0
                receivedEach[asset.id] = 0
                sendAggregateProgress()
            }
            try {
                await streamArtifact(asset, index)
            } catch(err) {
                log.error(`Download attempt ${attempt + 1}/${MAX_RETRIES + 1} failed for ${asset.id}: ${err.message || err}`)
                if(attempt === MAX_RETRIES) {
                    const displayable = `File ${name} failed to download after ${MAX_RETRIES + 1} attempts.`
                    const cause = parseDisplayableError(err) || err.message || String(err)
                    const wrapped = new Error(`${displayable} (${cause})`)
                    wrapped.displayable = `${displayable}<br><span style="font-size: 10px;">${cause}</span>`
                    throw wrapped
                }
                continue
            }

            // Verify every download against the distro hash, whatever the
            // received size: a corrupt file with an intact size must not pass.
            const verified = await validateLocalFile(asset.path, verification.algo, verification.hash)
            if(verified) {
                if(asset.size !== receivedEach[asset.id]) {
                    log.warn(`Asset ${asset.id} declared a size of ${asset.size} bytes, but ${receivedEach[asset.id]} were received (hash valid).`)
                }
                return
            }

            log.error(`Download attempt ${attempt + 1}/${MAX_RETRIES + 1} failed verification for ${asset.id} (${verification.algo} mismatch).`)
            // Never leave an unverified file on disk for the next sync to trust.
            await fs.remove(asset.path)
            if(attempt === MAX_RETRIES) {
                const displayable = `File ${name} failed verification.`
                const cause = `hash mismatch (${verification.algo}) after ${MAX_RETRIES + 1} attempts`
                const wrapped = new Error(`${displayable} (${cause})`)
                wrapped.displayable = `${displayable}<br><span style="font-size: 10px;">${cause}</span>`
                throw wrapped
            }
        }
    }

    // Worker pool, same concurrency as helios-core's fastq queue.
    let nextIndex = 0
    const workerCount = Math.max(1, Math.min(CONCURRENCY, count))
    const workers = []
    for(let w = 0; w < workerCount; w++) {
        workers.push((async () => {
            while(true) {
                const index = nextIndex++
                if(index >= count) {
                    return
                }
                await downloadArtifact(assets[index], index + 1)
            }
        })())
    }
    await Promise.all(workers)

    // Every artifact has been hash-verified inline by downloadArtifact, no
    // post-pass required.
    for(const processor of receiver.processors) {
        await processor.postDownload()
    }

    if(expectedTotalSize > 0) {
        process.send({ response: 'downloadProgress', percent: 100 })
    }
    process.send({ response: 'downloadComplete' })
}

/**
 * Receiver entry, active when this file is forked as a child process.
 */
function startReceiverLoop() {
    log.info('Receiver process started.')

    process.on('message', async (message) => {
        try {
            switch(message.action) {
                case 'validate':
                    await receiverValidate(message)
                    break
                case 'download':
                    await receiverDownload(message)
                    break
            }
        } catch(err) {
            log.error('Error during receiver operation.')
            log.error(err)
            process.send({
                response: 'error',
                displayable: err.displayable || parseDisplayableError(err)
            })
            // Match helios-core: terminate on first unhandled error.
            setImmediate(() => process.exit(1))
        }
    })

    process.on('disconnect', () => {
        log.info('Disconnect signal received, shutting down.')
        process.exit(0)
    })
}

/* Transmitter implementation. */

/**
 * Drop-in replacement for helios-core's FullRepair transmitter which
 * forks this same file as the receiver, translating the extended
 * message protocol into callbacks.
 */
class ImperiumRepair {
    constructor(commonDirectory, instanceDirectory, launcherDirectory, serverId, devMode) {
        this.commonDirectory = commonDirectory
        this.instanceDirectory = instanceDirectory
        this.launcherDirectory = launcherDirectory
        this.serverId = serverId
        this.devMode = devMode
        this.receiver = null
    }

    spawnReceiver() {
        if(this.receiver != null) {
            throw new Error('Receiver already spawned!')
        }
        this.receiver = childProcess.fork(__filename, [], { stdio: 'pipe' })
        this.receiver.stdio[1].setEncoding('utf8')
        this.receiver.stdio[1].on('data', (data) => {
            `${data}`.trim().split('\n')
                .forEach(line => console.log(`\x1b[32m[_]\x1b[0m ${line}`))
        })
        this.receiver.stdio[2].setEncoding('utf8')
        this.receiver.stdio[2].on('data', (data) => {
            `${data}`.trim().split('\n')
                .forEach(line => console.log(`\x1b[31m[_]\x1b[0m ${line}`))
        })
    }

    destroyReceiver() {
        if(this.receiver != null) {
            this.receiver.disconnect()
            this.receiver = null
        }
    }

    get childProcess() {
        return this.receiver
    }

    verifyFiles(onProgress) {
        return new Promise((resolve, reject) => {
            const onMessageHandle = (message) => {
                switch(message.response) {
                    case 'validateProgress':
                        log.debug('Received validate progress ' + message.percent)
                        onProgress(message.percent, message.checked, message.total)
                        break
                    case 'validateComplete':
                        log.info('Received validation complete.')
                        this.receiver.removeListener('message', onMessageHandle)
                        resolve(message.invalidCount)
                        break
                    case 'error':
                        log.error('Received error.')
                        this.receiver.removeListener('message', onMessageHandle)
                        this.destroyReceiver()
                        reject(message)
                        break
                }
            }
            this.receiver.on('message', onMessageHandle)
            this.receiver.send({
                action: 'validate',
                commonDirectory: this.commonDirectory,
                instanceDirectory: this.instanceDirectory,
                launcherDirectory: this.launcherDirectory,
                serverId: this.serverId,
                devMode: this.devMode
            })
        })
    }

    /**
     * @param {function} onProgress Aggregate percent callback (0-100).
     * @param {function} onFileProgress Per-artifact callback
     * ({name, index, count, percent}), throttled to ~4/s per file.
     * @param {function} onRetry Retry notification callback
     * ({name, attempt, max, delayMs}).
     */
    download(onProgress, onFileProgress = null, onRetry = null) {
        return new Promise((resolve, reject) => {
            const onMessageHandle = (message) => {
                switch(message.response) {
                    case 'downloadProgress':
                        log.debug('Received download progress ' + message.percent)
                        onProgress(message.percent)
                        break
                    case 'downloadFile':
                        if(onFileProgress != null) {
                            onFileProgress(message)
                        }
                        break
                    case 'downloadRetry':
                        log.warn(`Received retry ${message.attempt}/${message.max} for ${message.name}`)
                        if(onRetry != null) {
                            onRetry(message)
                        }
                        break
                    case 'downloadComplete':
                        log.info('Received download complete.')
                        this.receiver.removeListener('message', onMessageHandle)
                        resolve()
                        break
                    case 'error':
                        log.error('Received error.')
                        this.receiver.removeListener('message', onMessageHandle)
                        this.destroyReceiver()
                        reject(message)
                        break
                }
            }
            this.receiver.on('message', onMessageHandle)
            this.receiver.send({
                action: 'download'
            })
        })
    }
}

exports.ImperiumRepair = ImperiumRepair
exports.MAX_RETRIES = MAX_RETRIES
exports.RETRY_BASE_DELAY_MS = RETRY_BASE_DELAY_MS
// Exposed for tests: hash selection for the post-download verification.
exports.pickVerification = pickVerification
// Exposed for tests / diagnostics: issue #14 undefined-name defenses.
exports.fallbackFilenameFromId = fallbackFilenameFromId
exports.hasUndefinedSegment = hasUndefinedSegment
exports.assertNoUndefinedPaths = assertNoUndefinedPaths

// Fork guard: only run the receiver loop when executed as a child process.
if(process.send != null && process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
    startReceiverLoop()
}
