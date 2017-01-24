import fs = require("fs")
import path = require("path")
import crypto = require("crypto")
import tools = require("./tools")
import * as child_process from "child_process";
import * as bluebird from "bluebird";
import express = require('express');
import winston = require('winston');

export interface Config {
    jwtSecret: string;
    justDir?: boolean;
    repoPath?: string;
}

let repoPath = ""
let justDir = false

// maps directory name to its listing
let apiLockAsync = tools.promiseQueue()
let rootIdTime: number = 0
let rootId = ""

//let cachePath = "cache/"

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

export function createBinFileAsync(dir: string, basename: string, ext: string, buf: Buffer, msg: string) {
    let p = repoPath + dir + "/"
    tools.mkdirP(p)
    let ents = fs.readdirSync(p)
    for (let bn of ents) {
        let st = fs.statSync(p + bn)
        if (st.size == buf.length) {
            let buf0 = fs.readFileSync(p + bn)
            if (buf0.equals(buf)) {
                return Promise.resolve(dir + "/" + bn)
            }
        }
    }

    let fn = basename + ext
    if (ents.indexOf(fn) >= 0) {
        let no = 1
        while (ents.indexOf(basename + "-" + no + ext) >= 0)
            no++
        fn = basename + "-" + no + ext
    }

    // write it, so we get a lock on the name
    fs.writeFileSync(repoPath + fn, buf)

    // this will write the file again
    return setBinFileAsync(dir + "/" + fn, buf, "")
        .then(() => fn)
}

// TODO add some in-memory cache for small files?
export function getFileAsync(name: string, ref = "master"): Promise<Buffer> {
    if (justDir)
        return readAsync(repoPath + name)
    return refreshAsync(120)
        .then(() => getGitObjectAsync(ref + ":" + name))
        .then(obj => {
            if (obj.type == "blob") {
                return obj.data
            } else {
                throw new Error("not found")
            }
        })
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

function getHeadRevAsync() {
    if (justDir)
        return Promise.resolve()
    return Promise.resolve()
        .then(() => runGitAsync(["rev-parse", "HEAD"]))
        .then(buf => {
            rootId = buf.trim()
            rootIdTime = Date.now()
            winston.debug(`HEAD now at ${rootId}`)
        })
}

function pullAsync() {
    if (justDir)
        return Promise.resolve()
    return Promise.resolve()
        .then(() => runGitAsync(["pull", "--strategy=recursive", "--strategy-option=ours", "--no-edit", "--quiet"]))
        .then(getHeadRevAsync)
}

export function refreshAsync(timeoutSeconds = 5) {
    if (justDir)
        return Promise.resolve()
    return apiLockAsync("commit", () => {
        if (Date.now() - rootIdTime >= timeoutSeconds * 1000)
            return pullAsync()
        else
            return Promise.resolve()
    })
}

export function getTextFileAsync(name: string, ref = "master"): bluebird.Thenable<string> {
    let m = /^\/?gw\/(.*)/.exec(name)
    if (m)
        // the expander hits this
        return readAsync("gw/" + m[1])
            .then(b => b.toString("utf8"))
    else
        return getFileAsync(name, ref)
            .then(buf => buf.toString("utf8"))
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
    winston.debug("[gc] git cat-file")
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
        winston.debug("[run] git cat-file --batch")
        gitCatFile = child_process.spawn("git", ["cat-file", "--batch"], {
            cwd: repoPath,
            env: process.env,
            stdio: "pipe",
            shell: false
        })
        gitCatFile.stderr.setEncoding("utf8")
        gitCatFile.stderr.on('data', (msg: string) => {
            winston.error("[git cat-file error] " + msg)
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
                if (m) currEntry.files.push(m[1])
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
    if (/[\r\n]/.test(id))
        throw new Error("bad id: " + id)
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
        winston.debug(`[cat-file] ${id} -> ${obj.id} ${obj.type} ${obj.data.length}`)
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
    winston.debug("[run] " + info)
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
                winston.info(Buffer.concat(errbufs).toString("utf8").trim())
            if (code != 0) {
                reject(new Error("Exit code: " + code + " from " + info))
            }
            resolve(Buffer.concat(outbufs).toString("utf8"))
        });
    })
}

export function logAsync(path = ".") {
    return apiLockAsync("log", () =>
        runGitAsync(["log", "--name-status", "--pretty=fuller", "--max-count=200", path])
            .then(buf => parseLog(buf)))
}

export function setBinFileAsync(name: string, val: Buffer, msg: string) {
    return apiLockAsync("commit", () => {
        winston.info(`write file ${name} ${val.length} bytes; msg: ${msg}`)
        let spl = splitName(name)
        tools.mkdirP(repoPath + spl.parent)
        fs.writeFileSync(repoPath + name, val)

        if (justDir)
            return Promise.resolve()

        return Promise.resolve()
            .then(() => runGitAsync(["add", name]))
            .then(() => runGitAsync(["commit", "-m", msg]))
            .then(() => runGitAsync(["push", "--quiet"]).then(
                () => { },
                // if we get an error from push, trying pulling first
                e =>
                    pullAsync()
                        .then(() => runGitAsync(["push"]))))
            .then(getHeadRevAsync)
    })
}

function statusCleanAsync() {
    return runGitAsync(["status", "--porcelain", "--untracked-files"])
        .then(outp => {
            if (outp.trim()) {
                winston.error(`git status output:\n${outp}`)
                throw new Error("git not clean")
            }
        })
}

export function initAsync(cfg: Config) {
    config = cfg
    repoPath = cfg.repoPath.replace(/\/$/, "") + "/"
    justDir = !!cfg.justDir

    if (justDir)
        return Promise.resolve()

    return statusCleanAsync()
        .then(pullAsync)
}
