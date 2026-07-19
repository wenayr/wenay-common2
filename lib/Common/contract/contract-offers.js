"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createContractOffers = createContractOffers;
const Listen_1 = require("../events/Listen");
function requiredId(value, label) {
    if (typeof value != 'string' || !value.trim())
        throw new Error('contract offers: ' + label + ' is required');
    return value.trim();
}
function createContractOffers(initial = []) {
    const offers = new Map();
    const [emitChanges, changes] = (0, Listen_1.listen)();
    function publish() {
        emitChanges(Array.from(offers.values()));
    }
    function upsert(offer) {
        const id = requiredId(offer.id, 'offer id');
        const saved = { ...offer, id };
        offers.set(id, saved);
        publish();
        return function removeThisOffer() {
            if (offers.get(id) != saved)
                return;
            offers.delete(id);
            publish();
        };
    }
    function replace(next) {
        offers.clear();
        for (const offer of next) {
            const id = requiredId(offer.id, 'offer id');
            offers.set(id, { ...offer, id });
        }
        publish();
    }
    replace(initial);
    return {
        control: {
            upsert,
            remove(id) {
                if (!offers.delete(id))
                    return false;
                publish();
                return true;
            },
            replace,
            clear() {
                if (!offers.size)
                    return;
                offers.clear();
                publish();
            },
        },
        api: {
            list: () => Array.from(offers.values()),
            changes,
        },
    };
}
