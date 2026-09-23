// Every relative link and heading anchor in shipped markdown must resolve.
// doc/changes keeps a rolling ten-version window, so links into a pruned version
// file rot silently on each release; this check makes that rot fail the test run.
//   node scripts/verify-doc-links.mjs
import {readdirSync, readFileSync, existsSync, statSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Shipped markdown, mirroring package.json "files"; doc/target and doc/progress are not packed.
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
    for (const match of text.matchAll(/\]\(<?([^)\s>]+)>?(?:\s+"[^"]*")?\)/g)) {
        const href = match[1]
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) continue
        const [target, hash] = href.split('#')
        const resolved = target ? path.resolve(path.dirname(file), decodeURIComponent(target)) : file
        const from = path.relative(root, file).replaceAll('\\', '/')
        if (!existsSync(resolved)) broken.push(`missing file   ${from} -> ${href}`)
        else if (hash && resolved.endsWith('.md') && !anchorsOf(resolved).has(decodeURIComponent(hash).toLowerCase()))
            broken.push(`missing anchor ${from} -> ${href}`)
    }
}

if (broken.length) {
    console.error(broken.join('\n'))
    console.error(`${broken.length} broken link(s) in ${files.length} markdown files`)
    process.exit(1)
}
console.log(`Doc links: ${files.length} markdown files, all relative links and anchors resolve`)
