#!/usr/bin/env node
/**
 * Romanica distribution index generator (milestone 2).
 *
 * Builds distribution/distribution.json with REAL artifacts: sizes, MD5s
 * (validation baseline), SHA-256s (stronger post-download verification) and URLs
 * for everything the launcher must sync — Fabric loader + its profile libraries
 * (MD5s straight from meta.fabricmc.net), Imperium Client (from a local jar or a
 * published GitHub release), Fabric API, and the performance-pack mods (resolved
 * against the Modrinth API for MC 26.3; jars are downloaded once and hashed, then
 * cached in .distro-cache so re-runs are instant).
 *
 * Usage:
 *   node scripts/generate-distro.cjs                    # full generate
 *   node scripts/generate-distro.cjs --client <jar>     # hash a local client jar
 *                                                      # and point its URL at the
 *                                                      # future GitHub release
 *
 * The Minecraft client itself, its libraries and assets come from Mojang via
 * minecraftVersion — they are NOT listed here (Helios handles that).
 *
 * Re-run and commit whenever the pack changes, then verify every artifact URL
 * serves what the checklist in docs/distribution-index.md requires.
 *
 * ROMANICA CUTOVER: regenerating with the Romanica server id RESETS every
 * player's instance folder (the launcher keys instances and settings by
 * server id). Commit the regenerated distribution.json only at cutover,
 * together with the smoke.yml SERVER_ID flip.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MC_VERSION = '26.3';
const SERVER_ID = 'Romanica';
const UA = { 'User-Agent': 'RomanicaLauncher-distgen/1.0 (romanica.net)' };

// Owner directive 2026-11-15: the pack is exactly these mods, nothing else.
// Speed mods, on by default (players can still turn them off in the Mods tab).
const PERFORMANCE_MODS = [
  'sodium',
  'lithium',
  'immediatelyfast',
  'entityculling',
  'moreculling',
  'ferrite-core',
  'dynamic-fps',
];

// Helper mods, on by default. Fabric API is added separately as required.
const QUALITY_MODS = [
  'modmenu',
  'cloth-config',
  'placeholder-api',
];

// Extras, shipped off: players turn them on under Optional mods.
const OPTIONAL_MODS = [
  'iris',
  'sodium-extra',
  'reeses-sodium-options',
  'distanthorizons',
];

// Issue #15: the texture pack ships as managed File modules landing in the
// instance's resourcepacks/ folder. BASE is required (it is the pack the
// server pushes on join); EFFECTS is the opt-in high-detail layer. File
// names stay identical to the release assets so players can match them.
// The EFFECTS zip currently declares min/max_format 88 (incompatible with
// 26.3's format 97) — re-point these URLs when the packs repo cuts a
// 26.3-compatible release (issue #15, packs-repo work item).
const RESOURCE_PACKS = [
  {
    id: 'net.romanica:texture-pack-base:2.0.9',
    name: 'Romanica Textures v2.0.9 (BASE)',
    file: 'Romanica_TexturePack_v2.0.9_26.2_BASE.zip',
    url: 'https://github.com/Romanica-MC/romanica-resourcepack/releases/download/v2.0.9/Romanica_TexturePack_v2.0.9_26.2_BASE.zip',
    required: { value: true, def: true },
  },
  {
    id: 'net.romanica:texture-pack-effects:2.0.1',
    name: 'Romanica Textures v2.0.1 (EFFECTS, high detail)',
    file: 'MINARECRAFTORVM_v2.0.1_26.2_EFFECTS.zip',
    url: 'https://github.com/Romanica-MC/romanica-resourcepack/releases/download/textures/MINARECRAFTORVM_v2.0.1_26.2_EFFECTS.zip',
    required: { value: false, def: false },
  },
];

const CACHE_DIR = path.join(__dirname, '..', '.distro-cache');
const OUT = path.join(__dirname, '..', 'distribution', 'distribution.json');

async function fetchJson(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

/** Download once, cache forever (content-addressed by URL hash). Returns { size, md5, sha256 }. */
async function hashArtifact(url) {
  const key = crypto.createHash('md5').update(url).digest('hex');
  const metaPath = path.join(CACHE_DIR, `${key}.json`);
  const cached = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, 'utf8')) : null;
  if (cached && cached.sha256) return cached;
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`download ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const meta = {
    size: buf.length,
    md5: crypto.createHash('md5').update(buf).digest('hex'),
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  return meta;
}

/**
 * Build a distribution artifact entry. MD5 stays the validation baseline for
 * helios-core's DistributionIndexProcessor; sha256 is emitted alongside it
 * whenever we hashed the file locally, so the launcher's post-download
 * verification can prefer the stronger hash.
 */
function artifact(url, hash, size, sha256) {
  return { size, MD5: hash, ...(sha256 ? { sha256 } : {}), url };
}

async function fabricModules() {
  // Latest loader for this MC version (prefer stable when present).
  const loaders = await fetchJson(`https://meta.fabricmc.net/v2/versions/loader/${MC_VERSION}`);
  const best = loaders.find((l) => l.loader.stable) || loaders[0];
  const loaderVersion = best.loader.version;
  const profileUrl = `https://meta.fabricmc.net/v2/versions/loader/${MC_VERSION}/${loaderVersion}/profile/json`;
  const profile = await fetchJson(profileUrl);
  const profileBuf = await (await fetch(profileUrl, { headers: UA })).arrayBuffer();

  // VENDOR the profile: meta.fabricmc.net regenerates this JSON server-side, so a
  // sha256 pin on the live URL breaks EVERY client's download the moment Fabric
  // republishes it (live incident 2026-10-25: the launch smoke failed with
  // 'sha256 mismatch' on exactly this file a day after the pin was cut). The
  // committed copy is served immutable from raw.githubusercontent and keeps the
  // full size+md5+sha256 pin — and drops meta.fabricmc.net from the launch path.
  const DISTRO_RAW = 'https://raw.githubusercontent.com/Romanica-MC/RomanicaLauncher/master/distribution';
  const vendorName = `fabric-profile-${MC_VERSION}-${loaderVersion}.json`;
  const vendorDir = path.join(__dirname, '..', 'distribution', 'vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.writeFileSync(path.join(vendorDir, vendorName), Buffer.from(profileBuf));
  const vendorUrl = `${DISTRO_RAW}/vendor/${vendorName}`;

  const subModules = [
    {
      id: `fabric-loader-${loaderVersion}-${MC_VERSION}`,
      name: 'Fabric Version Manifest',
      type: 'VersionManifest',
      artifact: artifact(
        vendorUrl,
        crypto.createHash('md5').update(Buffer.from(profileBuf)).digest('hex'),
        profileBuf.byteLength,
        crypto.createHash('sha256').update(Buffer.from(profileBuf)).digest('hex')
      ),
    },
    // Every library from the profile with hash metadata. The profile's library list
    // also repeats the loader itself as a url-only entry — skip those; the loader
    // jar is the top-level module artifact (hashed separately above).
    // Library artifacts are downloaded once here so the distro can carry sha256 —
    // the loader subModules sit on the code-execution path and MD5 is collision-broken
    // (pass-4 supply-chain finding: they were the only MD5-verified artifacts).
    ...(await Promise.all(
      profile.libraries.filter((lib) => lib.size && lib.md5).map(async (lib) => ({
        id: lib.name,
        name: lib.name.split(':').slice(0, 2).join(':'),
        type: 'Library',
        artifact: await (async () => {
          const u = mavenUrl(lib.url, lib.name);
          const h = await hashArtifact(u);
          return artifact(u, h.md5, h.size, h.sha256);
        })(),
      }))
    )),
  ];

  // The loader jar itself.
  const loaderJarUrl = `https://maven.fabricmc.net/net/fabricmc/fabric-loader/${loaderVersion}/fabric-loader-${loaderVersion}.jar`;
  const loaderJar = await hashArtifact(loaderJarUrl);

  return {
    fabric: {
      id: `net.fabricmc:fabric-loader:${loaderVersion}`,
      name: 'Fabric Loader',
      type: 'Fabric',
      required: { value: true, def: true },
      artifact: artifact(loaderJarUrl, loaderJar.md5, loaderJar.size, loaderJar.sha256),
      subModules,
    },
    loaderVersion,
  };
}

/** Maven coordinate group:artifact:version -> absolute jar URL on the given repo base. */
function mavenUrl(repoBase, coord) {
  const [group, art, version] = coord.split('@')[0].split(':');
  const ext = coord.includes('@') ? coord.split('@')[1] : 'jar';
  const base = repoBase.endsWith('/') ? repoBase : repoBase + '/';
  return `${base}${group.replace(/\./g, '/')}/${art}/${version}/${art}-${version}.${ext}`;
}

/**
 * Slugify an arbitrary string into a maven-component-safe token (issue #14).
 * Defensive fallback whenever Modrinth metadata is missing, so a module can
 * never end up with an empty/absent id component — helios-core renders a
 * missing maven version as a literal "...-undefined.jar" file name.
 */
function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function modrinthModule(slug, def = true) {
  const versions = await fetchJson(
    `https://api.modrinth.com/v2/project/${slug}/version?game_versions=${encodeURIComponent(
      JSON.stringify([MC_VERSION])
    )}&loaders=${encodeURIComponent(JSON.stringify(['fabric']))}`
  );
  if (!versions.length) throw new Error(`no ${MC_VERSION} fabric build for ${slug} on Modrinth`);
  const version = versions[0];
  const file = version.files.find((f) => f.primary) || version.files[0];
  const hashed = await hashArtifact(file.url);
  // THREE maven components (group:artifact:version). The id used to carry
  // only two (`com.modrinth.<slug>:<version>`), so helios-core's parser put
  // the version slot in as undefined and every such jar downloaded as
  // "<version>-undefined.jar" (issue #14).
  const versionNumber = slugify(version.version_number) || slugify(version.id);
  return {
    id: `com.modrinth:${slugify(slug) || slugify(version.id)}:${versionNumber}`,
    name: version.name || slug,
    type: 'FabricMod',
    required: { value: false, def },
    artifact: artifact(file.url, hashed.md5, hashed.size, hashed.sha256),
  };
}

async function latestClientVersion() {
  const res = await fetch('https://api.github.com/repos/Romanica-MC/RomanicaClient/releases/latest', { headers: UA });
  if (!res.ok) throw new Error('cannot resolve latest Romanica Client release');
  const tag = (await res.json()).tag_name || '';
  if (!tag.startsWith('v')) throw new Error(`unexpected latest tag ${tag}`);
  return tag.slice(1);
}

async function imperiumClientModule(localJarPath, versionOverride) {
  // The client repo renamed ImperiumClient -> RomanicaClient in the
  // Romanica-MC org; releases live under the new name now.
  // The client release version is independent of the launcher's own version:
  // --client-version pins it explicitly; otherwise the latest published
  // release resolves. --client hashes a locally built jar so the index is
  // ready the moment that exact jar is uploaded.
  const VERSION = versionOverride || (await latestClientVersion());
  // v0.2.0-beta.10+ renamed the release asset to RomanicaClient; older tags shipped
  // ImperiumClient. Resolve whichever exists (HEAD probe, HEAD may lie about size but
  // 200-vs-404 is reliable).
  const romanicaUrl = `https://github.com/Romanica-MC/RomanicaClient/releases/download/v${VERSION}/RomanicaClient-${VERSION}%2B${MC_VERSION}.jar`;
  const legacyUrl = `https://github.com/Romanica-MC/RomanicaClient/releases/download/v${VERSION}/ImperiumClient-${VERSION}%2B${MC_VERSION}.jar`;
  const headOk = await fetch(romanicaUrl, { method: 'HEAD', headers: UA }).then(r => r.ok).catch(() => false);
  const releaseUrl = headOk ? romanicaUrl : legacyUrl;
  let hash, size, sha256;
  if (localJarPath) {
    const buf = fs.readFileSync(localJarPath);
    hash = crypto.createHash('md5').update(buf).digest('hex');
    sha256 = crypto.createHash('sha256').update(buf).digest('hex');
    size = buf.length;
    console.log(`  client: hashed local jar ${path.basename(localJarPath)} (${size} bytes)`);
  } else {
    const cached = await hashArtifact(releaseUrl).catch(() => null);
    if (!cached) {
      throw new Error(
        `Imperium Client release not published yet (${releaseUrl}) — build one and pass --client <jar>`
      );
    }
    hash = cached.md5;
    sha256 = cached.sha256;
    size = cached.size;
  }
  return {
    id: `net.imperiummc:imperium-client:${VERSION}`,
    name: 'Romanica Client',
    type: 'FabricMod',
    artifact: artifact(releaseUrl, hash, size, sha256),
  };
}

/**
 * Issue #14 build gate: every maven-id module must resolve to a file name
 * with NO "undefined" in it. helios-core derives the local path from the id
 * as group/artifact/version/artifact-version[-classifier].jar, so a missing
 * component (a two-part id) surfaces as "<x>-undefined.jar". Rebuilding the
 * maven parse here (dependency-free) and refusing to write the index keeps
 * a malformed distro from ever shipping again.
 */
function assertDistroIdsSafe(index) {
  const MAVEN_ID = /^([^@:]+):([^@:]+):([^@:]+)(?::([^@:]+))?(?:@([a-z0-9]+))?$/i;
  const walk = (modules, trail) => {
    for (const module of modules || []) {
      const at = [...trail, module.id].join(' > ');
      if (module.type !== 'File' && module.type !== 'VersionManifest') {
        const parsed = MAVEN_ID.exec(module.id || '');
        if (!parsed) {
          throw new Error(`module id ${JSON.stringify(module.id)} (${at}) is not a full group:artifact:version maven id`);
        }
        const [, group, artifact, version, classifier, ext] = parsed;
        for (const [label, component] of [['group', group], ['artifact', artifact], ['version', version]]) {
          if (!component || /undefined/i.test(component)) {
            throw new Error(`module id ${JSON.stringify(module.id)} (${at}) has an empty/undefined ${label} component`);
          }
        }
        const fileName = `${artifact}-${version}${classifier ? `-${classifier}` : ''}.${ext || 'jar'}`;
        if (/undefined/i.test(`${group}/${fileName}`)) {
          throw new Error(`module id ${JSON.stringify(module.id)} (${at}) would download as ${fileName}`);
        }
      }
      walk(module.subModules, [...trail, module.id]);
    }
  };
  for (const server of index.servers || []) walk(server.modules, [server.id]);
}

async function main() {
  const args = process.argv.slice(2);
  const clientJarIdx = args.indexOf('--client');
  const clientJar = clientJarIdx >= 0 ? args[clientJarIdx + 1] : null;
  const clientVersionIdx = args.indexOf('--client-version');
  const clientVersion = clientVersionIdx >= 0 ? args[clientVersionIdx + 1] : null;

  console.log('Resolving Fabric for MC', MC_VERSION, '...');
  const { fabric, loaderVersion } = await fabricModules();
  console.log(`  loader ${loaderVersion}, ${fabric.subModules.length} submodules (manifest + libraries)`);

  console.log('Resolving Imperium Client ...');
  const client = await imperiumClientModule(clientJar, clientVersion);

  console.log('Resolving Fabric Language Kotlin ...');
  const flk = await modrinthModule('fabric-language-kotlin');
  flk.required = { value: true, def: true }; // Imperium Client is written in Kotlin
  flk.id = flk.id.replace('%2B', '+');

  console.log('Resolving Fabric API ...');
  const fabricApi = await modrinthModule('fabric-api');
  fabricApi.required = { value: true, def: true }; // Imperium Client depends on it
  fabricApi.id = fabricApi.id.replace('%2B', '+'); // Maven ids carry the raw version

  console.log('Resolving performance pack ...');
  const perf = [];
  for (const slug of [...PERFORMANCE_MODS, ...QUALITY_MODS]) {
    try {
      perf.push(await modrinthModule(slug));
      console.log(`  ${slug} ok`);
    } catch (e) {
      console.log(`  ${slug} SKIPPED: ${e.message}`);
    }
  }

  console.log('Resolving optional extras (def: false) ...');
  for (const slug of OPTIONAL_MODS) {
    try {
      perf.push(await modrinthModule(slug, false));
      console.log(`  ${slug} ok`);
    } catch (e) {
      console.log(`  ${slug} SKIPPED: ${e.message}`);
    }
  }


  console.log('Resolving resource packs ...');
  // File modules with an explicit artifact.path land at
  // <instance>/<serverId>/<path> — i.e. the instance's resourcepacks/
  // folder the game scans. packpreferences.js manages their options.txt
  // entries at launch (issue #15). Hashed through the shared caching
  // downloader like every other artifact.
  const resourcePackModules = [];
  for (const p of RESOURCE_PACKS) {
    const h = await hashArtifact(p.url);
    resourcePackModules.push({
      id: p.id,
      name: p.name,
      type: 'File',
      required: p.required,
      artifact: {
        path: `resourcepacks/${p.file}`,
        size: h.size,
        MD5: h.md5,
        sha256: h.sha256,
        url: p.url,
      },
    });
  }

  const index = {
    version: '1.0.0',
    rss: 'https://romanica.net/news.rss',
    // The Rich Presence application id is the Discord bot's application id
    // (DISCORD_APP_ID in the imperium-discord worker's secrets — never
    // committed). Until a real id lands here, initRPC fails to log in and
    // Rich Presence stays silently off; nothing else reads this value.
    discord: {
      clientId: 'REPLACE_WITH_BOT_CLIENT_ID',
      smallImageText: 'Romanica',
      smallImageKey: 'seal',
    },
    servers: [
      {
        id: SERVER_ID,
        name: 'Romanica',
        description: 'Story-driven Roman prison server.',
        // ROMANICA CUTOVER: icon flips with the GitHub org rename.
        icon: 'https://raw.githubusercontent.com/Romanica-MC/RomanicaLauncher/master/app/assets/images/SealCircle.png',
        version: require('../package.json').version,
        address: 'play.romanica.net',
        minecraftVersion: MC_VERSION,
        mainServer: true,
        autoconnect: true,
        javaOptions: {
          supported: '>=25',
          suggestedMajor: 25,
          ram: { recommended: 4096, minimum: 2048 },
        },
        modules: [fabric, client, flk, fabricApi, ...perf, ...resourcePackModules],
      },
    ],
  };

  assertDistroIdsSafe(index);

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(index, null, 4) + '\n');
  const modules = index.servers[0].modules.length;
  console.log(`\nWrote ${OUT} (${modules} top-level modules, ${fabric.subModules.length} loader submodules).`);
  console.log('Next: verify every artifact URL serves its size+MD5+sha256 (docs checklist),');
  console.log('fill the discord clientId (or drop the discord block), then bump REMOTE_DISTRO_URL.');
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
