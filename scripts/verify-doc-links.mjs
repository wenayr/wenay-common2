// Every relative link and heading anchor in the repository's markdown must resolve, and a doc that
// ships in the npm package may only link to files that ship with it: a consumer (or an AI agent)
// reads those docs inside node_modules, where repository-only paths do not exist.
// doc/changes keeps a rolling ten-version window, so links into a pruned version
// file rot silently on each release; this check makes that rot fail the test run.
//   node scripts/verify-doc-links.mjs
import {readdirSync, readFileSync, existsSync, statSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Repository markdown; doc/target and doc/progress are working notes and are not checked.
const roots = ['README.md', 'CLAUDE.md', 'rpc.md', 'doc', 'examples', 'replay', 'observe', 'oracle', 'demo']
const skipped = new Set(['node_modules', 'target', 'progress', 'public'])

function collect(entry, out) {
    const full = path.join(root, entry)
    if (!existsSync(full)) return out
    if (statSync(full).isFile()) return entry.endsWith('.md') ? (out.push(full), out) : out
    for (const item of readdirSync(full, {withFileTypes: true})) {
        if (item.isDirectory() && skipped.has(item.name)) continue
        collect(path.join(entry, item.name), out)
    }
    return out
}

const relative = file => path.relative(root, file).replaceAll('\\', '/')

// ======================================== package contents ========================================

// package.json "files" decides what ships. Only the pattern forms used there are understood;
// any other form fails loudly instead of being guessed.
function matcher(pattern) {
    const tree = /^([\w./-]+)\/\*\*\/\*$/.exec(pattern)
    if (tree) return rel => rel.startsWith(tree[1] + '/')
    const extension = /^\*\*\/\*(\.[\w.]+)$/.exec(pattern)
    if (extension) return rel => rel.endsWith(extension[1])
    if (/^[\w.-]+(\/[\w.-]+)*$/.test(pattern)) return rel => rel == pattern
    throw new Error(`verify-doc-links: unsupported package.json "files" pattern ${pattern}`)
}

const patterns = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).files
const include = patterns.filter(pattern => !pattern.startsWith('!')).map(matcher)
const exclude = patterns.filter(pattern => pattern.startsWith('!')).map(pattern => matcher(pattern.slice(1)))
const alwaysPacked = new Set(['package.json', 'README.md', 'LICENSE'])

function shipped(file) {
    const rel = relative(file) + (statSync(file).isDirectory() ? '/' : '')
    if (rel.split('/').includes('node_modules')) return false
    return alwaysPacked.has(rel) || include.some(test => test(rel)) && !exclude.some(test => test(rel))
}

// npmjs.com and GitHub resolve README links against the repository, so README may point there.
const readsInsidePackage = file => relative(file) != 'README.md' && shipped(file)

// ======================================== anchors ========================================

// GitHub heading slug: lowercase, drop punctuation/emoji, spaces become '-', duplicates get -1, -2...
function slug(heading) {
    return heading.replace(/`/g, '').trim().toLowerCase()
        .replace(/<[^>]+>/g, '').replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s/g, '-')
}

const anchorCache = new Map()
function anchorsOf(file) {
    if (anchorCache.has(file)) return anchorCache.get(file)
    const anchors = new Set(), seen = new Map()
    let fenced = false
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        if (/^\s*(```|~~~)/.test(line)) fenced = !fenced
        const heading = fenced ? null : /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
        if (!heading) continue
        const base = slug(heading[1])
        const count = seen.get(base) ?? 0
        seen.set(base, count + 1)
        anchors.add(count ? `${base}-${count}` : base)
    }
    anchorCache.set(file, anchors)
    return anchors
}

// ======================================== links ========================================

const broken = []
const files = roots.flatMap(entry => collect(entry, []))
for (const file of files) {
    const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
    const insidePackage = readsInsidePackage(file)
    for (const match of text.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
        const href = match[1]
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue
        const [target, hash] = href.split('#')
        const resolved = target ? path.resolve(path.dirname(file), decodeURIComponent(target)) : file
        const from = relative(file)
        if (!existsSync(resolved)) broken.push(`missing file   ${from} -> ${href}`)
        else if (insidePackage && !shipped(resolved)) broken.push(`not shipped    ${from} -> ${href}`)
        else if (hash && resolved.endsWith('.md') && !anchorsOf(resolved).has(decodeURIComponent(hash).toLowerCase()))
            broken.push(`missing anchor ${from} -> ${href}`)
    }
}

if (broken.length) {
    console.error(broken.join('\n'))
    console.error(`${broken.length} broken link(s) in ${files.length} markdown files`)
    console.error('A shipped doc names a repository-only file as a plain path, for example `oracle/x.spec.ts` (repository checkout).')
    process.exit(1)
}
console.log(`Doc links: ${files.length} markdown files, all relative links and anchors resolve; shipped docs link only to shipped files`)
