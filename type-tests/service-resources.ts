import {describeService, type tServiceDefinition, type ServiceResourceContext} from '../src/service'
import {createServiceClient} from '../src/service/client'
import {listen} from '../src/Common/events/Listen'

const [, changes] = listen<[number]>()
const definition = {
    name: 'resources', storeId: 'resources', originId: 'authority', initial: {secret: 'server-only'}, commands: {},
    resources: {
        counter: {allow: ['member'], placement: 'authority', open(ctx: ServiceResourceContext) {
            return {facade: {control: {add: (amount: number) => amount}, events: changes, view: {account: () => ctx.principal.account}}, close() {}}
        }},
        label: {allow: ['member'], placement: 'authority', async open() {
            return {facade: {view: {label: (prefix: string) => prefix + '!'}}, async close() {}}
        }},
    },
} satisfies tServiceDefinition<any, any>

function check() {
    const descriptor = describeService(definition)
    const client = createServiceClient({definition: descriptor, url: ''})
    const counter = client.resources.open('counter')
    const current = counter.current()
    if (current) {
        const result: Promise<number> = current.remote.control.add(2)
        const account: Promise<string> = current.remote.view.account()
        const off = current.remote.events.on(function changed(value) { const n: number = value; void n })
        off()
        // @ts-expect-error resource argument remains numeric
        current.remote.control.add('2')
        // @ts-expect-error second resource facade is not merged into the first
        current.remote.view.label('hi')
        void result; void account
    }
    const label = client.resources.open('label').current()
    if (label) {
        const result: Promise<string> = label.remote.view.label('hi')
        // @ts-expect-error async factory does not erase arguments
        label.remote.view.label(1)
        void result
    }
    // @ts-expect-error only registry names may be opened
    client.resources.open('missing')
    // @ts-expect-error no client-supplied factory parameters
    client.resources.open('counter', {sessionId: 'spoof'})
    // @ts-expect-error descriptor never exposes executable factories
    descriptor.resources!.counter.open
    // @ts-expect-error descriptor never exposes initial state
    descriptor.initial
    const closed: Promise<void> = counter.close()
    void closed
    client.close()
}
void check
