import {describeService, schemaCommand, type ServiceCommandCtx, type tServiceDefinition} from '../src/service'
import {createServiceClient} from '../src/service/client'

const definition = {
    name: 'test', storeId: 'test', originId: 'test', initial: {count: 0, secret: 'seed'},
    commands: {
        add: schemaCommand({amount: 'number'}, {apply(ctx: ServiceCommandCtx<{count: number}>, input) {
            ctx.state.count += input.amount
            return {count: ctx.state.count}
        }}),
    },
    views: {counter: {allow: 'public', project: (state: {count: number}) => ({count: state.count})}},
} satisfies tServiceDefinition<any, any>

function check() {
    const client = createServiceClient({definition: describeService(definition), url: ''})
    const count: number = client.views.counter.store.state.count
    const result: Promise<{count: number}> = client.commands.add('id', {amount: 1})
    // @ts-expect-error unknown command
    client.commands.remove('id', {})
    // @ts-expect-error schema input preserved through descriptor
    client.commands.add('id', {amount: '1'})
    // @ts-expect-error projection does not include server secrets
    client.views.counter.store.state.secret
    // @ts-expect-error unknown view
    client.views.raw
    void count
    void result
    client.close()
}
void check
