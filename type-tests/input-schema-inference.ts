import {schemaCommand, type InferInput} from '../experiments/wenay-scaffold/template/input-schema'

// The schema VALUE is the source of the input type: every spec form must land
// on its exact TS counterpart, optionality included, with no widening to any.
type tBookInput = InferInput<{
    itemId: 'string'
    from: 'date-string'
    days: 'number?'
    confirmed: 'boolean'
    kind: {enum: ['standard', 'premium']}
    tags: {array: 'string', optional: true}
    contact: {object: {email: 'string', phone: 'string?'}}
}>

const inferred: tBookInput = {
    itemId: 'kayak',
    from: '2026-09-01',
    confirmed: true,
    kind: 'premium',
    contact: {email: 'a@b.c'},
}
const itemId: string = inferred.itemId
const days: number | undefined = inferred.days
const kind: 'standard' | 'premium' = inferred.kind
const tags: string[] | undefined = inferred.tags
const phone: string | undefined = inferred.contact.phone

// @ts-expect-error a value outside the declared enum is not assignable
const wrongKind: tBookInput = {...inferred, kind: 'luxury'}
// @ts-expect-error a required field cannot be omitted
const missingItemId: tBookInput = {from: '2026-09-01', confirmed: true, kind: 'standard', contact: {email: 'a@b.c'}}
// @ts-expect-error 'number?' stays a number, not a string
const stringDays: tBookInput = {...inferred, days: 'three'}

// schemaCommand threads the schema into validate/apply without annotations.
const command = schemaCommand({itemId: 'string', from: 'date-string'}, {
    validate(input) {
        const from: string = input.from
        void from
        // @ts-expect-error the schema declared no such field
        void input.to
    },
    apply(ctx: {account: string}, input) {
        return {item: input.itemId, by: ctx.account}
    },
})
const commandSchema: {itemId: 'string', from: 'date-string'} = command.input
const receipt: {item: string, by: string} = command.apply({account: 'a'}, {itemId: 'kayak', from: '2026-09-01'})

void itemId
void days
void kind
void tags
void phone
void wrongKind
void missingItemId
void stringDays
void commandSchema
void receipt
