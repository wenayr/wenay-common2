// ============================================================
//  replay/http-openapi.test.ts
//
//  OpenAPI descriptor for the HTTP facade (demo incubator): the generator
//  reuses the real createHttpFacadeServer walk through a recording app, so
//  every captured (method, route) pair appears in the spec, the document has
//  a valid basic shape, summaries land on their operations, GET documents the
//  one JSON-array "args" query value and POST the {args: [...]} body, bearer
//  security appears only when declared, an argSchemas route documents its POST
//  body as a real 3.1 prefixItems tuple while other routes keep the generic
//  args array — and a live express server proves the documented statuses,
//  envelope, and tuple against actual behavior.
//  Run: npx tsx replay/http-openapi.test.ts
// ============================================================

import express from 'express'
import http from 'node:http'
import type {AddressInfo} from 'node:net'
import {createHttpFacadeServer, type HttpFacadeServerOptions, type tHttpFacadeMethod} from '../src/server/httpFacadeServer'
import {createHttpFacadeOpenApi} from '../demo/http-openapi'

let fails = 0
const ok = (condition: any, message: string) => {
    if (!condition) { fails++; console.log('  FAIL', message) }
    else console.log('  OK  ', message)
}

// The shape mirrors the demo facade: functions at different depths, one object
// walked as both a GET and a POST mirror.
function makeFacadeObject() {
    return {
        demo: {
            status: function status() { return {up: true, at: new Date()} },
            echo: function echo(value: unknown) { return {value} },
        },
        nested: {deep: {ping: function ping() { return 'pong' }}},
    }
}

function requestJson(port: number, method: string, path: string, body?: unknown) {
    return new Promise<{status: number, json: any}>(function executor(resolve, reject) {
        const payload = body == null ? null : JSON.stringify(body)
        const req = http.request({
            host: '127.0.0.1',
            port,
            method,
            path,
            headers: payload == null ? {} : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(payload),
            },
        }, function onResponse(res) {
            const chunks: Buffer[] = []
            res.on('data', chunk => chunks.push(chunk))
            res.on('end', function onEnd() {
                try {
                    resolve({status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString('utf8'))})
                } catch (error) {
                    reject(error)
                }
            })
        })
        req.on('error', reject)
        if (payload != null) req.write(payload)
        req.end()
    })
}

async function main() {
    // ============== the captured walk is the spec's route list ==============
    {
        const object = makeFacadeObject()
        const captured: {method: tHttpFacadeMethod, route: string}[] = []
        const recordingApp = {
            get: function captureGet(route: string) { captured.push({method: 'get', route}) },
            post: function capturePost(route: string) { captured.push({method: 'post', route}) },
        } as unknown as HttpFacadeServerOptions<object>['app']
        createHttpFacadeServer({app: recordingApp, object, method: 'get', basePath: '/api'})
        createHttpFacadeServer({app: recordingApp, object, method: 'post', basePath: '/api'})

        const spec: any = createHttpFacadeOpenApi({
            object,
            basePath: '/api',
            methods: ['get', 'post'],
            info: {title: 'facade under test', version: '1.2.3'},
            bearerAuth: true,
            limits: {maxArgs: 4},
            summaries: {'/api/demo/echo': 'Echo one value'},
            argSchemas: {'/api/demo/echo': [
                {type: 'string', title: 'value'},
                {type: 'object', title: 'options', properties: {loud: {type: 'boolean'}}, required: ['loud']},
            ]},
        }).document()

        ok(spec.openapi == '3.1.0', 'document declares OpenAPI 3.1.0 (prefixItems needs 2020-12)')
        ok(spec.info?.title == 'facade under test' && spec.info?.version == '1.2.3',
            'info carries the deps title and version')
        ok(Object.keys(spec.paths ?? {}).length == 3, 'three routes, three path items')

        const expected = ['/api/demo/status', '/api/demo/echo', '/api/nested/deep/ping']
        ok(captured.length == 6 && expected.every(route =>
            captured.some(pair => pair.method == 'get' && pair.route == route)
            && captured.some(pair => pair.method == 'post' && pair.route == route)),
            'the recording captured every facade function as a GET and a POST route')
        ok(captured.every(pair => spec.paths[pair.route]?.[pair.method] != null),
            'every captured (method, route) pair appears in the spec paths')

        ok(spec.paths['/api/demo/echo'].get.summary == 'Echo one value'
            && spec.paths['/api/demo/echo'].post.summary == 'Echo one value',
            'the annotations-map summary lands on both mirrors of the route')
        ok(spec.paths['/api/demo/status'].get.summary == undefined,
            'a route without an annotation carries no summary')

        const getArgs = spec.paths['/api/demo/echo'].get.parameters?.[0]
        ok(getArgs?.name == 'args' && getArgs?.in == 'query' && getArgs?.required == false
            && getArgs?.schema?.type == 'string',
            'GET documents args as one optional query value holding a JSON array string')

        const postBody = spec.paths['/api/demo/status'].post.requestBody
        const bodyVariants = postBody?.content?.['application/json']?.schema?.oneOf ?? []
        const envelope = bodyVariants.find((variant: any) => variant.type == 'object')
        ok(postBody?.required == true && envelope?.required?.includes('args')
            && envelope?.properties?.args?.type == 'array'
            && envelope?.properties?.args?.maxItems == 4,
            'a route without argSchemas documents the required {args: [...]} body with the maxArgs cap')
        ok(bodyVariants.some((variant: any) => variant.type == 'array'),
            'POST also documents the bare-array body the server accepts')

        // ============== argSchemas: the POST body becomes the real call tuple ==============
        const echoBody = spec.paths['/api/demo/echo'].post.requestBody
        const echoVariants = echoBody?.content?.['application/json']?.schema?.oneOf ?? []
        const echoEnvelope = echoVariants.find((variant: any) => variant.type == 'object')
        const echoTuple = echoEnvelope?.properties?.args
        ok(echoTuple?.prefixItems?.length == 2
            && echoTuple?.prefixItems?.[0]?.title == 'value'
            && echoTuple?.prefixItems?.[1]?.properties?.loud?.type == 'boolean'
            && echoTuple?.minItems == 2 && echoTuple?.maxItems == 2 && echoTuple?.items === false,
            'an argSchemas route documents args as a fixed prefixItems tuple with the field schemas')
        const echoBare = echoVariants.find((variant: any) => variant.type == 'array')
        ok(echoBare?.prefixItems?.[1]?.required?.includes('loud')
            && echoBody?.content?.['application/json']?.example == undefined,
            'the bare-array variant carries the same tuple and the canned example is dropped')
        const statusExample = spec.paths['/api/demo/status'].post.requestBody
            ?.content?.['application/json']?.example
        ok(statusExample?.args?.[0] == 'hello',
            'routes without argSchemas keep the generic example')

        ok(spec.components?.securitySchemes?.bearerAuth?.scheme == 'bearer'
            && spec.security?.[0]?.bearerAuth != null,
            'bearerAuth deps declare the http bearer scheme document-wide')
        ok(spec.paths['/api/demo/echo'].get.responses['401'] != null,
            'a bearer-guarded facade documents 401')
    }

    // ============== no bearer, no security surface ==============
    {
        const spec: any = createHttpFacadeOpenApi({
            object: makeFacadeObject(),
            basePath: '/api',
            methods: ['get'],
            info: {title: 'open facade', version: '0.0.1'},
        }).document()
        ok(spec.security == undefined && spec.components?.securitySchemes == undefined,
            'without bearerAuth the spec declares no security scheme')
        ok(spec.paths['/api/demo/echo'].get.responses['401'] == undefined,
            'without bearerAuth no operation documents 401')
        ok(spec.paths['/api/demo/echo'].post == undefined,
            'a GET-only facade documents no POST mirror')
    }

    // ============== live: the served spec matches served behavior ==============
    {
        const object = makeFacadeObject()
        const app = express()
        const limits = {maxArgs: 4}
        createHttpFacadeServer({app, object, method: 'get', basePath: '/api', limits})
        createHttpFacadeServer({app, object, method: 'post', basePath: '/api',
            middleware: express.json({limit: '16kb'}), limits})
        const openApi = createHttpFacadeOpenApi({
            object,
            basePath: '/api',
            methods: ['get', 'post'],
            info: {title: 'live facade', version: '1.0.0'},
            limits,
            // the tuple documents echo's REAL signature so the live leg can
            // prove the documented body is exactly what the server accepts
            argSchemas: {'/api/demo/echo': [{type: 'string', title: 'value'}]},
        })
        app.get('/openapi.json', function serveOpenApiDocument(_req, res) {
            res.json(openApi.document())
        })

        const server = app.listen(0)
        await new Promise(resolve => server.once('listening', resolve))
        const port = (server.address() as AddressInfo).port
        try {
            const spec = await requestJson(port, 'GET', '/openapi.json')
            ok(spec.status == 200 && spec.json.openapi == '3.1.0',
                'GET /openapi.json serves the generated 3.1.0 document')
            const servedTuple = spec.json.paths?.['/api/demo/echo']?.post?.requestBody
                ?.content?.['application/json']?.schema?.oneOf
                ?.find((variant: any) => variant.type == 'object')?.properties?.args
            ok(servedTuple?.prefixItems?.[0]?.title == 'value' && servedTuple?.items === false,
                'the served document carries the prefixItems tuple for the argSchemas route')
            ok(JSON.stringify(Object.keys(spec.json.paths).sort())
                == JSON.stringify(openApi.routes().map(pair => pair.route)
                    .filter((route, index, all) => all.indexOf(route) == index).sort()),
                'the served paths are exactly the captured routes')

            const echo = await requestJson(port, 'GET',
                `/api/demo/echo?args=${encodeURIComponent('["hi"]')}`)
            ok(echo.status == 200 && echo.json.ok == true && echo.json.value?.value == 'hi',
                'GET parses the documented args query value into arguments')

            const posted = await requestJson(port, 'POST', '/api/demo/echo', {args: ['hi']})
            ok(posted.status == 200 && posted.json.ok == true && posted.json.value?.value == 'hi',
                'POST accepts exactly the body the prefixItems tuple documents')

            const status = await requestJson(port, 'GET', '/api/demo/status')
            ok(status.status == 200 && status.json.value?.up == true
                && typeof status.json.value?.at?.['$_d'] == 'number',
                'the 200 envelope packs rich leaves as documented (Date -> $_d marker)')

            const badJson = await requestJson(port, 'GET', '/api/demo/echo?args=nope')
            ok(badJson.status == 400 && badJson.json.ok == false
                && typeof badJson.json.error?.message == 'string',
                'invalid args JSON answers the documented 400 failure envelope')

            const badBody = await requestJson(port, 'POST', '/api/demo/echo', {value: 'hi'})
            ok(badBody.status == 400 && badBody.json.ok == false,
                'a body without args answers the documented 400')

            const tooMany = await requestJson(port, 'POST', '/api/demo/echo', {args: [1, 2, 3, 4, 5]})
            ok(tooMany.status == 413 && tooMany.json.error?.name == 'PayloadLimitError',
                'args over the documented maxArgs cap answer 413 PayloadLimitError')

            const bareArray = await requestJson(port, 'POST', '/api/demo/echo', ['hi'])
            ok(bareArray.status == 200 && bareArray.json.value?.value == 'hi',
                'POST also accepts the documented bare-array body')

            const deep = await requestJson(port, 'GET', '/api/nested/deep/ping?args=%5B%5D')
            ok(deep.status == 200 && deep.json.value == 'pong',
                'a deep route runs through the same envelope')
        } finally {
            server.close()
        }
    }

    console.log(fails ? `http-openapi: ${fails} FAILED` : 'http-openapi: ALL GREEN')
    process.exit(fails ? 1 : 0)
}
main().catch(e => { console.error(e); process.exit(2) })
