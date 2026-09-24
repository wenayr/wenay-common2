// Keep the copyable examples synchronized with the incubator sources: every
// service example under examples/<name> is the scaffold template plus its own
// modules, rewritten to public package imports. Focused probes opt out of the
// service template. Hand-authored files of a copy
// (README.md, run.mjs, check.ts, rental/benchmark.ts) are not generated and not checked here.
//   node scripts/generate-examples.mjs           regenerate every example
//   node scripts/generate-examples.mjs --check   fail when a copy is stale
import {promises as fs} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {portableSource} from '../experiments/wenay-scaffold/create.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const check = process.argv.includes('--check')
const source = 'experiments/wenay-scaffold'
const TEMPLATE_FILES = ['leader.ts', 'node.ts', 'config.ts', 'input-schema.ts', 'access.ts', 'rest.ts', 'panel.ts', 'effects.ts', 'payments.ts', 'client.ts']
// the stall/hang guard every check entrypoint ends through
const RUN_CHECK = {from: '../../resources/run-check.ts', to: 'run-check.ts'}

/** The examples table: one copyable project per entry. */
export const EXAMPLES = {
    'document-processing': {
        template: false,
        files: ['storage.ts', 'storage-check.ts', 'provider.ts', 'service.ts', 'host.ts', 'client.ts', 'page.ts', 'run.ts', 'example.ts', 'check.ts', 'graceful-close-check.ts',
            {from: '../../resources/http-host.ts', to: 'http-host.ts'},
            {from: '../../resources/http-host-check.ts', to: 'http-host-check.ts'}, RUN_CHECK],
        dependencies: ['express', 'socket.io', 'socket.io-client'],
        scripts: {start: 'tsx run.ts', example: 'tsx example.ts', check: 'tsx http-host-check.ts && tsx storage-check.ts && tsx graceful-close-check.ts && tsx check.ts && tsx example.ts', typecheck: 'tsc --noEmit'},
    },
    'ai-support': {
        template: false,
        files: ['provider.ts', 'service.ts', 'host.ts', 'client.ts', 'page.ts', 'run.ts', 'example.ts', 'check.ts', 'host-lifecycle-check.ts', 'concurrent-check.ts', 'persistence.ts', 'persistence-check.ts',
            {from: '../../resources/http-host.ts', to: 'http-host.ts'},
            {from: '../../resources/http-host-check.ts', to: 'http-host-check.ts'}, RUN_CHECK],
        dependencies: ['express', 'socket.io', 'socket.io-client'],
        scripts: {start: 'tsx run.ts', example: 'tsx example.ts', check: 'tsx http-host-check.ts && tsx host-lifecycle-check.ts && tsx concurrent-check.ts && tsx check.ts && tsx example.ts && tsx persistence-check.ts', 'example:persistence': 'tsx persistence-check.ts', typecheck: 'tsc --noEmit'},
    },
    'small-jobs': {
        files: ['service.ts', 'leader-small-jobs.ts', 'node-small-jobs.ts', 'run.mjs', 'example.ts', 'check.ts', 'stand-check.ts',
            {from: '../pizzeria/identity.ts', to: 'identity.ts'}, RUN_CHECK],
        scripts: {start: 'node run.mjs', example: 'tsx example.ts', check: 'tsx stand-check.ts && tsx check.ts && tsx example.ts', typecheck: 'tsc --noEmit'},
    },
    hosting: {
        template: false,
        files: ['service.ts', 'worker.ts', 'process-resource.ts', 'example.ts', 'check.ts', 'run.ts', 'session-resources.ts', 'public-address.ts', 'agent-orchestration.ts', RUN_CHECK],
        dependencies: ['express', 'socket.io', 'socket.io-client'],
        scripts: {start: 'tsx run.ts', example: 'tsx example.ts', check: 'tsx check.ts && tsx session-resources.ts && tsx public-address.ts && tsx agent-orchestration.ts', 'example:resources': 'tsx session-resources.ts', 'example:agent': 'tsx agent-orchestration.ts', 'repro:public-address': 'tsx public-address.ts', typecheck: 'tsc --noEmit'},
    },
    'smart-home': {
        template: false,
        files: ['service.ts', 'example.ts', 'check.ts', 'lifecycle-check.ts', 'client.ts', 'host.ts', 'stand.ts', 'stand-check.ts', 'process-check.ts', RUN_CHECK],
        dependencies: ['socket.io', 'socket.io-client'],
        scripts: {start: 'tsx example.ts', check: 'tsx example.ts && tsx check.ts && tsx lifecycle-check.ts && tsx stand-check.ts && tsx process-check.ts',
            'check:local': 'tsx check.ts', 'check:lifecycle': 'tsx lifecycle-check.ts', 'check:process': 'tsx process-check.ts', typecheck: 'tsc --noEmit'},
    },
    rental: {
        files: ['service.ts', 'board-rest.ts', 'leader-rental.ts', 'node-rental.ts', 'rental-client.ts', 'example.ts', 'durable-check.ts',
            'input-schema-check.ts', 'migration-check.ts',
            {from: '../../resources/http-host.ts', to: 'http-host.ts'}, RUN_CHECK],
        scripts: {start: 'node run.mjs', example: 'tsx example.ts', benchmark: 'tsx benchmark.ts', 'probe:entities': 'tsx dynamic-api-probe.ts', 'probe:http': 'tsx entity-http-probe.ts', check: 'tsx input-schema-check.ts && tsx migration-check.ts && tsx entity-probe-check.ts && tsx durable-check.ts && tsx stand-check.ts && tsx check.ts', typecheck: 'tsc --noEmit'},
    },
    pizzeria: {
        files: ['service.ts', 'identity.ts', 'leader-pizzeria.ts', 'node-pizzeria.ts', 'account-id-check.ts', 'network-check.ts', RUN_CHECK],
        scripts: {start: 'node run.mjs', check: 'tsx account-id-check.ts && tsx check.ts && npm run test:network', 'test:network': 'tsx network-check.ts', typecheck: 'tsc --noEmit'},
    },
    apartments: {
        // the in-repo oracle IS the copy's check: it only uses package-mappable imports
        files: ['service.ts', 'identity.ts', 'lock-policy.ts', 'lock-policy-check.ts', 'device-lock.ts', 'device-lock-check.ts', 'leader-apartments.ts', 'node-apartments.ts', 'run.mjs', 'stand-check.ts', 'account-id-check.ts', {from: 'self-check.ts', to: 'check.ts'}, RUN_CHECK],
        scripts: {start: 'node run.mjs', device: 'tsx device-lock.ts', check: 'tsx stand-check.ts && tsx lock-policy-check.ts && tsx device-lock-check.ts && tsx account-id-check.ts && tsx check.ts', typecheck: 'tsc --noEmit'},
    },
}

async function generate(name, example) {
    const target = path.join(root, 'examples', name)
    async function emit(file, content) {
        const full = path.join(target, file)
        if (check) {
            const current = await fs.readFile(full, 'utf8').catch(() => null)
            if (current != content) throw new Error(`regenerate example ${name}: ${file}`)
        } else {
            await fs.mkdir(target, {recursive: true})
            await fs.writeFile(full, content)
        }
    }
    async function copy(from, file) {
        let text = await fs.readFile(path.join(root, from), 'utf8')
        text = text.replaceAll('../../template/', './')
            .replaceAll('../../resources/', './')
            .replaceAll('../pizzeria/identity', './identity')
            .replaceAll('../../../../src/', '../../../src/')
            .replaceAll('../../../../package.json', './package.json')
        text = (file.endsWith('.ts') ? portableSource(text) : text).replaceAll('{{name}}', name)
        // a shebang stays first; the banner follows it
        const banner = '// Generated by scripts/generate-examples.mjs; edit the source in the repository.\n'
        // `.` never matches \r in JS, so a CRLF shebang line needs the explicit \r?
        const shebang = /^#![^\r\n]*\r?\n/.exec(text)?.[0] ?? ''
        await emit(file, shebang + banner + text.slice(shebang.length))
    }
    if (example.template != false) {
        for (const file of TEMPLATE_FILES) await copy(`${source}/template/${file}`, file)
    }
    for (const entry of example.files) {
        const {from, to} = typeof entry == 'string' ? {from: entry, to: entry} : entry
        await copy(`${source}/examples/${name}/${from}`, to)
    }
    const manifest = JSON.parse(await fs.readFile(path.join(root, source, 'template/package.json'), 'utf8'))
    manifest.name = `wenay-${name}-example`
    manifest.scripts = example.scripts
    const library = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
    manifest.dependencies['wenay-common2'] = library.version
    manifest.dependencies['swagger-ui-dist'] = library.devDependencies['swagger-ui-dist']
    if (example.template == false) {
        manifest.dependencies = {'wenay-common2': manifest.dependencies['wenay-common2']}
        for (const dependency of example.dependencies ?? []) {
            const version = library.dependencies?.[dependency] ?? library.devDependencies[dependency]
            if (!version) throw new Error(`missing example dependency: ${dependency}`)
            manifest.dependencies[dependency] = version
        }
        // express is an optional peer of wenay-common2: an example that uses it declares its types too
        if (!example.dependencies?.includes('express')) delete manifest.devDependencies['@types/express']
    }
    await emit('package.json', JSON.stringify(manifest, null, 4) + '\n')
    const config = JSON.parse(await fs.readFile(path.join(root, source, 'template/tsconfig.json'), 'utf8'))
    Object.assign(config.compilerOptions, {module: 'Node16', moduleResolution: 'Node16', skipLibCheck: false, lib: ['esnext', 'dom'], allowJs: true})
    await emit('tsconfig.json', JSON.stringify(config, null, 4) + '\n')
}

for (const [name, example] of Object.entries(EXAMPLES)) await generate(name, example)
console.log(check ? 'Example sources match' : 'Generated ' + Object.keys(EXAMPLES).map(name => 'examples/' + name).join(', '))
