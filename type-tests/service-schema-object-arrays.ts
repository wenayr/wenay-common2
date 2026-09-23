import {schemaCommand, describeService, type InferInput, type tFieldSpec} from '../src/service'
import {createServiceClient} from '../src/service/client'

const schema = {
    recipe: {array: {object: {ingredientId: 'string', quantity: 'number'}}},
    checklist: {array: {object: {title: 'string', done: 'boolean', note: 'string?'}}, optional: true},
    tags: {array: 'string', optional: true},
    groups: {array: {array: {enum: ['first', 'second']}}},
} as const

type Expected = {
    readonly recipe: {readonly ingredientId: string, readonly quantity: number}[]
    readonly checklist?: {readonly title: string, readonly done: boolean, readonly note?: string}[]
    readonly tags?: string[]
    readonly groups: ('first' | 'second')[][]
}
type tEqual<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false
const exactInput: tEqual<InferInput<typeof schema>, Expected> = true
const command = schemaCommand(schema, {
    validate(input) {
        const quantity: number = input.recipe[0].quantity
        // @ts-expect-error object properties retain their declared types
        const bad: string = input.recipe[0].quantity
        void quantity
        void bad
    },
    apply(_ctx: unknown, input) { return input.recipe[0].quantity },
})
const exactArgs: tEqual<Parameters<typeof command.apply>[1], Expected> = true
const exactResult: tEqual<ReturnType<typeof command.apply>, number> = true

function check() {
    const valid = {recipe: [{ingredientId: 'dough', quantity: 250}], groups: []}
    command.apply(null, valid)
    command.apply(null, {...valid, checklist: [{title: 'Prepare', done: false}]})
    // @ts-expect-error quantity is required
    command.apply(null, {...valid, recipe: [{ingredientId: 'dough'}]})
    // @ts-expect-error quantity must be numeric
    command.apply(null, {...valid, recipe: [{ingredientId: 'dough', quantity: '250'}]})
    // @ts-expect-error required array cannot be omitted
    command.apply(null, {groups: []})
    // @ts-expect-error optional array still has required elements
    command.apply(null, {...valid, checklist: [undefined]})
    // @ts-expect-error required array has required elements
    command.apply(null, {...valid, recipe: [undefined]})
    // @ts-expect-error optional array is not nullable
    command.apply(null, {...valid, checklist: null})
    // @ts-expect-error undeclared element field
    command.apply(null, {...valid, checklist: [{title: 'Prepare', done: false, extra: true}]})
    // @ts-expect-error nested enums remain narrow
    command.apply(null, {...valid, groups: [['third']]})

    const definition = {name: 'arrays', storeId: 'arrays', originId: 'arrays', initial: {}, commands: {save: command}}
    const client = createServiceClient({definition: describeService(definition), url: ''})
    const reply: Promise<number> = client.commands.save('request', valid)
    // @ts-expect-error descriptor retains nested argument types
    client.commands.save('request', {...valid, recipe: [{ingredientId: 'dough', quantity: false}]})
    void reply
    client.close()
}

// @ts-expect-error optionality belongs to a field, not an array position
const optionalItem: tFieldSpec = {array: {object: {title: 'string'}, optional: true}}
// @ts-expect-error scalar '?' is not an array element schema
const optionalScalar: tFieldSpec = {array: 'string?'}
void [check, exactInput, exactArgs, exactResult, optionalItem, optionalScalar]
