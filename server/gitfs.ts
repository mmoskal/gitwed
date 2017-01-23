import fs = require("fs")
import path = require("path")
import crypto = require("crypto")
import tools = require("./tools")
import * as child_process from "child_process";
import * as bluebird from "bluebird";

export interface Config {
    jwtSecret: string;
    localRepo?: string;
}

interface CachedTree {
    children: TreeEntry[];
    self: TreeEntry;
    fullname: string;
    parent: string;
}

let repoPath = ""
let justDir = false

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
    if (justDir) {
        let p = repoPath + fullname
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
    if (justDir) {
        if (fs.existsSync(repoPath + fullname))
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
    if (justDir)
        return readAsync(repoPath + id)
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
    if (justDir) return Promise.resolve()
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
        repoPath = cfg.localRepo.replace(/\/$/, "") + "/"
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
    return setBinFileAsync(name, new Buffer(val, "utf8"), msg)
}

let gitCatFile: child_process.ChildProcess
let lastUsage = 0
let gitCatFileBuf = new tools.PromiseBuffer<Buffer>()

function maybeGcGitCatFile() {
    if (!gitCatFile) return
    let d = Date.now() - lastUsage
    if (d < 15000) return
    console.log("[gc] git cat-file")
    gitCatFile.stdin.end()
    gitCatFile = null
    gitCatFileBuf.drain()
}

function startGitCatFile() {
    if (!lastUsage) {
        setInterval(maybeGcGitCatFile, 5000)
    }
    lastUsage = Date.now()
    if (!gitCatFile) {
        console.log("[run] git cat-file --batch")
        gitCatFile = child_process.spawn("git", ["cat-file", "--batch"], {
            cwd: repoPath,
            env: process.env,
            stdio: "pipe",
            shell: false
        })
        gitCatFile.stderr.setEncoding("utf8")
        gitCatFile.stderr.on('data', (msg: string) => {
            console.error("[git cat-file error] " + msg)
        })
        gitCatFile.stdout.on('data', (buf: Buffer) => gitCatFileBuf.push(buf))
    }
}

interface GitObject {
    id: string;
    type: string;
    data: Buffer;
    tree?: TreeEntry[];
    commit?: Commit;
}

interface Commit {
    tree: string;
    parents: string[];
    author: string;
    date: number;
    msg: string;
}

interface TreeEntry {
    mode: string;
    name: string;
    sha: string;
}

export interface LogEntry {
    id: string;
    author: string;
    date: number;
    files: string[];
    msg: string;
}

function parseLog(fulllog: string) {
    let entries: LogEntry[] = []
    let currEntry: LogEntry
    let newEntry = () => {
        if (currEntry) entries.push(currEntry)
        currEntry = {
            id: "",
            author: "",
            date: 0,
            files: [],
            msg: "",
        }
    }
    for (let l of fulllog.split("\n")) {
        let m = /^commit (\S+)/.exec(l)
        if (m) {
            newEntry()
            currEntry.id = m[1]
        } else if (l.slice(0, 4) == "    ") {
            currEntry.msg += l.slice(4) + "\n"
        } else {
            m = /^([A-Za-z]+):\s*(.*)/.exec(l)
            if (m && m[1] == "Author")
                currEntry.author = m[2]
            else if (m && m[1] == "AuthorDate")
                currEntry.date = Math.round(new Date(m[2]).getTime() / 1000)
            else {
                m = /^[A-Z]\t(.*)/.exec(l)
                if (l) currEntry.files.push(m[1])
            }
        }
    }
    newEntry()
    return entries
}

function parseTree(buf: Buffer) {
    let entries: TreeEntry[] = []
    let ptr = 0
    while (ptr < buf.length) {
        let start = ptr
        while (48 <= buf[ptr] && buf[ptr] <= 55)
            ptr++
        if (buf[ptr] != 32)
            throw new Error("bad tree format")
        let mode = buf.slice(start, ptr).toString("utf8")
        ptr++
        start = ptr
        while (buf[ptr])
            ptr++
        if (buf[ptr] != 0)
            throw new Error("bad tree format 2")
        let name = buf.slice(start, ptr).toString("utf8")
        ptr++
        let sha = buf.slice(ptr, ptr + 20).toString("hex")
        ptr += 20
        if (ptr > buf.length)
            throw new Error("bad tree format 3")
        entries.push({ mode, name, sha })
    }
    return entries
}

function parseCommit(buf: Buffer): Commit {
    let cmt = buf.toString("utf8")
    let mtree = /^tree (\S+)/m.exec(cmt)
    let mpar = /^parent (.+)/m.exec(cmt)
    let mauthor = /^author (.+) (\d+) ([+\-]\d{4})$/m.exec(cmt)
    let midx = cmt.indexOf("\n\n")
    return {
        tree: mtree[1],
        parents: mpar[1].split(/\s+/),
        author: mauthor[1],
        date: parseInt(mauthor[2]),
        msg: cmt.slice(midx + 2)
    }
}

function getGitObjectAsync(id: string) {
    if (!/^[0-9a-f]{40}$/.exec(id))
        throw new Error("Invalid ID: " + id)
    return apiLockAsync("cat-file", () => {
        startGitCatFile()
        gitCatFile.stdin.write(id + "\n")
        let sizeLeft = 0
        let bufs: Buffer[] = []
        let res: GitObject = {
            id: id,
            type: "",
            data: null
        }
        let loop = (): Promise<GitObject> =>
            gitCatFileBuf.shiftAsync()
                .then(buf => {
                    startGitCatFile() // make sure the usage counter is updated
                    if (!res.type) {
                        let end = buf.indexOf(10)
                        let line = buf
                        if (end >= 0) {
                            line = buf.slice(0, end)
                            buf = buf.slice(end + 1)
                        } else {
                            throw new Error("bad cat-file respose: " + buf.toString("utf8").slice(0, 100))
                        }
                        let m = /^([0-9a-f]{40}) (\S+) (\d+)/.exec(line.toString("utf8"))
                        res.id = m[1]
                        res.type = m[2]
                        sizeLeft = parseInt(m[3])
                    }
                    if (buf.length > sizeLeft) {
                        buf = buf.slice(0, sizeLeft)
                    }
                    bufs.push(buf)
                    sizeLeft -= buf.length
                    if (sizeLeft <= 0) {
                        res.data = Buffer.concat(bufs)
                        return res
                    } else {
                        return loop()
                    }
                })
        return loop()
    }).then(obj => {
        if (obj.type == "tree") {
            obj.tree = parseTree(obj.data)
        } else if (obj.type == "commit") {
            obj.commit = parseCommit(obj.data)
        }
        return obj
    })
}

function runGitAsync(args: string[]) {
    let info = "git " + args.join(" ")
    console.log("[run] " + info)
    return new Promise<string>((resolve, reject) => {
        let ch = child_process.spawn("git", args, {
            cwd: repoPath,
            env: process.env,
            stdio: "pipe",
            shell: false
        })
        let outbufs: Buffer[] = []
        let errbufs: Buffer[] = []
        ch.stdin.end()
        ch.stderr.on('data', (buf: Buffer) => {
            errbufs.push(buf)
        })
        ch.stdout.on('data', (buf: Buffer) => {
            outbufs.push(buf)
        })
        ch.on('close', (code: number) => {
            if (errbufs.length)
                console.error(Buffer.concat(errbufs).toString("utf8"))
            if (code != 0) {
                reject(new Error("Exit code: " + code + " from " + info))
            }
            resolve(Buffer.concat(outbufs).toString("utf8"))
        });
    })
}

export function logAsync(path = ".") {
    return apiLockAsync("log", () =>
        runGitAsync(["log", "--name-status", "--pretty=fuller", path])
            .then(buf => parseLog(buf)))
}

export function setBinFileAsync(name: string, val: Buffer, msg: string) {
    return apiLockAsync("commit", () => {
        let spl = splitName(name)
        tools.mkdirP(repoPath + spl.parent)
        fs.writeFileSync(repoPath + name, val)

        if (justDir)
            return Promise.resolve()

        return Promise.resolve()
            .then(() => runGitAsync(["add", name]))
            .then(() => runGitAsync(["commit", "-m", msg]))
            .then(() => runGitAsync(["push"]))
            .then(() => {
            })
    })
}