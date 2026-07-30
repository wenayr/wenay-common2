import express from 'express';
import type { Express, Request, Response } from 'express';
import axios from 'axios';
import * as fs from 'fs';
import { createAsyncQueue } from "../Common/async/waitRun";

const SUBSCRIBERS_FILE = './subscribers.json';

interface Subscriber {
    url: string;
    tag: string;
    expireAt: Date;
}

interface WebhookClientOptions {
    serverUrl: string;
    clientPort: number;
    authToken: string;
    autoRenew?: boolean;
    renewIntervalMs?: number;
    app?: Express;
}

const loadSubscribers = (): Map<string, Subscriber> => {
    try {
        if (!fs.existsSync(SUBSCRIBERS_FILE)) fs.writeFileSync(SUBSCRIBERS_FILE, '{}', 'utf-8');
        const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8'));
        return new Map(Object.entries(data).map(([k, s]: [string, any]) => [k, { url: s.url, tag: s.tag ?? s.tags, expireAt: new Date(s.expireAt) }]));
    } catch (e) {
        console.error('Ошибка загрузки подписчиков, файл сброшен:', e);
        fs.writeFileSync(SUBSCRIBERS_FILE, '{}', 'utf-8');
        return new Map();
    }
};

const Queue = createAsyncQueue(1);
let _tmpSeq = 0;
const saveSubscribers = (subs: Map<string, Subscriber>) => {
    const obj = Object.fromEntries([...subs].map(([k, s]) => [k, { url: s.url, tag: s.tag, expireAt: s.expireAt }]));
    // atomically: temp+rename — crash mid-write doesn't corrupt subscribers.json
    Queue.enqueue(async () => {
        const tmp = `${SUBSCRIBERS_FILE}.${++_tmpSeq}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
        await fs.promises.rename(tmp, SUBSCRIBERS_FILE);
    });
};

const normalizeIP = (ip: string) => ip?.startsWith('::ffff:') ? ip.slice(7) : ip;

// Safe self-URL: build http://<client-ip><raw> and require the resulting host to match client ip.
// Blocks SSRF like "@evil.com" (host stolen in userinfo); legitimate ":port/path" passes unchanged.
export const buildSelfWebhookUrl = (clientIp: string, raw: unknown): string | null => {
    if (typeof raw !== 'string' || !raw) return null;
    let u: URL;
    try { u = new URL('http://' + clientIp + raw); } catch { return null; }
    return u.hostname === clientIp ? u.toString() : null;
};

export const apiSaveData = { loadSubscribers, saveSubscribers };

type params = {
    authToken: string;
    port: number | string;
    file?: typeof apiSaveData;
    app?: Express;
};

export const createWebhookServer = (params: params) => {
    const app: Express = params.app ?? express();
    if (!params.app) app.use(express.json());
    const file = params.file ?? apiSaveData;
    const { authToken, port } = params;
    const subscribers = file.loadSubscribers();

    const checkAuth = (req: Request, res: Response, next: () => void) => {
        if (req.headers.authorization !== authToken) { res.status(403).json({ error: 'Недействительный токен авторизации' }); return; }
        next();
    };

    const clientAddr = (req: Request) => 'http://' + normalizeIP(req.ip ?? '127.0.0.1');

    const purgeExpired = () => {
        const now = Date.now();
        let changed = false;
        subscribers.forEach((s, k) => { if (s.expireAt.getTime() <= now) { subscribers.delete(k); changed = true; } });
        if (changed) file.saveSubscribers(subscribers);
    };

    const renewExpiry = () => new Date(Date.now() + 3 * 24 * 3600_000);

    app.post('/webHook_subscribe', checkAuth, (req: Request, res: Response) => {
        const { tag } = req.body;
        const url = buildSelfWebhookUrl(normalizeIP(req.ip ?? '127.0.0.1'), req.body.url);
        if (!url || typeof tag !== 'string') { res.status(400).json({ error: 'Неверный запрос' }); return; }
        purgeExpired();
        subscribers.set(url, { url, tag, expireAt: renewExpiry() });
        file.saveSubscribers(subscribers);
        res.json({ message: 'Подписка оформлена' });
    });

    app.get('/webHook_status', checkAuth, (req: Request, res: Response) => {
        const url = buildSelfWebhookUrl(normalizeIP(req.ip ?? '127.0.0.1'), req.query['url']);
        if (!url) { res.status(400).json({ error: 'Неверный запрос' }); return; }
        purgeExpired();
        const subscriber = Array.from(subscribers.values()).find(s => s.url === url);
        if (!subscriber) { res.json({ subscribed: false }); return; }
        subscriber.expireAt = renewExpiry();
        file.saveSubscribers(subscribers);
        res.json({ subscribed: true, expireAt: subscriber.expireAt });
    });

    app.delete('/webHook_unsubscribe', checkAuth, (req: Request, res: Response) => {
        const url = buildSelfWebhookUrl(normalizeIP(req.ip ?? '127.0.0.1'), req.body.url);
        if (!url) { res.status(400).json({ error: 'Неверный запрос' }); return; }
        const key = Array.from(subscribers.keys()).find(k => subscribers.get(k)?.url === url);
        if (key && subscribers.delete(key)) { file.saveSubscribers(subscribers); res.json({ message: 'Подписка удалена' }); return; }
        res.status(404).json({ error: 'Подписчик не найден' });
    });

    const emit = async (tag: string, payload: any) => {
        purgeExpired();
        const valid = Array.from(subscribers.values()).filter(s => s.tag === tag);
        await Promise.all(valid.map(s => axios.post(s.url, payload).catch(() => console.error("emit fail:", s.url))));
    };

    app.post('/webHook_notify', checkAuth, async (req: Request, res: Response) => {
        await emit(req.body.tag, req.body.payload);
        res.json({ message: 'Webhook отправлен активным подписчикам' });
    });

    app.get('/webHook_client_subscriptions', checkAuth, (req: Request, res: Response) => {
        purgeExpired();
        const addr = clientAddr(req);
        res.json(Array.from(subscribers.values()).filter(s => s.url.startsWith(addr)));
    });

    app.get('/webHook_all_tags', checkAuth, (_req: Request, res: Response) => {
        purgeExpired();
        res.json({ tags: [...new Set(Array.from(subscribers.values()).map(s => s.tag))] });
    });

    const appServerReady = new Promise<void>(r => { if (!params.app) app.listen(port, () => r()); else r(); });
    return { emit, appServerReady };
};

export const createWebhookClient = (options: WebhookClientOptions) => {
    const { app: app_, serverUrl, clientPort, authToken, autoRenew = false, renewIntervalMs = 86400000 } = options;
    const app: Express = app_ ?? express();
    if (!app_) app.use(express.json());

    const activeTags = new Set<string>();
    const timers = new Map<string, ReturnType<typeof setInterval>>();
    // One PERMANENT route per path + map tag→handler: Express 5 doesn't allow removing
    // route layers (mutation of app._router.stack removed), repeated app.post accumulated duplicates.
    const handlers = new Map<string, (payload: any) => void>();
    const registeredPaths = new Set<string>();

    const headers = { authorization: authToken };
    const makeUrl = (tag: string) => `:${clientPort}/webHook_${tag}`;

    const connect = async (tag: string, handler: (payload: any) => void) => {
        if (activeTags.has(tag)) { console.warn(`Тег ${tag} уже подписан`); return; }

        const path = `/webHook_${tag}`;
        handlers.set(tag, handler);
        if (!registeredPaths.has(path)) {
            registeredPaths.add(path);
            app.post(path, (req: Request, res: Response) => {
                const h = handlers.get(tag);
                if (!h) { res.status(404).end(); return; } // unsubscribed — route is inert
                h(req.body); res.end();
            });
        }

        await axios.post(`${serverUrl}/webHook_subscribe`, { url: makeUrl(tag), tag }, { headers });
        activeTags.add(tag);

        if (autoRenew) {
            timers.set(tag, setInterval(() => {
                axios.get(`${serverUrl}/webHook_status`, { params: { url: makeUrl(tag) }, headers }).catch(() => console.error("renew fail:", tag));
            }, renewIntervalMs));
        }
    };

    const status = async (tag: string): Promise<axios.AxiosResponse<any, any, {}>> =>
        axios.get(`${serverUrl}/webHook_status`, { params: { url: makeUrl(tag) }, headers });

    const unsubscribe = async (...tags: string[]) => {
        const arr = tags.length ? tags : [...activeTags];
        await Promise.all(arr.map(async tag => {
            await axios.delete(`${serverUrl}/webHook_unsubscribe`, { data: { url: makeUrl(tag) }, headers }).catch(e => console.error("unsub fail:", tag, e.message));
            activeTags.delete(tag);
            // kill the timer
            const t = timers.get(tag); if (t) { clearInterval(t); timers.delete(tag); }
            // route remains, but becomes inert (handlers — single source of truth)
            handlers.delete(tag);
        }));
    };

    const getMySubscriptions = async (): Promise<Subscriber[]> =>
        (await axios.get(`${serverUrl}/webHook_client_subscriptions`, { headers })).data;

    const getAvailableTags = async (): Promise<string[]> =>
        (await axios.get(`${serverUrl}/webHook_all_tags`, { headers })).data.tags;

    const tags = () => [...activeTags];

    const Provider = async (tag: string, payload: any) => {
        await axios.post(`${serverUrl}/webHook_notify`, { tag, payload }, { headers });
    };

    const appServerReady = new Promise<void>(r => { if (!app_) app.listen(clientPort, () => r()); else r(); });
    return { connect, unsubscribe, status, tags, getMySubscriptions, getAvailableTags, Provider, appServerReady };
};
