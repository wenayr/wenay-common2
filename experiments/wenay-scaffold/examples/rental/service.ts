// =====================================================================
// rental — the domain module, assembled FROM the scaffold (plan step 7c)
// =====================================================================
// The ONLY authored file of the service: state shape, commands, read policy.
// Domain rules:
//   - a booking holds one item for the half-open span [from, to) of ISO days,
//     from strictly before to — back-to-back bookings share a turnover day;
//   - two ACTIVE bookings of one item may not overlap; a cancelled booking
//     frees its dates immediately;
//   - only the account that booked may cancel, and the account always arrives
//     from the verified token via ctx — never from command input;
//   - the public board hides WHO booked: items plus active spans only.
//
// TODO(graduation): '../../template/leader' becomes the scaffold package
// entrypoint when the template graduates out of the incubator.

import type {ServiceCommandCtx, tServiceDefinition} from '../../template/leader'

export type RentalItem = {id: string, title: string, pricePerDay: number}
export type RentalBooking = {
    id: string
    itemId: string
    account: string
    from: string
    to: string
    state: 'active' | 'cancelled'
    ts: number
}
export type RentalState = {
    items: Record<string, RentalItem>
    bookings: Record<string, RentalBooking>
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/

function requireIsoDay(value: unknown, label: string) {
    const day = String(value ?? '')
    if (!ISO_DAY.test(day) || Number.isNaN(Date.parse(day))) {
        throw new Error(`${label} must be an ISO day (YYYY-MM-DD)`)
    }
    return day
}

/** Half-open spans [from, to): ISO days compare correctly as strings. */
function overlaps(a: {from: string, to: string}, b: {from: string, to: string}) {
    return a.from < b.to && b.from < a.to
}

export const serviceDefinition = {
    /** Wire identity: the RPC wrap key every surface is served under. */
    name: 'rental',
    /** Replica-line coordinates; leader and nodes share them. */
    storeId: 'rental-store',
    originId: 'rental-origin',
    /** The authoritative store; seeded with the stand's three rentable items. */
    initial: {
        items: {
            kayak: {id: 'kayak', title: 'Sea kayak', pricePerDay: 35},
            tent: {id: 'tent', title: 'Alpine tent', pricePerDay: 20},
            ebike: {id: 'ebike', title: 'Cargo e-bike', pricePerDay: 50},
        },
        bookings: {},
    } as RentalState,
    commands: {
        book: {
            // validate() is stateless by the template contract: shape rules live
            // here; state rules (item exists, no overlap) guard apply() below
            // BEFORE its first mutation, so a refusal still commits nothing.
            validate(input: {itemId?: unknown, from?: unknown, to?: unknown}) {
                if (typeof input?.itemId != 'string' || !input.itemId) {
                    throw new Error('itemId must be a non-empty string')
                }
                const from = requireIsoDay(input.from, 'from')
                const to = requireIsoDay(input.to, 'to')
                if (from >= to) throw new Error('from must be strictly before to')
            },
            apply(ctx: ServiceCommandCtx<RentalState>, input: {itemId: string, from: string, to: string}) {
                const item = ctx.state.items[input.itemId]
                if (!item) throw new Error(`unknown item: ${input.itemId}`)
                for (const other of Object.values(ctx.state.bookings)) {
                    if (other.itemId == item.id && other.state == 'active' && overlaps(other, input)) {
                        throw new Error(`${item.id} is already booked ${other.from}..${other.to}`)
                    }
                }
                const booking: RentalBooking = {
                    // requestId IS the attempt's identity, so the id survives retries
                    id: 'bk-' + ctx.requestId,
                    itemId: item.id,
                    account: ctx.account,
                    from: input.from,
                    to: input.to,
                    state: 'active',
                    ts: Date.now(),
                }
                ctx.state.bookings[booking.id] = booking
                return booking
            },
        },
        cancel: {
            validate(input: {bookingId?: unknown}) {
                if (typeof input?.bookingId != 'string' || !input.bookingId) {
                    throw new Error('bookingId must be a non-empty string')
                }
            },
            apply(ctx: ServiceCommandCtx<RentalState>, input: {bookingId: string}) {
                const booking = ctx.state.bookings[input.bookingId]
                if (!booking) throw new Error(`unknown booking: ${input.bookingId}`)
                // ownership comes from the verified token principal, never from input
                if (booking.account != ctx.account) throw new Error('only the booking owner may cancel')
                if (booking.state != 'active') throw new Error('booking is already cancelled')
                booking.state = 'cancelled'
                return {...booking}
            },
        },
    },
    /** Read policy: the public board — items and active spans, WHO booked stays private. */
    readerFacet(state: RentalState) {
        const bookings = Object.values(state.bookings)
            .filter(booking => booking.state == 'active')
            .map(booking => ({id: booking.id, itemId: booking.itemId, from: booking.from, to: booking.to}))
            .sort((a, b) => (a.from + a.id).localeCompare(b.from + b.id))
        return {
            items: Object.values(state.items).map(item => ({...item})),
            bookings,
        }
    },
} satisfies tServiceDefinition<RentalState>

/** The definition is the source of its own type; hosts consume the contract. */
export type RentalDefinition = typeof serviceDefinition
