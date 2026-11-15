const test   = require('node:test')
const assert = require('node:assert')
const fs     = require('fs-extra')
const os     = require('os')
const path   = require('path')

const { stubModule } = require('./helpers/stubs')

let highDetailState = { highDetail: false, effectsManaged: false, packWrites: false, saves: 0 }

stubModule(path.resolve(__dirname, '..', 'app', 'assets', 'js', 'configmanager.js'), {
    getMaxRAM: () => '4G',
    getMinRAM: () => '2G',
    getJVMOptions: () => [],
    getFullscreen: () => false,
    getHighDetailTextures: () => highDetailState.highDetail,
    getEffectsPackManaged: () => highDetailState.effectsManaged,
    setEffectsPackManaged: (v) => { highDetailState.effectsManaged = v === true; highDetailState.saves++ },
    getPackOptionWritesEnabled: () => highDetailState.packWrites,
    save: () => { highDetailState.saves++ }
})

const ProcessBuilder = require('../app/assets/js/processbuilder')
const HighDetail     = require('../app/assets/js/highdetail')
const PackPreferences = require('../app/assets/js/packpreferences')

// The shipped list is empty since the 2026-11-15 pack trim; the toggle mechanism is
// still tested against the former feature set.
const FIXTURE_IDS = ['com.modrinth:entitytexturefeatures', 'com.modrinth:entity-model-features',
    'com.modrinth:polytone', 'com.modrinth:skyboxify', 'com.modrinth:yet-another-config-lib']
function withFixtureIds(fn){
    const saved = HighDetail.HIGH_DETAIL_MOD_IDS
    HighDetail.HIGH_DETAIL_MOD_IDS = FIXTURE_IDS
    try { return fn() } finally { HighDetail.HIGH_DETAIL_MOD_IDS = saved }
}

const BASE_FILE = 'Romanica_TexturePack_v2.0.9_26.2_BASE.zip'
const EFFECTS_FILE = 'MINARECRAFTORVM_v2.0.1_26.2_EFFECTS.zip'

/**
 * A minimal stand-in for a helios HeliosModule.
 */
function module_(id, type, required, artifactPath){
    const groupArtifact = id.split(':').slice(0, 2).join(':')
    return {
        rawModule: { id, type, required, artifact: artifactPath != null ? { path: artifactPath } : {} },
        getRequired(){ return this.rawModule.required },
        getVersionlessMavenIdentifier(){ return groupArtifact },
        getPath(){ return `/mock/${id.replace(/:/g, '/')}.jar` },
        subModules: []
    }
}

function fabricMod(id, def = true){
    return module_(id, 'FabricMod', { value: false, def }, null)
}

function resolve(modules, modCfg, highDetail){
    return ProcessBuilder.prototype.resolveModConfiguration.call({}, modCfg, modules, highDetail)
}

test('master switch OFF keeps the feature mods out of the launch mod list', () => withFixtureIds(() => {
    const modules = [
        fabricMod('com.modrinth:entitytexturefeatures:7.2.6-fabric-26.3'),
        fabricMod('com.modrinth:entity-model-features:3.3.12-fabric-26.3'),
        fabricMod('com.modrinth:polytone:26.3-6.8.6'),
        fabricMod('com.modrinth:sodium:mc26.3-0.9.3-beta.1-fabric')
    ]
    // Even with the per-mod toggles stored as ON (as they were before the
    // feature became opt-in), the switch-off state must exclude them.
    const modCfg = {
        'com.modrinth:entitytexturefeatures': true,
        'com.modrinth:entity-model-features': true,
        'com.modrinth:polytone': true,
        'com.modrinth:sodium': true
    }
    const { fMods } = resolve(modules, modCfg, false)
    const ids = fMods.map(m => m.rawModule.id)
    assert.ok(!ids.some(id => id.startsWith('com.modrinth:entitytexturefeatures')), 'ETF must be excluded when High-detail is off')
    assert.ok(!ids.some(id => id.startsWith('com.modrinth:entity-model-features')),
        'EMF must be excluded together with ETF (it hard-depends on ETF: smoke run 40662809626)')
    assert.ok(!ids.some(id => id.startsWith('com.modrinth:polytone')), 'PolyTone must be excluded when High-detail is off')
    assert.ok(ids.some(id => id.startsWith('com.modrinth:sodium')), 'non-feature mods are unaffected by the switch')
}))

test('master switch ON leaves the per-mod toggles in charge', () => {
    const modules = [
        fabricMod('com.modrinth:entitytexturefeatures:7.2.6-fabric-26.3'),
        fabricMod('com.modrinth:sodium:mc26.3-0.9.3-beta.1-fabric')
    ]
    const on = resolve(modules, {
        'com.modrinth:entitytexturefeatures': true,
        'com.modrinth:sodium': true
    }, true)
    assert.strictEqual(on.fMods.length, 2, 'with the switch on, stored ON values launch')

    const trimmed = resolve(modules, {
        'com.modrinth:entitytexturefeatures': false,
        'com.modrinth:sodium': true
    }, true)
    const trimmedIds = trimmed.fMods.map(m => m.rawModule.id)
    assert.ok(!trimmedIds.some(id => id.startsWith('com.modrinth:entitytexturefeatures')),
        'a player who disables a feature mod in the Mods tab keeps it disabled even with the switch on')
})

test('the exclusion list matches the ids the distribution ships', () => {
    const distro = require('../distribution/distribution.json')
    const versionless = new Set(distro.servers[0].modules.map(m => m.id.split(':').slice(0, 2).join(':')))
    for(const id of HighDetail.HIGH_DETAIL_MOD_IDS){
        assert.ok(versionless.has(id), `feature mod ${id} must exist in the distribution index`)
    }
})

test('the real launch path (resolveLaunchMods, the call build() makes) carries the switch', () => withFixtureIds(() => {
    // Guards the exact wiring build() uses: a resolveModConfiguration that
    // ignores ConfigManager.getHighDetailTextures() would make the setting
    // a no-op in production while direct-call tests still passed.
    highDetailState.highDetail = false
    const fakeThis = {
        resolveModConfiguration: ProcessBuilder.prototype.resolveModConfiguration,
        server: { rawServer: { id: 'Romanica' }, modules: [
            fabricMod('com.modrinth:entitytexturefeatures:7.2.6-fabric-26.3'),
            fabricMod('com.modrinth:sodium:mc26.3-0.9.3-beta.1-fabric')
        ] }
    }
    const ConfigManager = require('../app/assets/js/configmanager')
    ConfigManager.getModConfiguration = (_serverId) => ({
        mods: {
            'com.modrinth:entitytexturefeatures': true,
            'com.modrinth:sodium': true
        }
    })

    const off = ProcessBuilder.prototype.resolveLaunchMods.call(fakeThis)
    const offIds = off.fMods.map(m => m.rawModule.id)
    assert.ok(!offIds.some(id => id.startsWith('com.modrinth:entitytexturefeatures')),
        'with the switch off, the launch mod list excludes the feature mods')
    assert.ok(offIds.some(id => id.startsWith('com.modrinth:sodium')))

    highDetailState.highDetail = true
    const on = ProcessBuilder.prototype.resolveLaunchMods.call(fakeThis)
    assert.strictEqual(on.fMods.length, 2, 'with the switch on, the stored toggles launch')
}))

test('the pack preference wiring runs at launch: options.txt entries + managed flag', async (t) => {
    const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'romanica-pb-packs-'))
    t.after(() => fs.remove(gameDir))

    // Ships disabled (smoke run 40663424467: the packs repo's metadata is
    // rejected by 26.3): with the gate off, the launch must not write
    // options.txt at all.
    highDetailState = { highDetail: true, effectsManaged: false, packWrites: false, saves: 0 }
    const fakeThis = {
        gameDir,
        server: { rawServer: { id: 'Romanica' }, modules: [
            module_('net.romanica:texture-pack-base:2.0.9', 'File', { value: true, def: true }, `resourcepacks/${BASE_FILE}`),
            module_('net.romanica:texture-pack-effects:2.0.1', 'File', { value: false, def: false }, `resourcepacks/${EFFECTS_FILE}`)
        ] }
    }
    ProcessBuilder.prototype.applyResourcePackPreferences.call(fakeThis)
    assert.strictEqual(await fs.pathExists(path.join(gameDir, 'options.txt')), false,
        'with the gate off (default), the launch must not create or touch options.txt')

    // Gate on: the full first-install behavior.
    highDetailState.packWrites = true
    ProcessBuilder.prototype.applyResourcePackPreferences.call(fakeThis)

    const text = fs.readFileSync(path.join(gameDir, 'options.txt'), 'UTF-8')
    const entries = PackPreferences.parseResourcePacks(text).entries
    assert.deepStrictEqual(entries, ['vanilla', `file/${EFFECTS_FILE}`, `file/${BASE_FILE}`],
        'first install: BASE enabled, and with the toggle on EFFECTS sits above it')
    assert.strictEqual(highDetailState.effectsManaged, true, 'the launcher must record ownership of the EFFECTS entry')
    assert.ok(highDetailState.saves > 0, 'the managed flag must be persisted')

    // Toggle off at the next launch: the launcher removes its own entry.
    highDetailState.highDetail = false
    ProcessBuilder.prototype.applyResourcePackPreferences.call(fakeThis)
    const after = PackPreferences.parseResourcePacks(fs.readFileSync(path.join(gameDir, 'options.txt'), 'UTF-8')).entries
    assert.deepStrictEqual(after, ['vanilla', `file/${BASE_FILE}`], 'toggle-off removes the launcher-managed EFFECTS entry')
    assert.strictEqual(highDetailState.effectsManaged, false, 'ownership is cleared after removal')
})

test('enabled Fabric mods reach the --fabric.addMods argument file', async (t) => {
    const gameDir = await fs.mkdtemp(path.join(os.tmpdir(), 'romanica-pb-modlist-'))
    t.after(() => fs.remove(gameDir))

    const enabled = [fabricMod('com.modrinth:sodium:mc26.3-0.9.3-beta.1-fabric')]
    enabled[0].getPath = () => path.join(gameDir, 'sodium.jar')
    const fakeThis = { usingFabricLoader: true, forgeModListFile: path.join(gameDir, 'forgeMods.list') }

    const args = ProcessBuilder.prototype.constructModList.call(fakeThis, enabled)
    assert.deepStrictEqual(args, ['--fabric.addMods', `@${path.join(gameDir, 'forgeMods.list')}`])
    const list = fs.readFileSync(fakeThis.forgeModListFile, 'UTF-8')
    assert.strictEqual(list, path.join(gameDir, 'sodium.jar'), 'the mod list file names the enabled mod files')

    assert.deepStrictEqual(ProcessBuilder.prototype.constructModList.call(fakeThis, []), [],
        'no enabled mods means no mod list argument at all')
})
