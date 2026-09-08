import assert from 'node:assert/strict'
import {buildInputValidate, inputJsonSchema, schemaCommand} from '../../template/input-schema'
import {createServiceLeader, type ServiceCommandCtx, type tServiceDefinition} from '../../template/leader'

const schema = {day: 'date-string', contact: {object: {email: 'string'}}} as const
const valid = {day: '2024-02-29', contact: {email: 'test@example.invalid'}}
const invalidDays = ['2026-02-29', '1900-02-29', '2026-02-30', '2026-04-31', '2026-13-01', '2026-00-01', '2026-01-00', '2026-1-01', '2026-01-01T00:00:00Z']

async function main() {
    const validate = buildInputValidate(schema)
    for (const day of ['2000-02-29', '2024-02-29', '2026-02-28', '2026-04-30', '0099-01-01']) {
        assert.doesNotThrow(function validDay() { validate({...valid, day}) })
    }
    for (const day of invalidDays) {
        assert.throws(function invalidDay() { validate({...valid, day}) }, /input.day must be an ISO day/, day)
    }
    const extraField = {...valid, contact: {...valid.contact, secret: true}}
    assert.throws(function nestedUnknown() { validate(extraField) }, /input.contact.secret is not a known field/)
    const dates = buildInputValidate({days: {array: 'date-string'}})
    assert.throws(function invalidArrayDay() { dates({days: ['2024-02-29', '2026-02-29']}) }, /input.days\[1\] must be an ISO day/)
    const document = inputJsonSchema(schema)
    assert.deepEqual(document.properties.day, {type: 'string', format: 'date'})

    type State = {result: {effects: number, day: string}}
    let domainChecks = 0
    const definition = {
        name: 'schema-check', storeId: 'schema-check-store', originId: 'schema-check-origin',
        initial: {result: {effects: 0, day: ''}},
        commands: {
            record: schemaCommand(schema, {
                validate() { domainChecks++ },
                apply(ctx: ServiceCommandCtx<State>, input) {
                    ctx.state.result.effects++
                    ctx.state.result.day = input.day
                    return {...ctx.state.result}
                },
            }),
        },
    } satisfies tServiceDefinition<State>
    const leader = createServiceLeader({definition, selfUrl: () => 'mem://schema-check', log() {}})
    try {
        leader.control.start()
        const before = JSON.stringify(leader.view.state())
        for (const day of invalidDays) {
            await assert.rejects(leader.corridor.execute('owner', 'record', 'retry', {...valid, day}), /input.day must be an ISO day/)
        }
        await assert.rejects(leader.corridor.execute('owner', 'record', 'retry', extraField), /input.contact.secret is not a known field/)
        assert.equal(domainChecks, 0)
        assert.equal(JSON.stringify(leader.view.state()), before)
        const result = await leader.corridor.execute('owner', 'record', 'retry', valid)
        assert.deepEqual(result, {effects: 1, day: valid.day})
        assert.deepEqual(await leader.corridor.execute('owner', 'record', 'retry', valid), result)
        assert.equal(domainChecks, 1)
        assert.equal(leader.view.state().result.effects, 1)
    } finally { leader.control.close() }
    console.log('PASS input schema: real calendar days, nested/array paths, rejection before domain effects and same-ID retry')
}

main().catch(function failed(error) { console.error(error); process.exitCode = 1 })
