// A published version must be exactly the tree that release:verify checked, committed and pushed.
// 2.16.1-2.21.2 reached npm from an uncommitted working tree; this guard makes that impossible.
//   node scripts/release-guard.mjs stamp   end of release:verify: record the verified working tree
//   node scripts/release-guard.mjs check   before npm publish: clean, pushed, HEAD == verified tree
//   node scripts/release-guard.mjs tag     after npm publish: tag v<version> (<name>-v<version> from a
//                                          package subdirectory) and push the tag
import {spawnSync} from 'node:child_process'
import {copyFileSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function git(args, env) {
    const result = spawnSync('git', args, {encoding: 'utf8', windowsHide: true, env: env ? {...process.env, ...env} : process.env})
    if (result.error) throw result.error
    return {ok: result.status == 0, out: result.stdout.trim(), err: result.stderr.trim()}
}

function gitOk(args, env) {
    const result = git(args, env)
    if (!result.ok) throw new Error(`git ${args.join(' ')} failed: ${result.err}`)
    return result.out
}

function fail(message) {
    console.error(`release-guard: ${message}`)
    process.exit(1)
}

// ======================================== tree identity ========================================

const stampFile = () => path.resolve(gitOk(['rev-parse', '--git-path', 'wenay-release-verified.json']))
const manifest = () => JSON.parse(readFileSync('package.json', 'utf8'))
const version = () => manifest().version

// The repository's own package tags v<version>; a package published from a subdirectory
// (packages/wenay-exchange) tags <name>-v<version>, so the two version lines never collide.
function tagName() {
    const top = realpathSync.native(gitOk(['rev-parse', '--show-toplevel']))
    return realpathSync.native('.') == top ? `v${version()}` : `${manifest().name}-v${version()}`
}

// Hash of the whole working tree as the next commit would record it (tracked + untracked, minus
// ignored), computed in a scratch index so the real staging area is untouched.
function workingTree() {
    const index = path.join(os.tmpdir(), `wenay-release-index-${process.pid}`)
    const real = path.resolve(gitOk(['rev-parse', '--git-path', 'index']))
    try {
        if (existsSync(real)) copyFileSync(real, index)
        gitOk(['add', '-A'], {GIT_INDEX_FILE: index})
        return gitOk(['write-tree'], {GIT_INDEX_FILE: index})
    } finally {
        rmSync(index, {force: true})
    }
}

function upstream() {
    const ref = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    if (!ref.ok) fail('the current branch has no upstream; push it with -u first')
    const remote = gitOk(['config', `branch.${gitOk(['rev-parse', '--abbrev-ref', 'HEAD'])}.remote`])
    return {ref: ref.out, remote}
}

// ======================================== commands ========================================

function stamp() {
    const record = {tree: workingTree(), version: version()}
    writeFileSync(stampFile(), JSON.stringify(record))
    console.log(`release-guard: verified tree ${record.tree.slice(0, 12)} for ${record.version}`)
}

function check() {
    if (!existsSync(stampFile())) fail('no verified tree recorded; run npm run release:verify first')
    const verified = JSON.parse(readFileSync(stampFile(), 'utf8'))
    const dirty = gitOk(['status', '--porcelain'])
    if (dirty) fail(`uncommitted changes; commit the verified tree (build outputs included) first:\n${dirty}`)
    const head = gitOk(['rev-parse', 'HEAD^{tree}'])
    if (head != verified.tree) fail(`HEAD differs from the tree release:verify checked (${verified.version}); rerun it`)
    const {ref, remote} = upstream()
    gitOk(['fetch', '--quiet', remote])
    if (!git(['merge-base', '--is-ancestor', 'HEAD', ref]).ok) fail(`HEAD is not pushed to ${ref}; push first`)
    const tag = tagName()
    const tagged = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`])
    if (tagged.ok && tagged.out != gitOk(['rev-parse', 'HEAD'])) fail(`tag ${tag} already marks another commit`)
    console.log(`release-guard: ${manifest().name} ${version()} is verified, committed and pushed`)
}

function tag() {
    const name = tagName()
    if (!git(['rev-parse', '-q', '--verify', `refs/tags/${name}`]).ok) gitOk(['tag', '-a', name, '-m', `Release ${manifest().name} ${version()}`])
    gitOk(['push', '--quiet', upstream().remote, `refs/tags/${name}`])
    console.log(`release-guard: tagged and pushed ${name}`)
}

const commands = {stamp, check, tag}
const command = commands[process.argv[2]]
if (!command) fail(`usage: node scripts/release-guard.mjs ${Object.keys(commands).join('|')}`)
command()
