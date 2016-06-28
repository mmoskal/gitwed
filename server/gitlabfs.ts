import fs = require("fs")
import tools = require("./tools")

interface Config {
    gitlabUrl: string;
    gitlabToken: string;
    gitlabProjectId: number;
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

let config: Config = JSON.parse(fs.readFileSync("config.json", "utf8"))

function join(a: string, b: string) {
    return a.replace(/\/+$/, "") + "/" + b.replace(/^\/+/, "")
}

function requestAsync(opts: tools.HttpRequestOptions) {
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

let readAsync = Promise.promisify(fs.readFile)
let writeAsync: (fn: string, v: Buffer | string) => Promise<void> = Promise.promisify(fs.writeFile) as any
let readdirAsync = Promise.promisify(fs.readdir)

function getTreeAsync(fullname: string): Promise<CachedTree> {
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
export function fetchBlobAsync(id: string) {
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
    return apiLockAsync("root/refresh", () => {
        if (Date.now() - rootIdTime >= timeoutSeconds * 1000)
            return refreshRootIdCoreAsync()
        else
            return Promise.resolve()
    })
}

export function initAsync() {
    tools.mkdirP(treeCachePath)
    tools.mkdirP(blobCachePath)

    return readdirAsync(treeCachePath)
        .then(entries =>
            Promise.map(entries.filter(e => /\.json$/.test(e)),
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

export function getTextFileAsync(name: string) {
    return getBlobIdAsync(name)
        .then(fetchBlobAsync)
        .then(b => b.toString("utf8"))
}

export function setTextFileAsync(name: string, val: string) {
    return repoRequestAsync({
        url: "files",
        method: "PUT",
        data: {
            file_path: name,
            branch_name: "master",
            encoding: "text",
            content: val,
            commit_message: "Web update"
        }
    })
    .then(() => refreshAsync(0))
}