import * as zlib from 'zlib';
import * as url from 'url';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as events from 'events';
import * as querystring from 'querystring';


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
    buffer?: any;
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

    let mod = isHttps ? https : http;

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
        let req = mod.request(u, res => {
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
