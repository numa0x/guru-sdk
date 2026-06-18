#!/usr/bin/env node

import {
    existsSync,
    readdirSync,
    readFileSync,
    statSync,
    writeFileSync,
} from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'

const targetDir = process.argv[2]

if (!targetDir) {
    throw new Error('Usage: node scripts/fix-esm-imports.mjs <dist-dir>')
}

const root = resolve(process.cwd(), targetDir)
const importSpecifierPattern =
    /\b(from\s*["']|import\s*\(\s*["'])(\.{1,2}\/[^"']+)(["'])/g

function listFiles(dir) {
    return readdirSync(dir).flatMap((entry) => {
        const path = join(dir, entry)
        const stats = statSync(path)
        if (stats.isDirectory()) return listFiles(path)
        return stats.isFile() ? [path] : []
    })
}

function resolveRelativeSpecifier(file, specifier) {
    const base = resolve(dirname(file), specifier)
    if (existsSync(`${base}.js`)) return `${specifier}.js`
    if (existsSync(join(base, 'index.js'))) return `${specifier}/index.js`
    if (extname(specifier)) return specifier

    return specifier
}

function fixJs(source, file) {
    return source.replace(
        importSpecifierPattern,
        (match, prefix, specifier, suffix) => {
            return `${prefix}${resolveRelativeSpecifier(file, specifier)}${suffix}`
        }
    )
}

function stripDeclarationComments(source) {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
}

for (const file of listFiles(root)) {
    if (!file.endsWith('.js') && !file.endsWith('.d.ts')) continue

    const source = readFileSync(file, 'utf8')
    const next = file.endsWith('.js')
        ? fixJs(source, file)
        : stripDeclarationComments(source)

    if (next !== source) {
        writeFileSync(file, next)
    }
}

