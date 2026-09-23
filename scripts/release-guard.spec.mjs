// release-guard through its CLI facade, on throwaway git repositories with a bare remote.
//   node scripts/release-guard.spec.mjs
import assert from 'node:assert/strict'
import {spawnSync} from 'node:child_process'
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const guard = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-guard.mjs')
const identity = {GIT_AUTHOR_NAME: 'guard', GIT_AUTHOR_EMAIL: 'guard@example.invalid', GIT_COMMITTER_NAME: 'guard', GIT_COMMITTER_EMAIL: 'guard@example.invalid'}
const env = {...process.env, ...identity}
const root = mkdtempSync(path.join(os.tmpdir(), 'wenay-release-guard-'))

function git(cwd, ...args) {
    const result = spawnSync('git', args, {cwd, encoding: 'utf8', env, windowsHide: true})
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
    return result.stdout.trim()
}

function run(cwd, command) {
    const result = spawnSync(process.execPath, [guard, command], {cwd, encoding: 'utf8', env, windowsHide: true})
    return {ok: result.status == 0, text: result.stdout + result.stderr}
}

function expectRefusal(cwd, command, pattern) {
    const result = run(cwd, command)
    assert.equal(result.ok, false, `${command} should refuse: ${result.text}`)
    assert.match(result.text, pattern)
}

// A package repository with one pushed commit at version 1.0.0.
function project(name) {
    const remote = path.join(root, `${name}.git`)
    const work = path.join(root, name)
    git(root, 'init', '-q', '--bare', remote)
    git(root, 'init', '-q', '-b', 'main', work)
    writeFileSync(path.join(work, 'package.json'), JSON.stringify({name, version: '1.0.0'}))
    writeFileSync(path.join(work, 'lib.js'), 'module.exports = 1\n')
    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', 'initial')
    git(work, 'remote', 'add', 'origin', remote)
    git(work, 'push', '-q', '-u', 'origin', 'main')
    return {work, remote}
}

function release(work, version, body) {
    writeFileSync(path.join(work, 'package.json'), JSON.stringify({name: path.basename(work), version}))
    writeFileSync(path.join(work, 'lib.js'), body)
}

try {
    // ======================================== refusals ========================================

    const {work} = project('refusals')
    expectRefusal(work, 'check', /run npm run release:verify first/)

    // The 2.16.1-2.21.2 failure: a verified working tree published before it was committed.
    release(work, '1.1.0', 'module.exports = 2\n')
    assert.equal(run(work, 'stamp').ok, true)
    expectRefusal(work, 'check', /uncommitted changes/)

    git(work, 'add', '-A')
    git(work, 'commit', '-q', '-m', '1.1.0')
    expectRefusal(work, 'check', /not pushed/)

    // Committed and pushed, but not what was verified.
    release(work, '1.1.0', 'module.exports = 3\n')
    git(work, 'commit', '-q', '-am', 'late edit')
    git(work, 'push', '-q')
    expectRefusal(work, 'check', /differs from the tree release:verify checked/)

    // A version tag on another commit is never moved.
    assert.equal(run(work, 'stamp').ok, true)
    git(work, 'tag', 'v1.1.0', 'HEAD~1')
    expectRefusal(work, 'check', /already marks another commit/)

    // ======================================== release path ========================================

    // Verify on the dirty tree (bump + build), then commit and push the same content: accepted.
    const accepted = project('accepted')
    release(accepted.work, '2.0.0', 'module.exports = 4\n')
    writeFileSync(path.join(accepted.work, 'new-file.js'), 'module.exports = 5\n')
    assert.equal(run(accepted.work, 'stamp').ok, true)
    git(accepted.work, 'add', '-A')
    git(accepted.work, 'commit', '-q', '-m', '2.0.0')
    git(accepted.work, 'push', '-q')
    const checked = run(accepted.work, 'check')
    assert.equal(checked.ok, true, checked.text)

    const tagged = run(accepted.work, 'tag')
    assert.equal(tagged.ok, true, tagged.text)
    assert.equal(git(accepted.remote, 'rev-parse', 'v2.0.0^{commit}'), git(accepted.work, 'rev-parse', 'HEAD'))
    // Rerunning after a partial failure is idempotent for the same commit.
    assert.equal(run(accepted.work, 'check').ok, true)
    assert.equal(run(accepted.work, 'tag').ok, true)

    // A package published from a subdirectory (packages/wenay-exchange) gets its own tag line.
    const sub = path.join(accepted.work, 'packages', 'sub')
    mkdirSync(sub, {recursive: true})
    writeFileSync(path.join(sub, 'package.json'), JSON.stringify({name: 'sub', version: '0.1.0'}))
    assert.equal(run(accepted.work, 'stamp').ok, true)
    git(accepted.work, 'add', '-A')
    git(accepted.work, 'commit', '-q', '-m', 'sub 0.1.0')
    git(accepted.work, 'push', '-q')
    const subChecked = run(sub, 'check')
    assert.equal(subChecked.ok, true, subChecked.text)
    assert.equal(run(sub, 'tag').ok, true)
    assert.equal(git(accepted.remote, 'rev-parse', 'sub-v0.1.0^{commit}'), git(accepted.work, 'rev-parse', 'HEAD'))
    assert.equal(git(accepted.remote, 'tag', '--list', 'v0.1.0'), '')

    // The scratch index never disturbs the real staging area.
    writeFileSync(path.join(accepted.work, 'staged.js'), '1\n')
    git(accepted.work, 'add', 'staged.js')
    writeFileSync(path.join(accepted.work, 'unstaged.js'), '2\n')
    assert.equal(run(accepted.work, 'stamp').ok, true)
    assert.equal(git(accepted.work, 'diff', '--cached', '--name-only'), 'staged.js')

    console.log('release-guard: refusals (no stamp, uncommitted, unpushed, changed tree, foreign tag), release path and sub-package tags passed')
} finally {
    rmSync(root, {recursive: true, force: true})
}
