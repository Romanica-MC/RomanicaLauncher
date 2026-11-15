const test   = require('node:test')
const assert = require('node:assert')
const fs     = require('fs-extra')
const path   = require('path')

const { sandboxElectron } = require('./helpers/stubs')
const { userData } = sandboxElectron()

const ConfigManager = require('../app/assets/js/configmanager')
const HighDetail    = require('../app/assets/js/highdetail')

const configPath = path.join(userData, 'config.json')

test('highDetailTextures defaults to false and round-trips through config.json', () => {
    if(fs.existsSync(configPath)){
        fs.removeSync(configPath)
    }
    ConfigManager.load()
    assert.strictEqual(ConfigManager.getHighDetailTextures(), false, 'the toggle must default to off (issue #15)')
    assert.strictEqual(ConfigManager.getEffectsPackManaged(), false)

    ConfigManager.setHighDetailTextures(true)
    ConfigManager.save()
    ConfigManager.load()
    assert.strictEqual(ConfigManager.getHighDetailTextures(), true, 'the toggle must survive a save/load round-trip')

    ConfigManager.setHighDetailTextures(false)
    ConfigManager.setEffectsPackManaged(true)
    ConfigManager.save()
    ConfigManager.load()
    assert.strictEqual(ConfigManager.getHighDetailTextures(), false)
    assert.strictEqual(ConfigManager.getEffectsPackManaged(), true, 'effectsPackManaged must round-trip')
})

test('a config written before the toggle gains the defaults on load', () => {
    // A pre-issue-#15 config has no settings.game.highDetailTextures key.
    const legacy = {
        settings: { game: { resWidth: 1280, resHeight: 720, fullscreen: false, autoConnect: true, launchDetached: true } },
        newsCache: { date: null, content: null, dismissed: false },
        clientToken: null,
        selectedServer: null,
        selectedAccount: null,
        authenticationDatabase: {},
        modConfigurations: [],
        javaConfig: {}
    }
    fs.writeFileSync(configPath, JSON.stringify(legacy, null, 4), 'UTF-8')
    ConfigManager.load()
    assert.strictEqual(ConfigManager.getHighDetailTextures(), false, 'missing key must resolve to the default')
    const onDisk = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    assert.strictEqual(onDisk.settings.game.highDetailTextures, false, 'the default must be persisted')
    assert.strictEqual(onDisk.settings.game.effectsPackManaged, false)
})

test('setHighDetailTextures coerces to a real boolean', () => {
    ConfigManager.load()
    ConfigManager.setHighDetailTextures('yes')
    assert.strictEqual(ConfigManager.getHighDetailTextures(), false, 'truthy non-boolean must not enable the toggle')
    ConfigManager.setHighDetailTextures(true)
    assert.strictEqual(ConfigManager.getHighDetailTextures(), true)
})

test('pack option writes are gated off until the packs repo metadata is accepted', () => {
    if(fs.existsSync(configPath)){
        fs.removeSync(configPath)
    }
    ConfigManager.load()
    assert.strictEqual(ConfigManager.getPackOptionWritesEnabled(), false,
        'the launcher must not write resourcePacks entries while the game rejects the pack metadata (smoke 40663424467)')
    ConfigManager.setPackOptionWritesEnabled(true)
    ConfigManager.save()
    ConfigManager.load()
    assert.strictEqual(ConfigManager.getPackOptionWritesEnabled(), true, 'the gate must round-trip')
    ConfigManager.setPackOptionWritesEnabled(false)
})

// The shipped list is empty since the 2026-11-15 pack trim; the toggle mechanism is
// still tested against the former feature set.
const FIXTURE_IDS = ['com.modrinth:entitytexturefeatures', 'com.modrinth:entity-model-features',
    'com.modrinth:polytone', 'com.modrinth:skyboxify', 'com.modrinth:yet-another-config-lib']
function withFixtureIds(fn){
    const saved = HighDetail.HIGH_DETAIL_MOD_IDS
    HighDetail.HIGH_DETAIL_MOD_IDS = FIXTURE_IDS
    try { return fn() } finally { HighDetail.HIGH_DETAIL_MOD_IDS = saved }
}

test('reconcileModConfigs flips exactly the feature mods that are configured', () => withFixtureIds(() => {
    const calls = []
    const fakeConfig = {
        modConfigurations: [
            { id: 'Romanica', mods: {
                'com.modrinth:entitytexturefeatures': true,
                'com.modrinth:polytone': false,
                'com.modrinth:sodium': true
            } },
            { id: 'OtherServer', mods: {
                'com.modrinth:skyboxify': { value: true, mods: {} },
                'com.modrinth:yet-another-config-lib': true
            } }
        ],
        getModConfigurations(){ return this.modConfigurations }
    }
    HighDetail.reconcileModConfigs(fakeConfig, false)
    const romanica = fakeConfig.modConfigurations[0].mods
    const other = fakeConfig.modConfigurations[1].mods
    assert.strictEqual(romanica['com.modrinth:entitytexturefeatures'], false, 'feature mods must follow the switch')
    assert.strictEqual(romanica['com.modrinth:polytone'], false)
    assert.strictEqual(romanica['com.modrinth:sodium'], true, 'non-feature mods are never touched')
    assert.strictEqual(other['com.modrinth:skyboxify'].value, false, 'object-shaped entries flip their value')
    assert.strictEqual(other['com.modrinth:yet-another-config-lib'], false)

    HighDetail.reconcileModConfigs(fakeConfig, true)
    assert.strictEqual(romanica['com.modrinth:entitytexturefeatures'], true)
    assert.strictEqual(other['com.modrinth:skyboxify'].value, true)
    assert.strictEqual(romanica['com.modrinth:sodium'], true)
    assert.ok(calls.length === 0)
}))

test('the bootstrap exposes the feature mod id list to the renderer mirror', () => {
    // bridge.js reads Imperium.env.highDetailModIds; the launcher's single
    // source of truth must keep that list an array of id-shaped entries (empty since the 2026-11-15 pack trim).
    assert.ok(Array.isArray(HighDetail.HIGH_DETAIL_MOD_IDS))
    for(const id of HighDetail.HIGH_DETAIL_MOD_IDS){
        assert.match(id, /^com\.modrinth:[a-z0-9-]+$/, `feature id ${id} must be a versionless maven id`)
    }
})
