/**
 * highdetail.js — the "High-detail textures" feature set (issue #15).
 *
 * The Romanica texture pack ships in two layers: BASE (the plain pack the
 * server pushes on join) and EFFECTS (OptiFine-style features: connected
 * textures, random mob textures, animated textures, colormaps, custom
 * skies). The EFFECTS layer needs client mods to read those features, and
 * they cost memory and FPS, so the whole layer sits behind a launcher
 * setting that defaults to OFF.
 *
 * This module is the single source of truth shared by the launch path
 * (processbuilder), the settings IPC (ipc.js) and the distribution tests:
 *
 *   - HIGH_DETAIL_MOD_IDS are the optional Fabric mods that read the
 *     EFFECTS features. When the setting is OFF they are force-excluded
 *     from the launch mod list, whatever the per-mod toggles in the Mods
 *     tab say (issue #15: "when off, they're left out of the mod list").
 *     When ON, the per-mod toggles rule, so players can still fine-tune.
 *   - BASE_PACK_MODULE_PREFIX / EFFECTS_PACK_MODULE_PREFIX identify the
 *     resource pack File modules in the distribution index, so the launch
 *     path can wire options.txt without hard-coding pack file names.
 *
 * Boundary (why this lives in the launcher): the server pushes the BASE
 * pack itself on join, and the in-game Romanica menu owns the same
 * preference while the game runs (RomanicaClient#28, writes the file the
 * launcher reads at the next launch). The launcher's half is exactly:
 * persist the preference, resolve the mods at launch, and manage the
 * resourcePacks entries in the instance's options.txt.
 */

/**
 * Versionless maven ids of the optional mods that read EFFECTS-pack
 * features. Kept in sync with distribution/distribution.json —
 * test/distro-packs.test.js fails if the two drift apart.
 *
 *   entitytexturefeatures  random/varied mob textures
 *   entity-model-features  custom mob models; EMF hard-depends on ETF at
 *                          the loader level (smoke run 40662809626: EMF
 *                          on + ETF force-excluded = mod resolution
 *                          failure, game never reached the title screen),
 *                          so the pair lives or dies with the toggle
 *   polytone               colormaps + custom fonts
 *   skyboxify              custom sky
 *   yet-another-config-lib config lib skyboxify depends on
 *
 * Deliberately NOT here:
 *   continuity  owner directive 2026-10-25: breaks the pack's textures in
 *               play; do not re-add without an in-game check.
 *   animatica   animated textures reader — no 26.3 Modrinth build to pin
 *               yet; add it here (and to the distro) when one exists.
 */
// Owner directive 2026-11-15 trimmed the pack to a fixed mod list without the
// EFFECTS readers, so the toggle now only governs the texture-pack layer.
exports.HIGH_DETAIL_MOD_IDS = []

/** Distribution module id prefix of the always-on BASE pack (type File). */
exports.BASE_PACK_MODULE_PREFIX = 'net.romanica:texture-pack-base:'

/** Distribution module id prefix of the opt-in EFFECTS pack (type File). */
exports.EFFECTS_PACK_MODULE_PREFIX = 'net.romanica:texture-pack-effects:'

/**
 * Align the stored per-server mod configurations with the toggle value,
 * so the Mods tab reflects what the master switch decided. Entries for
 * mods the current distribution does not ship are left alone.
 *
 * @param {Object} ConfigManager The config manager (main process or test double).
 * @param {boolean} enabled The new High-detail textures value.
 */
exports.reconcileModConfigs = function(ConfigManager, enabled){
    for(const cfg of ConfigManager.getModConfigurations()){
        if(cfg == null || cfg.mods == null){
            continue
        }
        for(const id of exports.HIGH_DETAIL_MOD_IDS){
            const cur = cfg.mods[id]
            if(cur === undefined){
                continue
            }
            if(cur != null && typeof cur === 'object'){
                cur.value = enabled
            } else {
                cfg.mods[id] = enabled
            }
        }
    }
}
