"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWebhookClient = exports.createWebhookServer = exports.apiSaveData = exports.buildSelfWebhookUrl = void 0;
const express_1 = __importDefault(require("express"));
const axios_1 = __importDefault(require("axios"));
const fs = __importStar(require("fs"));
const waitRun_1 = require("../Common/async/waitRun");
const SUBSCRIBERS_FILE = './subscribers.json';
const loadSubscribers = () => {
    try {
        if (!fs.existsSync(SUBSCRIBERS_FILE))
            fs.writeFileSync(SUBSCRIBERS_FILE, '{}', 'utf-8');
        const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8'));
        return new Map(Object.entries(data).map(([k, s]) => [k, { url: s.url, tag: s.tag ?? s.tags, expireAt: new Date(s.expireAt) }]));
    }
    catch (e) {
        console.error('Ошибка загрузки подписчиков, файл сброшен:', e);
        fs.writeFileSync(SUBSCRIBERS_FILE, '{}', 'utf-8');
        return new Map();
    }
};
const Queue = (0, waitRun_1.createAsyncQueue)(1);
let _tmpSeq = 0;
const saveSubscribers = (subs) => {
    const obj = Object.fromEntries([...subs].map(([k, s]) => [k, { url: s.url, tag: s.tag, expireAt: s.expireAt }]));
    Queue.enqueue(async () => {
        const tmp = `${SUBSCRIBERS_FILE}.${++_tmpSeq}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
        await fs.promises.rename(tmp, SUBSCRIBERS_FILE);
    });
};
const normalizeIP = (ip) => ip?.startsWith('::ffff:') ? ip.slice(7) : ip;
const buildSelfWebhookUrl = (clientIp, raw) => {
    if (typeof raw !== 'string' || !raw)
        return null;
    let u;
    try {
        u = new URL('http://' + clientIp + raw);
    }
    catch {
        return null;
    }
    return u.hostname === clientIp ? u.toString() : null;
};
exports.buildSelfWebhookUrl = buildSelfWebhookUrl;
exports.apiSaveData = { loadSubscribers, saveSubscribers };
const createWebhookServer = (params) => {
    const app = params.app ?? (0, express_1.default)();
    if (!params.app)
        app.use(express_1.default.json());
    const file = params.file ?? exports.apiSaveData;
    const { authToken, port } = params;
    const subscribers = file.loadSubscribers();
    const checkAuth = (req, res, next) => {
        if (req.headers.authorization !== authToken) {
            res.status(403).json({ error: 'Недействительный токен авторизации' });
            return;
        }
        next();
    };
    const clientAddr = (req) => 'http://' + normalizeIP(req.ip ?? '127.0.0.1');
    const purgeExpired = () => {
        const now = Date.now();
        let changed = false;
        subscribers.forEach((s, k) => { if (s.expireAt.getTime() <= now) {
            subscribers.delete(k);
            changed = true;
        } });
        if (changed)
            file.saveSubscribers(subscribers);
    };
    const renewExpiry = () => new Date(Date.now() + 3 * 24 * 3600_000);
    app.post('/webHook_subscribe', checkAuth, (req, res) => {
        const { tag } = req.body;
        const url = (0, exports.buildSelfWebhookUrl)(normalizeIP(req.ip ?? '127.0.0.1'), req.body.url);
        if (!url || typeof tag !== 'string') {
            res.status(400).json({ error: 'Неверный запрос' });
            return;
        }
        purgeExpired();
        subscribers.set(url, { url, tag, expireAt: renewExpiry() });
        file.saveSubscribers(subscribers);
        res.json({ message: 'Подписка оформлена' });
    });
    app.get('/webHook_status', checkAuth, (req, res) => {
        const url = (0, exports.buildSelfWebhookUrl)(normalizeIP(req.ip ?? '127.0.0.1'), req.query['url']);
        if (!url) {
            res.status(400).json({ error: 'Неверный запрос' });
            return;
        }
        purgeExpired();
        const subscriber = Array.from(subscribers.values()).find(s => s.url === url);
        if (!subscriber) {
            res.json({ subscribed: false });
            return;
        }
        subscriber.expireAt = renewExpiry();
        file.saveSubscribers(subscribers);
        res.json({ subscribed: true, expireAt: subscriber.expireAt });
    });
    app.delete('/webHook_unsubscribe', checkAuth, (req, res) => {
        const url = (0, exports.buildSelfWebhookUrl)(normalizeIP(req.ip ?? '127.0.0.1'), req.body.url);
        if (!url) {
            res.status(400).json({ error: 'Неверный запрос' });
            return;
        }
        const key = Array.from(subscribers.keys()).find(k => subscribers.get(k)?.url === url);
        if (key && subscribers.delete(key)) {
            file.saveSubscribers(subscribers);
            res.json({ message: 'Подписка удалена' });
            return;
        }
        res.status(404).json({ error: 'Подписчик не найден' });
    });
    const emit = async (tag, payload) => {
        purgeExpired();
        const valid = Array.from(subscribers.values()).filter(s => s.tag === tag);
        await Promise.all(valid.map(s => axios_1.default.post(s.url, payload).catch(() => console.error("emit fail:", s.url))));
    };
    app.post('/webHook_notify', checkAuth, async (req, res) => {
        await emit(req.body.tag, req.body.payload);
        res.json({ message: 'Webhook отправлен активным подписчикам' });
    });
    app.get('/webHook_client_subscriptions', checkAuth, (req, res) => {
        purgeExpired();
        const addr = clientAddr(req);
        res.json(Array.from(subscribers.values()).filter(s => s.url.startsWith(addr)));
    });
    app.get('/webHook_all_tags', checkAuth, (_req, res) => {
        purgeExpired();
        res.json({ tags: [...new Set(Array.from(subscribers.values()).map(s => s.tag))] });
    });
    const appServerReady = new Promise(r => { if (!params.app)
        app.listen(port, () => r());
    else
        r(); });
    return { emit, appServerReady };
};
exports.createWebhookServer = createWebhookServer;
const createWebhookClient = (options) => {
    const { app: app_, serverUrl, clientPort, authToken, autoRenew = false, renewIntervalMs = 86400000 } = options;
    const app = app_ ?? (0, express_1.default)();
    if (!app_)
        app.use(express_1.default.json());
    const activeTags = new Set();
    const timers = new Map();
    const handlers = new Map();
    const registeredPaths = new Set();
    const headers = { authorization: authToken };
    const makeUrl = (tag) => `:${clientPort}/webHook_${tag}`;
    const connect = async (tag, handler) => {
        if (activeTags.has(tag)) {
            console.warn(`Тег ${tag} уже подписан`);
            return;
        }
        const path = `/webHook_${tag}`;
        handlers.set(tag, handler);
        if (!registeredPaths.has(path)) {
            registeredPaths.add(path);
            app.post(path, (req, res) => {
                const h = handlers.get(tag);
                if (!h) {
                    res.status(404).end();
                    return;
                }
                h(req.body);
                res.end();
            });
        }
        await axios_1.default.post(`${serverUrl}/webHook_subscribe`, { url: makeUrl(tag), tag }, { headers });
        activeTags.add(tag);
        if (autoRenew) {
            timers.set(tag, setInterval(() => {
                axios_1.default.get(`${serverUrl}/webHook_status`, { params: { url: makeUrl(tag) }, headers }).catch(() => console.error("renew fail:", tag));
            }, renewIntervalMs));
        }
    };
    const status = async (tag) => axios_1.default.get(`${serverUrl}/webHook_status`, { params: { url: makeUrl(tag) }, headers });
    const unsubscribe = async (...tags) => {
        const arr = tags.length ? tags : [...activeTags];
        await Promise.all(arr.map(async (tag) => {
            await axios_1.default.delete(`${serverUrl}/webHook_unsubscribe`, { data: { url: makeUrl(tag) }, headers }).catch(e => console.error("unsub fail:", tag, e.message));
            activeTags.delete(tag);
            const t = timers.get(tag);
            if (t) {
                clearInterval(t);
                timers.delete(tag);
            }
            handlers.delete(tag);
        }));
    };
    const getMySubscriptions = async () => (await axios_1.default.get(`${serverUrl}/webHook_client_subscriptions`, { headers })).data;
    const getAvailableTags = async () => (await axios_1.default.get(`${serverUrl}/webHook_all_tags`, { headers })).data.tags;
    const tags = () => [...activeTags];
    const Provider = async (tag, payload) => {
        await axios_1.default.post(`${serverUrl}/webHook_notify`, { tag, payload }, { headers });
    };
    const appServerReady = new Promise(r => { if (!app_)
        app.listen(clientPort, () => r());
    else
        r(); });
    return { connect, unsubscribe, status, tags, getMySubscriptions, getAvailableTags, Provider, appServerReady };
};
exports.createWebhookClient = createWebhookClient;
