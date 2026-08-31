// =====================================================================
// input-schema — the declarative command-input DSL of the scaffold
// =====================================================================
// TEMPLATE-OWNED: one runtime value in the service definition is the single
// source of three derived truths — automatic validation (runs before the
// command's own validate()), the TypeScript type of `input` (InferInput),
// and the JSON Schema body in the generated OpenAPI document. Deliberately
// tiny: scalars, '?' optionality, enums, arrays of a scalar, one nested
// object level per field — only what a command corridor honestly needs.
// No dependencies; pure data in, pure data out.

// ============================================================
// the schema shape
// ============================================================

export type tFieldKind = 'string' | 'number' | 'boolean' | 'date-string'

export type tFieldSpec =
    | tFieldKind
    | `${tFieldKind}?`
    | {enum: readonly string[], optional?: true}
    | {array: tFieldKind, optional?: true}
    | {object: tInputSchema, optional?: true}

export type tInputSchema = {[field: string]: tFieldSpec}

// ============================================================
// InferInput — the TS type derived from the runtime value
// ============================================================

type tScalar<K extends tFieldKind> =
    K extends 'number' ? number
        : K extends 'boolean' ? boolean
            : string

type tSpecValue<Sp> =
    Sp extends `${infer K extends tFieldKind}?` ? tScalar<K>
        : Sp extends tFieldKind ? tScalar<Sp>
            : Sp extends {enum: readonly (infer E extends string)[]} ? E
                : Sp extends {array: infer K extends tFieldKind} ? tScalar<K>[]
                    : Sp extends {object: infer O extends tInputSchema} ? InferInput<O>
                        : never

type tIsOptional<Sp> =
    Sp extends `${string}?` ? true
        : Sp extends {optional: true} ? true
            : false

// flatten the required/optional intersection so hovers show one object type
type tFlat<T> = {[K in keyof T]: T[K]} & {}

export type InferInput<Sch extends tInputSchema> = tFlat<
    {[K in keyof Sch as tIsOptional<Sch[K]> extends true ? never : K]: tSpecValue<Sch[K]>}
    & {[K in keyof Sch as tIsOptional<Sch[K]> extends true ? K : never]?: tSpecValue<Sch[K]>}
>

// ============================================================
// runtime validation — precise messages, throw before any effect
// ============================================================

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

/** The '?' suffix and the {optional: true} marker fold into one rule shape. */
function fieldRule(spec: tFieldSpec) {
    if (typeof spec == 'string') {
        const optional = spec.endsWith('?')
        return {optional, base: (optional ? spec.slice(0, -1) : spec) as tFieldKind}
    }
    return {optional: spec.optional == true, base: spec}
}

function checkScalar(kind: tFieldKind, value: unknown, path: string) {
    if (kind == 'string') {
        if (typeof value != 'string') throw new Error(path + ' must be a string')
    } else if (kind == 'number') {
        if (typeof value != 'number' || !Number.isFinite(value)) throw new Error(path + ' must be a finite number')
    } else if (kind == 'boolean') {
        if (typeof value != 'boolean') throw new Error(path + ' must be a boolean')
    } else {
        if (typeof value != 'string' || !ISO_DAY.test(value) || Number.isNaN(Date.parse(value))) {
            throw new Error(path + ' must be an ISO day (YYYY-MM-DD)')
        }
    }
}

function checkSpec(base: tFieldKind | Exclude<tFieldSpec, string>, value: unknown, path: string) {
    if (typeof base == 'string') return checkScalar(base, value, path)
    if ('enum' in base) {
        if (typeof value != 'string' || !base.enum.includes(value)) {
            throw new Error(path + ' must be one of: ' + base.enum.join(', '))
        }
        return
    }
    if ('array' in base) {
        if (!Array.isArray(value)) throw new Error(path + ' must be an array')
        for (let index = 0; index < value.length; index++) {
            checkScalar(base.array, value[index], path + '[' + index + ']')
        }
        return
    }
    checkObject(base.object, value, path)
}

function checkObject(schema: tInputSchema, value: unknown, path: string) {
    if (value == null || typeof value != 'object' || Array.isArray(value)) {
        throw new Error(path + ' must be an object')
    }
    const record = value as Record<string, unknown>
    // unknown fields are refused because the document promises
    // additionalProperties: false — enforcement and documentation match
    for (const key of Object.keys(record)) {
        if (!Object.hasOwn(schema, key)) throw new Error(path + '.' + key + ' is not a known field')
    }
    for (const [key, spec] of Object.entries(schema)) {
        const rule = fieldRule(spec)
        const fieldPath = path + '.' + key
        if (record[key] === undefined) {
            if (!rule.optional) throw new Error(fieldPath + ' is required')
            continue
        }
        checkSpec(rule.base, record[key], fieldPath)
    }
}

/** One validator per command, built once; a throw commits nothing (template contract). */
export function buildInputValidate(schema: tInputSchema) {
    return function validateInput(input: unknown) {
        checkObject(schema, input, 'input')
    }
}

// ============================================================
// JSON Schema — the OpenAPI face of the same value
// ============================================================

const SCALAR_JSON = {
    'string': {type: 'string'},
    'number': {type: 'number'},
    'boolean': {type: 'boolean'},
    'date-string': {type: 'string', format: 'date'},
} as const satisfies Record<tFieldKind, object>

function specJsonSchema(base: tFieldKind | Exclude<tFieldSpec, string>): object {
    if (typeof base == 'string') return {...SCALAR_JSON[base]}
    if ('enum' in base) return {type: 'string', enum: [...base.enum]}
    if ('array' in base) return {type: 'array', items: {...SCALAR_JSON[base.array]}}
    return inputJsonSchema(base.object)
}

/** JSON Schema (2020-12 subset, valid in OpenAPI 3.1 bodies) for one input schema. */
export function inputJsonSchema(schema: tInputSchema) {
    const properties: Record<string, object> = {}
    const required: string[] = []
    for (const [key, spec] of Object.entries(schema)) {
        const rule = fieldRule(spec)
        properties[key] = specJsonSchema(rule.base)
        if (!rule.optional) required.push(key)
    }
    return {
        type: 'object',
        properties,
        ...(required.length ? {required} : {}),
        // the validator above refuses unknown fields, so the document may say so
        additionalProperties: false,
    }
}

// ============================================================
// schemaCommand — bind a schema to a command with input INFERRED
// ============================================================
// `satisfies` alone cannot thread each command's schema into its own apply()
// parameter (no per-member inference through a Record), so the binding is a
// one-line helper: the author annotates ctx, the input type arrives from the
// schema. Ctx stays generic — this file knows nothing about the leader.

export function schemaCommand<const Sch extends tInputSchema, Ctx, R>(
    input: Sch,
    command: {
        /** Cross-field/domain rules only; the schema already owns the shape. */
        validate?: (input: InferInput<Sch>) => void
        apply: (ctx: Ctx, input: InferInput<Sch>) => R
    },
) {
    return {input, ...command}
}
