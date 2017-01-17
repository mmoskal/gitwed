import fs = require("fs")
import path = require("path")
import crypto = require("crypto")
import tools = require("./tools")
import * as bluebird from "bluebird";

let localRepo = ""

export interface Config {
    gitlabUrl: string;
    gitlabToken: string;
    gitlabProjectId: number;
    jwtSecret: string;
    localRepo?: string;
}

interface TreeEntry {
    id: string; // "c26affb7900320876d9257fae1b1aaa435798346",
    name: string; // file name
    type: string; // "tree", "blob"
    // mode: string; // "040000"
}

interface CachedTree {
    children: TreeEntry[];
    self: TreeEntry;
    fullname: string;
    parent: string;
}

// maps directory name to its listing
let treeCache: SMap<CachedTree> = {}
let apiLockAsync = tools.promiseQueue()
let rootIdTime: number = 0

let cachePath = "cache/"
let treeCachePath = cachePath + "tree/"
let blobCachePath = cachePath + "blobs/"

export let config: Config

function join(a: string, b: string) {
    return a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "")
}

function requestAsync(opts: tools.HttpRequestOptions) {
    if (localRepo)
        throw new Error("shouldn't be here")
    if (!opts.headers) opts.headers = {}
    opts.headers["PRIVATE-TOKEN"] = config.gitlabToken
    console.log("GitLab", opts.url, JSON.stringify(opts.query || {}))
    if (!/^https?:/.test(opts.url)) {
        opts.url = join(join(config.gitlabUrl, "api/v3"), opts.url)
    }
    return tools.requestAsync(opts)
}

function repoRequestAsync(opts: tools.HttpRequestOptions) {
    opts.url = join("/projects/" + config.gitlabProjectId + "/repository", opts.url)
    return requestAsync(opts)
}

let readAsync: (fn: string) => Promise<Buffer> = bluebird.promisify(fs.readFile) as any
let writeAsync: (fn: string, v: Buffer | string) => Promise<void> = bluebird.promisify(fs.writeFile) as any
let readdirAsync = bluebird.promisify(fs.readdir)

export function githash(buf: Buffer) {
    let h = crypto.createHash("sha1")
    h.update("blob " + buf.length + "\u0000")
    h.update(buf)
    return h.digest("hex")
}

export function getTreeAsync(fullname: string): Promise<CachedTree> {
    if (localRepo) {
        let p = localRepo + fullname
        if (!fs.existsSync(p))
            return Promise.resolve(null)
        let ents = fs.readdirSync(p)
        // this is only for duplicate-image detection
        let r: CachedTree = {
            children: ents.map(fn => ({
                id: githash(fs.readFileSync(p + "/" + fn)),
                name: fn,
                type: "blob"
            })),
            self: null,
            fullname,
            parent: null,
        }
        return Promise.resolve(r)
    }

    return apiLockAsync("tree/" + fullname, () => {
        if (fullname == "/") {
            let e = getEntry("/")
            return refreshAsync(120)
                .then(() => fetchChildrenAsync(e))
        } else {
            let spl = splitName(fullname)
            //console.log(`split(${fullname}) = {${spl.parent},${spl.name}}`)            

            return getTreeAsync(spl.parent)
                .then(par => {
                    if (!par) return null
                    let us = par.children.filter(c => c.name == spl.name)[0]
                    if (!us || us.type != "tree") return null
                    let e = getEntry(fullname)
                    if (us.id != e.self.id) {
                        e.self.id = us.id
                        e.children = null
                    }
                    return fetchChildrenAsync(e)
                })
        }
    })

    function fetchChildrenAsync(e: CachedTree) {
        if (e.children) return Promise.resolve(e)
        let rootId = getEntry("/").self.id
        return repoRequestAsync({
            url: "tree",
            query: {
                path: e.fullname.replace(/^\/*/, ""),
                ref_name: rootId
            }
        })
            .then(r => {
                e.children = r.json
                return saveEntryAsync(e)
            })
            .then(() => e)
    }

    function saveEntryAsync(e: CachedTree) {
        let fn = treeCachePath + e.fullname.replace(/\//g, "_-_") + ".json"
        return writeAsync(fn, JSON.stringify(e, null, 1))
    }
}

export function getBlobIdAsync(fullname: string) {
    if (localRepo) {
        if (fs.existsSync(localRepo + fullname))
            return Promise.resolve(fullname)
        else
            return Promise.resolve(null)
    }
    let spl = splitName(fullname)
    return getTreeAsync(spl.parent)
        .then(tree => {
            if (!tree) return null
            let e = tree.children.filter(x => x.name == spl.name)[0]
            if (e && e.type == "blob") return e.id
            else return null
        })
}

// TODO add some in-memory cache for small files?
export function fetchBlobAsync(id: string): Promise<Buffer> {
    if (localRepo)
        return readAsync(localRepo + id)
    let fn = blobCachePath + id
    return apiLockAsync("blob/" + id, () => readAsync(fn)
        .then(buf => buf, err =>
            repoRequestAsync({ url: "raw_blobs/" + id })
                .then(r => {
                    return writeAsync(fn, r.buffer)
                        .then(() => r.buffer)
                })))
}

export function splitName(fullname: string) {
    let m = /(.*)\/([^\/]+)/.exec(fullname)
    let parent: string = null
    let name = ""
    if (!m) {
        if (fullname == "/") { }
        else if (fullname.indexOf("/") == -1) {
            parent = "/"
            name = fullname
        } else {
            throw new Error("bad name")
        }
    } else {
        parent = m[1] || "/"
        name = m[2]
    }
    return { parent, name }
}

function getEntry(fullname: string) {
    let entry = tools.lookup(treeCache, fullname)
    if (entry) return entry

    let spl = splitName(fullname)

    entry = {
        children: null,
        self: {
            name: spl.name,
            id: "bogus",
            type: "tree"
        },
        parent: spl.parent,
        fullname: fullname,
    }
    treeCache[fullname] = entry

    return entry
}

function refreshRootIdCoreAsync() {
    return repoRequestAsync({ url: "branches/master" })
        .then(r => {
            let rootEntry = getEntry("/")
            let rootId: string = r.json.commit.id
            rootIdTime = Date.now()
            if (rootEntry.self.id != rootId) {
                rootEntry.self.id = rootId
                rootEntry.children = null
            }
        })
}

export function refreshAsync(timeoutSeconds = 5) {
    if (localRepo) return Promise.resolve()
    return apiLockAsync("root/refresh", () => {
        if (Date.now() - rootIdTime >= timeoutSeconds * 1000)
            return refreshRootIdCoreAsync()
        else
            return Promise.resolve()
    })
}

export function initAsync(cfg: Config) {
    config = cfg

    if (cfg.localRepo) {
        treeCache = null
        localRepo = cfg.localRepo.replace(/\/$/, "") + "/"
        return bluebird.resolve()
    }

    tools.mkdirP(treeCachePath)
    tools.mkdirP(blobCachePath)

    return readdirAsync(treeCachePath)
        .then(entries =>
            bluebird.map(entries.filter(e => /\.json$/.test(e)),
                fn => readAsync(treeCachePath + fn)
                    .then(buf => {
                        let e: CachedTree = JSON.parse(buf.toString("utf8"))
                        treeCache[e.fullname] = e
                    })))
        .then(refreshRootIdCoreAsync)
}

export function existsAsync(name: string) {
    return getBlobIdAsync(name)
        .then(id => !!id)
}

export function getTextFileAsync(name: string): bluebird.Thenable<string> {
    let m = /^\/?gw\/(.*)/.exec(name)
    if (m)
        // the expander hits this
        return readAsync("gw/" + m[1])
            .then(b => b.toString("utf8"))
    else
        return getBlobIdAsync(name)
            .then(id => id ? fetchBlobAsync(id) : Promise.reject<Buffer>(new Error(name + " not found")))
            .then(b => b.toString("utf8"))
}

export function setTextFileAsync(name: string, val: string, msg: string) {
    if (localRepo)
        return setBinFileAsync(name, new Buffer(val, "utf8"), msg)
    return repoRequestAsync({
        url: "files",
        method: "PUT",
        data: {
            file_path: name,
            branch_name: "master",
            // encoding: "text",
            content: val,
            commit_message: msg
        }
    })
        .then(() => refreshAsync(0))
}

export function setBinFileAsync(name: string, val: Buffer, msg: string) {
    if (localRepo) {
        let spl = splitName(name)
        tools.mkdirP(localRepo + spl.parent)
        fs.writeFileSync(localRepo + name, val)
        return Promise.resolve()
    }

    return repoRequestAsync({
        url: "files",
        method: "PUT",
        data: {
            file_path: name,
            branch_name: "master",
            encoding: "base64",
            content: val.toString("base64"),
            commit_message: msg
        }
    })
        .then(() => refreshAsync(0))
}