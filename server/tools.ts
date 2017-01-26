import * as zlib from 'zlib';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as events from 'events';
import * as querystring from 'querystring';
import * as bluebird from 'bluebird';
import * as crypto from "crypto";
import express = require('express');

export function readResAsync(g: events.EventEmitter) {
    return new Promise<Buffer>((resolve, reject) => {
        let bufs: Buffer[] = []
        g.on('data', (c: any) => {
            if (typeof c === "string")
                bufs.push(new Buffer(c, "utf8"))
            else
                bufs.push(c)
        });

        g.on("error", (err: any) => reject(err))

        g.on('end', () => resolve(Buffer.concat(bufs)))
    })
}

export interface HttpRequestOptions {
    url: string;
    method?: string; // default to GET
    data?: any;
    headers?: SMap<string>;
    query?: SMap<string>;
    allowHttpErrors?: boolean; // don't treat non-200 responses as errors
}

export interface HttpResponse {
    statusCode: number;
    headers: SMap<string>;
    buffer?: Buffer;
    text?: string;
    json?: any;
}

export function requestAsync(options: HttpRequestOptions): Promise<HttpResponse> {
    if (options.query) {
        let q = querystring.stringify(options.query)
        if (options.url.indexOf("?") >= 0)
            options.url += "&" + q
        else
            options.url += "?" + q
    }
    return httpRequestCoreAsync(options)
        .then(resp => {
            if (resp.statusCode != 200 && !options.allowHttpErrors) {
                let msg = `Bad HTTP status code: ${resp.statusCode} at ${options.url}; message: ${(resp.text || "").slice(0, 500)}`
                let err: any = new Error(msg)
                err.statusCode = resp.statusCode
                return Promise.reject(err)
            }
            if (resp.text && /application\/json/.test(resp.headers["content-type"]))
                resp.json = JSON.parse(resp.text)
            return resp
        })
}

function httpRequestCoreAsync(options: HttpRequestOptions): Promise<HttpResponse> {
    let isHttps = false

    let u = <http.RequestOptions><any>url.parse(options.url)

    if (u.protocol == "https:") isHttps = true
    else if (u.protocol == "http:") isHttps = false
    else return Promise.reject("bad protocol: " + u.protocol)

    u.headers = options.headers ? JSON.parse(JSON.stringify(options.headers)) : {}
    let data = options.data
    u.method = options.method || (data == null ? "GET" : "POST");

    let mod: any = isHttps ? https : http;

    let buf: Buffer = null;

    u.headers["accept-encoding"] = "gzip"

    if (data != null) {
        if (Buffer.isBuffer(data)) {
            buf = data;
        } else if (typeof data == "object") {
            buf = new Buffer(JSON.stringify(data), "utf8")
            u.headers["content-type"] = "application/json; charset=utf8"
        } else if (typeof data == "string") {
            buf = new Buffer(data, "utf8")
        } else {
            throw new Error("bad data");
        }
    }

    if (buf)
        u.headers['content-length'] = buf.length

    return new Promise<HttpResponse>((resolve, reject) => {
        let req = mod.request(u, (res: any) => {
            let g: events.EventEmitter = res;
            if (/gzip/.test(res.headers['content-encoding'])) {
                let tmp = zlib.createUnzip();
                res.pipe(tmp);
                g = tmp;
            }

            resolve(readResAsync(g).then(buf => {
                let text: string = null
                try {
                    text = buf.toString("utf8")
                } catch (e) {
                }
                let resp: HttpResponse = {
                    statusCode: res.statusCode,
                    headers: res.headers,
                    buffer: buf,
                    text: text
                }
                return resp;
            }))
        })
        req.on('error', (err: any) => reject(err))
        req.end(buf)
    })
}

export function mkdirP(thePath: string) {
    if (thePath == ".") return;
    if (!fs.existsSync(thePath)) {
        mkdirP(path.dirname(thePath))
        fs.mkdirSync(thePath)
    }
}

interface QEntry {
    run: () => Promise<any>;
    resolve: (v: any) => void;
    reject: (err: any) => void;
}

export function promiseQueue() {
    let awaiting: SMap<QEntry[]> = {}

    function poke(id: string) {
        let lst = awaiting[id]
        if (!lst) return
        let ent = lst[0]
        let shift = () => {
            lst.shift()
            if (lst.length == 0) delete awaiting[id]
            else Promise.resolve().then(() => poke(id))
        }
        ent.run().then(v => {
            shift()
            ent.resolve(v)
        }, e => {
            shift()
            ent.reject(e)
        })
    }

    function enq<T>(id: string, run: () => Promise<T>): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            let lst = awaiting[id]
            if (!lst) lst = awaiting[id] = []
            lst.push({ resolve, reject, run })
            if (lst.length == 1) poke(id)
        })
    }
    return enq
}

export function lookup<T>(m: SMap<T>, key: string): T {
    if (m.hasOwnProperty(key))
        return m[key]
    return null
}

export class PromiseBuffer<T> {
    private waiting: ((v: (T | Error)) => void)[] = [];
    private available: (T | Error)[] = [];

    drain() {
        for (let f of this.waiting) {
            f(new Error("Promise Buffer Reset"))
        }
        this.waiting = []
        this.available = []
    }


    pushError(v: Error) {
        this.push(v as any)
    }

    push(v: T) {
        let f = this.waiting.shift()
        if (f) f(v)
        else this.available.push(v)
    }

    shiftAsync() {
        if (this.available.length > 0) {
            let v = this.available.shift()
            if (v instanceof Error)
                return Promise.reject<T>(v)
            else
                return Promise.resolve<T>(v)
        } else
            return new Promise<T>((resolve, reject) => {
                let f = (v: (T | Error)) => {
                    if (v instanceof Error) reject(v)
                    else resolve(v)
                }
                this.waiting.push(f)
            })
    }
}

export function formatDate(d: Date) {
    function t(n: number) {
        return ("0" + n).slice(-2)
    }
    return d.getFullYear() + "-" + t(d.getMonth() + 1) + "-" + t(d.getDate())
}

/** Generate a random id consisting of upper and lower case letters */
export function createRandomId(size: number): string {
    let buf = crypto.randomBytes(size * 2)
    let s = buf.toString("base64").replace(/[^a-zA-Z]/g, "");
    if (s.length < size) {
        // this is very unlikely
        return createRandomId(size);
    }
    else {
        return s.substr(0, size);
    }
}

export function sha256(d: string | Buffer) {
    let h = crypto.createHash("sha256")
    h.update(d)
    return h.digest("hex").toLowerCase()
}

export function copyFields(trg: any, src: any) {
    for (let k of Object.keys(src))
        trg[k] = src[k];
}

export function values<T>(v: SMap<T>): T[] {
    let r: T[] = []
    for (let k of Object.keys(v)) {
        r.push(v[k])
    }
    return r
}

export function strcmp(a: string, b: string) {
    if (a == b) return 0;
    if (a < b) return -1;
    return 1;
}

export function checkError(err: Error) {
    if (err) {
        var newOne = new Error(err.message)
        var inner = (<any>err).innerExn || err;
        (<any>newOne).innerExn = inner;
        throw newOne;
    }
}

export function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v))
}

export function max(n: number[]) {
    let m = n[0] || 0
    for (let i = 1; i < n.length; ++i)
        if (n[i] > m) m = n[i]
    return m
}

export function min(n: number[]) {
    let m = n[0] || 0
    for (let i = 1; i < n.length; ++i)
        if (n[i] < m) m = n[i]
    return m
}

export function forEachFile(
    dir: string, validPostfix: string, invalidPostfix: string,
    action: (file: string) => void
) {
    fs.readdirSync(dir).forEach(d => {
        if (d.indexOf(validPostfix) == -1)
            return
        if (invalidPostfix && invalidPostfix.length && d.indexOf(invalidPostfix) != -1)
            return
        action(d)
    })
}

export function throwError(code: number) {
    var e = new Error("Error: " + code);
    (<any>e).statusCode = code
    throw e
}

export function etagMatches(req: express.Request, etag: string) {
    let response: express.Response = req._response
    if (!etag) return false
    if (etag[0] != "\"") etag = "\"" + etag + "\""
    if (req.header("if-none-match") == etag) {
        response.status(304)
        response.end()
        return true
    } else {
        response.setHeader("ETag", etag)
        return false
    }
}

export function allowReqCache(req: express.Request) {
    let response: express.Response = req._response
    response.setHeader("Cache-Control", "public, max-age=604800")
}
