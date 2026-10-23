/**
 * smokelaunch.js — headless launch mode for the CI smoke test (issue #5).
 *
 * Activated only when the smoke driver (test/smoke/launch-smoke.cjs) starts
 * the packaged launcher with IMPERIUM_SMOKE_LAUNCH=1. No launcher window
 * and no renderer exist in this mode, so there is no UI to race: the
 * launch pipeline (distribution -> asset sync -> ProcessBuilder) runs in
 * this process with the offline account the driver pre-seeded into
 * config.json. The driver owns the verdict: it watches the game's
 * logs/latest.log for the title-screen markers and kills the process
 * tree. This module only reports progress on stdout and exits non-zero
 * if the pipeline fails before the game is spawned.
 */
const SMOKE_NAME = 'SmokeTest'
const SMOKE_UUID = '00000000-0000-0000-0000-000000000000'

/**
 * Run the launch pipeline headlessly.
 *
 * @param {Object} core The launcher core module.
 * @param {Object} launchservice The launch service module.
 */
exports.run = async function(core, launchservice){
    const { app } = require('electron')
    console.log('[SMOKE] headless smoke launch starting')
    // No window in smoke mode, so print the launch events the progress bar would show:
    // the run log then records exactly what a player sees, step by step.
    launchservice.init(core, (event) => {
        if(event.kind === 'progress' || event.kind === 'downloadProgress'){
            console.log(`[SMOKE] progress ${event.percent}%`)
        } else if(event.kind === 'details'){
            console.log(`[SMOKE] status ${event.text}`)
        } else if(event.kind === 'gameLaunched'){
            console.log('[SMOKE] launcher marked the game ready')
        }
    })
    try {
        const data = await core.loadDistribution()
        if(data == null){
            throw new Error('distribution index unavailable')
        }
        core.syncConfigurationWithDistribution(data)
        console.log(`[SMOKE] distribution ready (${data.servers.length} servers, selected ${core.ConfigManager.getSelectedServer()})`)

        // Re-assert the offline account right before the launch so a stale
        // or hand-edited config cannot leave the pipeline without one.
        // addMojangAuthAccount also selects it. accessToken '0' with a
        // zeroed uuid: the game never talks to Mojang in offline mode and
        // the smoke run stops at the title screen.
        core.ConfigManager.addMojangAuthAccount(SMOKE_UUID, '0', SMOKE_NAME, SMOKE_NAME)
        core.ConfigManager.save()

        const result = await launchservice.launch(true)
        if(result.ok){
            console.log('[SMOKE] game spawned')
            // The driver takes over from here (log scan, timeout, cleanup);
            // the game process must keep this process as its parent.
            return
        }
        console.error('[SMOKE] launch pipeline reported failure')
        app.exit(1)
    } catch(err){
        console.error('[SMOKE] launch failed:', err)
        app.exit(1)
    }
}
