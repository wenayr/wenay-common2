const fs = require('node:fs')
const path = require('node:path')

const root = path.join(process.cwd(), 'src', 'Common', 'rcp')
const assignmentOperators = new Set([
    '=',
    '+=',
    '-=',
    '*=',
    '**=',
    '/=',
    '%=',
    '&=',
    '|=',
    '^=',
    '<<=',
    '>>=',
    '>>>=',
    '&&=',
    '||=',
    '??=',
])

function files(dir) {
    const out = []
    for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) out.push(...files(full))
        else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
    }
    return out
}

function lineAndColumn(source, pos) {
    const before = source.slice(0, pos)
    const line = before.split(/\r?\n/).length
    const lastLineStart = Math.max(before.lastIndexOf('\n'), before.lastIndexOf('\r'))
    return `${line}:${pos - lastLineStart}`
}

function scanTokens(source, ast) {
    const scanner = ast.createScanner(true, undefined, source)
    const tokens = []
    const templateBraceDepth = []

    while (true) {
        let kind = scanner.scan()
        if (kind == ast.SyntaxKind.EndOfFile) break

        if (kind == ast.SyntaxKind.TemplateHead) {
            templateBraceDepth.push(0)
        } else if (templateBraceDepth.length && kind == ast.SyntaxKind.OpenBraceToken) {
            templateBraceDepth[templateBraceDepth.length - 1]++
        } else if (templateBraceDepth.length && kind == ast.SyntaxKind.CloseBraceToken) {
            const top = templateBraceDepth.length - 1
            if (templateBraceDepth[top] > 0) {
                templateBraceDepth[top]--
            } else {
                kind = scanner.reScanTemplateToken(false)
                if (kind != ast.SyntaxKind.TemplateMiddle) templateBraceDepth.pop()
            }
        }

        tokens.push({
            kind,
            pos: scanner.getTokenStart(),
            text: scanner.getTokenText(),
        })
    }
    return tokens
}

function directReads(source, ast) {
    const tokens = scanTokens(source, ast)
    const failures = []

    for (let i = 0; i < tokens.length - 2; i++) {
        if (tokens[i].kind != ast.SyntaxKind.OpenBracketToken
            || tokens[i + 1].kind != ast.SyntaxKind.Identifier
            || tokens[i + 1].text != 'IS_RPC_LISTEN'
            || tokens[i + 2].kind != ast.SyntaxKind.CloseBracketToken) continue

        if (!assignmentOperators.has(tokens[i + 3]?.text)) {
            failures.push(lineAndColumn(source, tokens[i].pos))
        }
    }
    return failures
}

function assertScanner(ast) {
    const cases = [
        ['value[IS_RPC_LISTEN] = true', 0],
        ['value[IS_RPC_LISTEN] ||= true', 0],
        ['const found = value[IS_RPC_LISTEN]', 1],
        ['const equal = value[IS_RPC_LISTEN] == true', 1],
        ['// value[IS_RPC_LISTEN]\nconst text = "[IS_RPC_LISTEN]"', 0],
        ['const text = `value[IS_RPC_LISTEN]`', 0],
        ['const text = `${value[IS_RPC_LISTEN]}`', 1],
    ]
    for (const [source, expected] of cases) {
        if (directReads(source, ast).length != expected) {
            throw new Error(`RPC guard scanner self-check failed for: ${source}`)
        }
    }
}

async function main() {
    const ast = await import('typescript/unstable/ast')
    assertScanner(ast)

    const failures = []
    for (const file of files(root)) {
        const source = fs.readFileSync(file, 'utf8')
        for (const location of directReads(source, ast)) {
            failures.push(`${path.relative(process.cwd(), file)}:${location}`)
        }
    }

    if (failures.length) {
        console.error('Forbidden direct reads of [IS_RPC_LISTEN]. Use Object.prototype.hasOwnProperty.call(obj, IS_RPC_LISTEN).')
        for (const failure of failures) console.error(`  ${failure}`)
        process.exitCode = 1
        return
    }

    console.log('PASS rpc symbol guard: no direct reads of [IS_RPC_LISTEN]')
}

main().catch(function onError(error) {
    console.error(error)
    process.exitCode = 1
})
