import {saveCommentById, tUser} from "./common/saveLoad";
import {tServerRegru} from "./common/regru";
import {getPm2Info} from "./common/pm2";
import {getServerAdmin} from "./facade/facade4";
import {
    funcListenCallback, toError, PromiseResult, UseListen, listenSocket, listenSocketFirst, DeepDataOnly,
    ArrayElementType
} from "wenay-common2";
import {getLogsBy} from "./utils/getLogsBy";
import {typeLogs} from "./facade/type";

const userRoles = {
    guest: 5,
    user: 10,
    superUser: 20,
    admin: 50
};

export type typeUser = keyof typeof userRoles;

/** Проверка, хватает ли роли пользователя для заданных ролей */
function checkUserRole(userRole: number, roles: typeUser[]) {
    return userRole >= Math.max(...roles.map((r) => userRoles[r]));
}

/** Собираем всех вложенных пользователей (рекурсия) */
function getAllNestedUsers(data: ReturnType<typeof getServerAdmin>["data"], id: string | number) {
    return data.users[id]?.users.flatMap((u) => getAllNestedUsers(data, u)).concat(id) ?? [];
}

/** Проверка, есть ли у пользователя доступ к серверу */
function checkServerExist(
    data: ReturnType<typeof getServerAdmin>["data"],
    isAdmin: boolean,
    userId: string | number,
    serverId: string | number
) {
    if (isAdmin) return true;
    const sId = serverId.toString();
    function deepCheck(u: tUser) {
        if (u.servers.includes(sId)) return true;
        for (const sub of u.users) {
            if (data.users[sub] && deepCheck(data.users[sub])) return true;
        }
        return false;
    }
    const r= data.users[userId] ? deepCheck(data.users[userId]) : false;
    return r
}


type ty<T extends (...a: any) => any> = Omit<Parameters<T>[0], "userId">
/** Основной фасад */
export function getFacadeServerAdmin(
    api: ReturnType<typeof getServerAdmin> & { save: (a: { k: any; v: any }[]) => Promise<void> | void },
    listenStop: ReturnType<typeof UseListen<void>>[1],
    isAdmin_: boolean,
    username_: string
) {
    const isAdmin = isAdmin_;
    const userId = isAdmin ? "" : username_;
    const userRole = isAdmin ? Number.MAX_VALUE : userRoles[api.data.users[userId]?.role ?? "guest"];
    const checkExist = (id: string | number) => checkServerExist(api.data, isAdmin, userId, id);

    const [log, logSession] = UseListen<[typeLogs]>()
    const logSystem = getLogsBy({base: () => ({txt: "", time: new Date(), id: 'system', type1: userId, var: 5}), log})
    const logError = getLogsBy({base: () => ({txt: "", time: new Date(), id: 'error', type1: userId, var: 13}), log})
    console.log(api.data);
    console.log(api.data.users[userId])
    type Parameters2<T extends (args: any) => any> = T extends (args: infer P) => any ?
        P extends { id: string } ? P : { error: 'Parameter must have id: string' }
        : { error: 'Not a function with arguments' };
    // type tg<T>
    const id = <T extends (a: Parameters2<T>) => any>(func: T) => {
        return async (a: Parameters2<T>) => {
            if (!isAdmin_ && (a && !checkExist(a["id"]))) {
                throw "null"
            }
            const f = async () => (func(a) as PromiseResult<ReturnType<T>>)
            logSystem(`start name ${func.name} params ${JSON.stringify(a)} id ${id}`)
            logSystem(`${id}`)
            const t = await f()
                .catch(e => {
                    logError(`err ${JSON.stringify(e)} name ${func.name} params ${JSON.stringify(a)} id ${id}`)
                    console.log(`err ${JSON.stringify(e)} name ${func.name} params ${JSON.stringify(a)} id ${id}`)
                    toError.convert = e
                    throw e
                })
            logSystem(`final name ${func.name} params ${JSON.stringify(a)} id ${id}`)
            return t
        }
    }

    /** Проверка роли */
    const role = (...r: typeUser[]) => (checkUserRole(userRole, r) ? true : null);
    /** Обёртка для сокетов, чтобы фильтровать данные по доступности серверов */
    function connect<T extends any[]>(original: ReturnType<typeof funcListenCallback<T>>) {
        const res = listenSocket<T>(original, { addListenClose: listenStop });
        if (isAdmin) return res;

        const on = (fn: Parameters<typeof res.on>[0]) => {
            res.off()
            return res.on((...z) => {
                const sid = z[0]?.id;
                if (sid && !checkExist(sid)) return;
                fn(...z);
            })
        }
        return {
            on,
            off: res.off,
            callback: on,
            removeCallback: res.off
        };
    }
    const commentsMy = saveCommentById(userId);
    // Подписка на параметры
    const [params, paramsListen] = UseListen<[Parameters<Parameters<typeof api.server.params.listen.addListen>[0]>[0]]>();
    // addListen на ГЛОБАЛЬНЫЙ стрим — без отписки держал бы весь фасад сессии (+ deepClone) в памяти
    // навсегда. Снимаем по дисконнекту сессии (listenStop).
    const offParams = api.server.params.listen.addListen((e) => {
        if (checkExist(e.id)) params(e);
    });
    listenStop.addListen(offParams);

    // Подписка на сервера
    const [callbackServers, getCallbackServers] = UseListen<[tServerRegru[]]>();
    const sc = listenSocketFirst(api.onCallbackServers, { addListenClose: listenStop });
    sc.on((servers) => {
        callbackServers(isAdmin ? servers : servers.filter((s) => checkExist(s.id)));
    });

    const checkUsers = (id: string | number) => getAllNestedUsers(api.data, id);

    return {
        pm2Info: () => getPm2Info(),
        envKeys: api.server.envKeys,
        lastCommit: api.lastCommit,

        loadComments: role("superUser") && api.loadComments,
        loadUser: role("superUser") && api.loadUser,

        Export: role("user") && id(api.server.strategy.Export),
        Import: role("user") && id(api.server.strategy.Import),
        control: role("user") && id(api.server.control),

        Logs: role("user") && {
            lastLogsError: id(api.server.Logs.lastLogsError),
            cleanErrorLogs: id(api.server.Logs.cleanErrorLogs)
        },

        regRu: role("superUser") && {
            clone: id((a: ty<typeof api.regRu.clone>) => api.regRu.clone({ ...a, userId})),
            getList: api.regRu.getList,
            getListAll: api.regRu.getListAll,
            del: id(api.regRu.del),
            restart: id(api.regRu.restart),
            updateStatus: id(api.regRu.updateStatus),
            start: id(api.regRu.start),
            statusInfoById: id(api.regRu.statusInfoById),
            stop: id(api.regRu.stop)
        },

        saveEnv: role("superUser") && api.save,
        saveAllUser: role("admin") && api.saveAllUser,

        comment: {
            comm1: role("user") && id(api.server.comment.comm1),
            comm2: role("user") && id(api.server.comment.comm2),
            // commPrivate: role("user") && id((e: Omit<Parameters<typeof api.server.comment.commPrivate>[0],"userId">) =>api.server.comment.commPrivate({...e, userId})),
            uni: role("superUser") && id(api.server.comment.uni)
        },
        commentsMy,
        rebate: {
            rebate: role("user") && id(api.server.rebate),
        },

        sshServer: role("user") && {
            getStatusPm2: role("admin") && api.sshServer.getStatusPm2,
            testCmd: role("admin") && api.sshServer.testCmd,
            scr: {
                ...api.sshServer.scr,
                startTester: role("superUser") && api.sshServer.scr.startTester,
                stopTester: role("superUser") && api.sshServer.scr.stopTester,
                stopAndRunPM2Tester: role("superUser") && api.sshServer.scr.stopAndRunPM2Tester
            }
        },
        command: role("admin") && api.sshServer.command,

        strategiesRefresh: id(api.server.strategy.strategiesRefresh),
        strategies: id(api.server.strategy.strategies),
        strategyParams: id(api.server.strategy.params),
        strategyParamsRun: id(api.server.strategy.paramsRun),

        services: {
            server: role("superUser") && {
                announce: api.announceServer
            },
            servicesBase: api.services.servicesBase,
            balance: {
                all: id(api.services.balance.all),
                totalData: id(api.services.balance.totalData),
                clean: id(api.services.balance.clean),
                loadNames: id(api.services.balance.loadNamesFiles)
            },
            Export: id(api.services.Export),
            ExportDef: id(api.services.ExportDef),
            Import: id(api.services.Import),
            names: id(api.services.names),
            run: id(api.services.run),
            stop: id(api.services.stop),
            getParamsDefault: id(api.services.servicesDef),
            servicesBase2: new Proxy({}, {
                get: (_, p: string) => {
                    if (!isAdmin && !checkExist(p)) throw "No Access";
                    return api.lanaData[p].services;
                }
            })
        },

        lanaData: new Proxy({}, {
            get: (_, p: string) => {
                if (!isAdmin && !checkExist(p)) throw "No Access";
                return api.lanaData()[p];
            }
        }) as ReturnType<typeof api.lanaData>,

        getSummBalances: id(api.server.getSummBalances),
        getRefreshBalances: id(api.server.getRefreshBalances),
        closedOtherBy: role("user") && id(api.server.closedOtherBy),
        updateAdminServer: role("admin") && api.updateAdminServer,
        updateAdminServerRemote: role("admin") && api.updateAdminServerRemote,

        user: {
            roles: () => Object.entries(userRoles).filter(([, val]) => val <= userRole).map(([key]) => key),
            add: role("superUser") && ((a: ty<typeof api.user.add>) => {
                if (userRoles[a.role] >= userRole) throw "No Access";
                return api.user.add({ ...a, userId });
            }),
            edit: role("superUser") && api.user.edit,
            delete: role("superUser") && api.user.delete,
            listUsers: () => {
                if (isAdmin) return api.user.listUsers();
                return Object.fromEntries(
                    checkUsers(userId)
                        .filter((u) => u !== userId)
                        .map((u) => [u, api.data.users[u]?.role ?? "???"])
                );
            }
        },

        userInfo: {
            delServersFromUser: role("superUser") && api.userInfo.delServersFromUser,
            serversToUser: role("superUser") && api.userInfo.serversToUser,
            serversListByUser: (p?: (string | number)[]) => {
                if (!isAdmin && p) return;
                if (isAdmin && !p) return api.userInfo.serversListByUser();
                const arr = p ?? checkUsers(userId);
                const res: { [k: string]: ArrayElementType<ReturnType<typeof api.userInfo.serversListByUser>> } = {};
                arr.filter((u) => u).forEach((u) => {
                    api.userInfo.serversListByUser(String(u)).forEach((s) => {
                        res[s.id] = s;
                    });
                });
                return Object.values(res);
            }
        },

        params: {
            set: id(api.server.params.set),
            get: id(api.server.params.get),
            paramsDefault: id(api.server.params.paramsDefault),
            paramsListen: connect(paramsListen)
        },

        onStatus: connect(api.onStatus),
        onServer: connect(api.server.onServer),
        onServicesParam: connect(api.server.listen.servicesParams.listen),
        onBalances: connect(api.server.listen.balance.listen),
        onStatusEvent: connect(api.server.listen.status.listen),
        onStrategyEvent: connect(api.server.listen.strategyEvent.listen),
        onServerUpdates: connect(getCallbackServers),


        onLog: connect(api.onLog),
        onLogSession: connect(logSession),
    } as const;
}

/** Доп. фасад для сохранения */
export function getFacadeSave(api: ReturnType<typeof getServerAdmin>["keyValue"]) {
    return api;
}

export type FacadeServerAdmin = ReturnType<typeof getFacadeServerAdmin>;
export type FacadeServerSave = ReturnType<typeof getFacadeSave>;
