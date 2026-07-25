#!/usr/bin/env node

import path from 'node:path'
import {HTTPS_COMMANDS, HttpsConfigInput, tHttpsCommand} from '../Common/https/https-config'
import {createNodeHttpsManager} from '../Common/https/https-manager'

type ParsedArgs = {
    command?: tHttpsCommand
    projectRoot: string
    configPath?: string
    json: boolean
    help: boolean
    overrides: Partial<HttpsConfigInput>
}

const VALUE_OPTIONS = {
    '--project': 'projectRoot',
    '--config': 'configPath',
    '--identity': 'identity',
    '--backend': 'backend',
    '--public-port': 'publicPort',
    '--challenge-port': 'challengePort',
    '--bind': 'bind',
    '--email': 'email',
    '--wait': 'certificateWaitSeconds',
    '--caddy': 'caddyPath',
} as const

const NUMBER_OPTIONS = new Set([
    'publicPort',
    'challengePort',
    'certificateWaitSeconds',
])

function helpText() {
    return `wenay-https - automatic Caddy HTTPS management

Usage:
  wenay-https ensure [options]
  wenay-https status [--project <dir>] [--json]
  wenay-https doctor [options]
  wenay-https stop [--project <dir>]

The default configuration file is ./wenay-https.json:
  {
      "identity": "example.com",
      "backend": "127.0.0.1:3000",
      "publicPort": 443,
      "challengePort": 80,
      "bind": "0.0.0.0",
      "email": "admin@example.com"
  }

Options:
  --project <dir>          consuming project root (default: current directory)
  --config <file>          config path relative to the project root
  --identity <host|ip>     certificate identity
  --backend <url|host:port>
  --public-port <port>     HTTPS listener (default: 443)
  --challenge-port <port>  local ACME HTTP-01 listener (default: 80)
  --bind <ip>              Caddy bind address (default: 0.0.0.0)
  --email <address>        ACME account email
  --wait <seconds>         certificate readiness timeout (default: 120)
  --caddy <path>           explicit Caddy executable
  --json                   machine-readable output
  --help

Public TCP 80 must reach challengePort. Keep Caddy running so it can renew certificates.
`
}

function parseArgs(argv: string[]) {
    const parsed: ParsedArgs = {
        projectRoot: process.cwd(),
        json: false,
        help: false,
        overrides: {},
    }
    for (let index = 0; index < argv.length; index++) {
        const arg = argv[index]
        if (arg == '--help' || arg == '-h') {
            parsed.help = true
            continue
        }
        if (arg == '--json') {
            parsed.json = true
            continue
        }
        if (!arg.startsWith('-') && !parsed.command) {
            if (!Object.hasOwn(HTTPS_COMMANDS, arg)) throw new Error(`unknown command: ${arg}`)
            parsed.command = arg as tHttpsCommand
            continue
        }
        const target = VALUE_OPTIONS[arg as keyof typeof VALUE_OPTIONS]
        if (!target) throw new Error(`unknown option: ${arg}`)
        const value = argv[++index]
        if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
        if (target == 'projectRoot') {
            parsed.projectRoot = path.resolve(value)
        } else if (target == 'configPath') {
            parsed.configPath = value
        } else if (NUMBER_OPTIONS.has(target)) {
            parsed.overrides[target as 'publicPort'] = Number(value)
        } else {
            parsed.overrides[target as 'identity'] = value
        }
    }
    return parsed
}

function writeResult(result: unknown, json: boolean) {
    if (json) {
        process.stdout.write(JSON.stringify(result, null, 2) + '\n')
        return
    }
    if (typeof result == 'string') {
        process.stdout.write(result + '\n')
        return
    }
    process.stdout.write(JSON.stringify(result, null, 2) + '\n')
}

export async function runHttpsCli(argv = process.argv.slice(2)) {
    const parsed = parseArgs(argv)
    if (parsed.help || !parsed.command) {
        process.stdout.write(helpText())
        return 0
    }

    const manager = createNodeHttpsManager({
        projectRoot: parsed.projectRoot,
        configPath: parsed.configPath,
        onLog: function cliLog(message) {
            const stream = parsed.json ? process.stderr : process.stdout
            stream.write(message + '\n')
        },
    })

    if (parsed.command == 'ensure') {
        writeResult(await manager.ensure(parsed.overrides), parsed.json)
    } else if (parsed.command == 'doctor') {
        const result = await manager.doctor(parsed.overrides)
        writeResult(result, parsed.json)
        return result.ok ? 0 : 1
    } else if (parsed.command == 'status') {
        const result = await manager.status()
        writeResult(result, parsed.json)
        return result.running && result.owned ? 0 : 1
    } else {
        writeResult(await manager.stop(), parsed.json)
    }
    return 0
}

if (require.main == module) {
    runHttpsCli().then(function cliComplete(code) {
        process.exitCode = code
    }, function cliFailed(error) {
        process.stderr.write((error as Error).stack || String(error))
        process.stderr.write('\n')
        process.exitCode = 1
    })
}
