// Acceptance oracle: a bounded neighbor portfolio keeps quality anchors,
// rescues an under-connected peer and spends the remaining budget on
// topologically different connection offers.

import {
    createPeerNeighborPortfolio,
    PeerNeighborCandidate,
} from '../src/Common/peer/peer-neighbor-portfolio'
import {PeerPacketOffer} from '../src/Common/peer/peer-packet-mesh'

type Payload = {value: string}

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}
const json = (value: unknown) => JSON.stringify(value)

function offer(id: string, priority = 0): PeerPacketOffer<Payload> {
    return {
        id,
        peerId: id,
        priority,
        connect() {
            throw new Error('selection oracle must not open transport sessions')
        },
    }
}

function candidate(
    id: string,
    rttMs: number,
    opts: Omit<PeerNeighborCandidate<Payload>, 'offer' | 'quality'> = {},
): PeerNeighborCandidate<Payload> {
    return {
        offer: offer(id),
        quality: {rttMs, loss: 0},
        ...opts,
    }
}

function ids(portfolio: ReturnType<typeof createPeerNeighborPortfolio<Payload>>) {
    return portfolio.view.selected().map(row => row.id)
}

function main() {
    console.log('\n[peer-neighbor-portfolio] quality, rescue and marginal diversity')

    const initial = [
        candidate('quality-a', 10, {
            degree: 5,
            diversityKeys: ['sector:north', 'channel:one'],
            reachable: ['target-a'],
            paths: [['quality-a', 'shared-a']],
        }),
        candidate('quality-b', 20, {
            degree: 5,
            diversityKeys: ['sector:north', 'channel:one'],
            reachable: ['target-a'],
            paths: [['quality-b', 'shared-a']],
        }),
        candidate('overlap', 30, {
            degree: 5,
            diversityKeys: ['sector:north', 'channel:one'],
            reachable: ['target-a'],
            paths: [['overlap', 'shared-a']],
        }),
        candidate('east', 60, {
            degree: 5,
            diversityKeys: ['sector:east', 'channel:two'],
            reachable: ['target-b'],
            paths: [['east', 'branch-b']],
        }),
        candidate('west', 70, {
            degree: 5,
            diversityKeys: ['sector:west', 'channel:three'],
            reachable: ['target-c'],
            paths: [['west', 'branch-c']],
        }),
        candidate('isolated', 500, {
            degree: 0,
            minDegree: 3,
            diversityKeys: ['sector:north', 'channel:one'],
            reachable: ['target-a'],
            paths: [['isolated', 'shared-a']],
        }),
    ]
    const portfolio = createPeerNeighborPortfolio<Payload>({
        nodeId: 'local',
        budget: 5,
        qualityLinks: 2,
        rescueLinks: 1,
        initial,
    })

    const selected = portfolio.view.selected()
    ok(json(ids(portfolio)) == json(['quality-a', 'quality-b', 'isolated', 'east', 'west']),
        'two quality anchors, one isolated rescue and two distinct branches fill the budget')
    ok(selected.find(row => row.id == 'isolated')?.role == 'rescue',
        'zero-degree peer is admitted through the bounded rescue slot despite poor RTT')
    ok(!ids(portfolio).includes('overlap'),
        'a cheap but redundant neighbor loses to marginal route/failure-domain diversity')
    ok(json(portfolio.offers.list().map(item => item.id)) == json(ids(portfolio)),
        'selected offers are retransmitted through the existing mesh offer facade')

    const oldIsolated = portfolio.control.upsert(candidate('isolated', 500, {
        degree: 0,
        minDegree: 3,
        diversityKeys: ['sector:north', 'channel:one'],
        reachable: ['target-a'],
        paths: [['isolated', 'shared-a']],
    }))
    portfolio.control.upsert(candidate('isolated', 500, {
        degree: 3,
        minDegree: 3,
        diversityKeys: ['sector:north', 'channel:one'],
        reachable: ['target-a'],
        paths: [['isolated', 'shared-a']],
    }))
    oldIsolated()
    ok(!ids(portfolio).includes('isolated') && ids(portfolio).includes('overlap'),
        'degree recovery removes rescue priority and an old removal handle cannot delete the new sample')

    portfolio.control.sample('quality-a', {rttMs: 1000, loss: 0})
    ok(!portfolio.view.selected().some(row => row.id == 'quality-a' && row.role == 'quality') &&
        portfolio.view.selected().some(row => row.id == 'overlap' && row.role == 'quality'),
        'a fresh RTT sample automatically replaces a degraded quality anchor')

    portfolio.control.remove('east')
    ok(portfolio.offers.list().length == 5 && !ids(portfolio).includes('east'),
        'removing a selected candidate immediately heals the bounded offer set')

    let invalidLossRejected = false
    try {
        portfolio.control.upsert({
            offer: offer('invalid'),
            quality: {rttMs: 1, loss: 2},
        })
    } catch { invalidLossRejected = true }
    ok(invalidLossRejected, 'invalid physical-link samples fail before selection state changes')

    portfolio.close()
    ok(portfolio.offers.list().length == 0, 'close withdraws every selected offer')

    console.log(fails ? `\n${fails} FAILED` : '\nall passed')
    if (fails) process.exit(1)
}

main()
