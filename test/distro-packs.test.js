const test   = require('node:test')
const assert = require('node:assert')
const path   = require('path')

/**
 * The distribution index's half of issue #15: the launcher's "High-detail
 * textures" toggle owns an exactly-known feature-mod set, and the texture
 * pack modules are staged in the generator but kept OUT of the live index
 * until the packs repo publishes metadata the game accepts. Catches drift
 * between the index, the toggle's exclusion list and the pack wiring.
 */
const distro = require('../distribution/distribution.json')
const HighDetail = require('../app/assets/js/highdetail')

const server = distro.servers[0]
const modules = server.modules
const byVersionless = new Map(modules.map(m => [m.id.split(':').slice(0, 2).join(':'), m]))

test('pack modules stay out of the live index while pack option writes are gated off', () => {
    // Smoke 40663424467: 26.3 rejects the packs repo's current metadata
    // from the folder-repository path ("Removed resource pack ... no
    // longer compatible"), so shipping the zips is 100 MB of dead weight
    // per player. They come back (via generate-distro.cjs, together with
    // the packOptionWritesEnabled flip) when the packs repo lands item 1.
    const packs = modules.filter(m => m.id.startsWith(HighDetail.BASE_PACK_MODULE_PREFIX)
        || m.id.startsWith(HighDetail.EFFECTS_PACK_MODULE_PREFIX))
    assert.strictEqual(packs.length, 0, 'no texture-pack File modules may ship while the gate is off')
})

test('the generator still carries the pack modules for the re-enable', () => {
    const generator = require('fs').readFileSync(
        path.join(__dirname, '..', 'scripts', 'generate-distro.cjs'), 'utf8')
    assert.ok(/Romanica_TexturePack_v2\.0\.9_26\.2_BASE\.zip/.test(generator), 'BASE pack declaration missing from the generator')
    assert.ok(/MINARECRAFTORVM_v2\.0\.1_26\.2_EFFECTS\.zip/.test(generator), 'EFFECTS pack declaration missing from the generator')
    assert.match(generator, /net\.romanica:texture-pack-base:/, 'BASE module id missing from the generator')
    assert.match(generator, /net\.romanica:texture-pack-effects:/, 'EFFECTS module id missing from the generator')
})

test('the high-detail toggle set and the distribution index agree exactly', () => {
    for(const id of HighDetail.HIGH_DETAIL_MOD_IDS){
        const module_ = byVersionless.get(id)
        assert.ok(module_ != null, `${id} must be present in the distribution index`)
        assert.deepStrictEqual(module_.required, { value: false, def: false },
            `${id} must be optional and default OFF (the toggle owns its default)`)
    }
    // No drift in the other direction: a def:false FabricMod that reads
    // EFFECTS features must be named in the toggle set.
    const toggled = new Set(HighDetail.HIGH_DETAIL_MOD_IDS)
    for(const module_ of modules){
        if(module_.type !== 'FabricMod' || module_.required == null || module_.required.def !== false){
            continue
        }
        const versionless = module_.id.split(':').slice(0, 2).join(':')
        if(path.basename(module_.artifact.url).match(/entitytexturefeatures|entity_model_features|polytone|skyboxify|yet_another_config_lib/)){
            assert.ok(toggled.has(versionless),
                `${versionless} ships def:false but is missing from highdetail.js HIGH_DETAIL_MOD_IDS`)
        }
    }
})

test('the pack ships exactly the owner-approved mod list (2026-11-15)', () => {
    const fabricMods = modules.filter(m => m.type === 'FabricMod')
    const ids = id => id.split(':').slice(0, 2).join(':').replace('com.modrinth:', '')
    const required = fabricMods.filter(m => m.required == null || m.required.value === true).map(m => ids(m.id)).sort()
    const onByDefault = fabricMods.filter(m => m.required && m.required.value === false && m.required.def === true).map(m => ids(m.id)).sort()
    const offByDefault = fabricMods.filter(m => m.required && m.required.value === false && m.required.def === false).map(m => ids(m.id)).sort()
    assert.deepStrictEqual(required, ['fabric-api', 'fabric-language-kotlin', 'net.imperiummc:imperium-client'].sort())
    assert.deepStrictEqual(onByDefault, ['sodium', 'lithium', 'immediatelyfast', 'entityculling', 'moreculling',
        'ferrite-core', 'dynamic-fps', 'modmenu', 'cloth-config', 'placeholder-api'].sort())
    assert.deepStrictEqual(offByDefault, ['iris', 'sodium-extra', 'reeses-sodium-options', 'distanthorizons'].sort())
})

test('the distro is honest about the launcher version it was generated at', () => {
    const pkg = require('../package.json')
    assert.strictEqual(server.version, pkg.version,
        'server.version is emitted from package.json by generate-distro.cjs; hand-edits must keep them in step')
})

test('no shipped URL references the retired ImperiumClient repo path', () => {
    for(const module_ of modules){
        assert.ok(!module_.artifact.url.includes('/ImperiumClient/'),
            `${module_.id} still points at the renamed ImperiumClient repo`)
    }
})
