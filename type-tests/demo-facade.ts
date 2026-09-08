import type {createDemoParticipantFacade} from '../demo/server'
import type {ClientAPIAll} from '../src/Common/rcp/rpc-client'
import type {DeepSocketListenSmart} from '../src/Common/rcp/listen-deep'
import type {WorkboardItem, WorkboardRemote} from '../demo/workboard-contract'
import type {ConversationRemote} from '../src/Common/conversation/conversation-client'

type DemoFacade = ReturnType<typeof createDemoParticipantFacade>
declare const remote: ClientAPIAll<DeepSocketListenSmart<DemoFacade>>

const serverTime: Promise<string> = remote.serverTime()
const workboard: WorkboardRemote = remote.workboard
const created: Promise<WorkboardItem> = remote.workboard.create({requestId: 'r1', title: 'typed'})
const conversationState: ConversationRemote['state'] = remote.conversation.state
const conversationEvents: ConversationRemote['events'] = remote.conversation.events

// @ts-expect-error the source factory has a closed, intentional top-level facade
remote.unknownService
// @ts-expect-error a real domain input is required
remote.workboard.create({requestId: 'r2', title: 1})
// @ts-expect-error results retain domain types instead of becoming any
const wrongResult: Promise<number> = remote.workboard.create({requestId: 'r3', title: 'typed'})
// @ts-expect-error the read replica has no arbitrary command namespace
remote.miniScale.replica.deleteAll()

void serverTime
void workboard
void created
void conversationState
void conversationEvents
void wrongResult
