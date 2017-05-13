import express = require('express');
import crypto = require("crypto")
import path = require("path")
import fs = require("fs")
import gitfs = require('./gitfs')
import mail = require('./mail')
import tools = require('./tools')
import routing = require('./routing')
import expander = require('./expander')
import bluebird = require('bluebird')
import winston = require('winston')

export interface EventIndexEntry {
    id: number;
    startTime: string;
    endTime: string;
    title: string;
    location: string;
}

export interface EventBase extends EventIndexEntry {
    description: string;
}

export interface EventIndex {
    events: EventIndexEntry[];
    nextId: number;
}

let index: EventIndex
let currEventsPath = ""
let eventsCache: SMap<string> = {}

const writeAsync: (fn: string, v: Buffer | string) => Promise<void> = bluebird.promisify(fs.writeFile) as any

function forIndex(js: EventBase): EventIndexEntry {
    return {
        id: js.id,
        startTime: js.startTime,
        endTime: js.endTime,
        title: js.title,
        location: js.location
    }
}

function eventFn(id: number) {
    return ("000000" + id).slice(-6) + ".json"
}

// TODO lock?
async function saveEventAsync(e: EventBase, user: string) {
    eventsCache[e.id + ""] = JSON.stringify(e)

    let idx = index.events.findIndex(x => x.id == e.id)
    if (idx < 0) idx = index.events.length
    index.events.splice(idx, 1, forIndex(e))
    await writeAsync(path.join(currEventsPath, "index.json"), JSON.stringify(index, null, 1))

    await gitfs.events.setJsonFileAsync("current/" + eventFn(e.id), e, "Update " + e.title, user)
}

async function readEventAsync(id: number): Promise<EventBase> {
    if (!index.events.some(e => e.id == id))
        return null
    let curr = eventsCache[id + ""]
    if (!curr) {
        let text = await gitfs.events.getTextFileAsync(eventFn(id))
        curr = eventsCache[id + ""] = text
    }
    return JSON.parse(curr)
}

function loadOrCreateIndex() {
    let idx = path.join(currEventsPath, "index.json")
    if (fs.existsSync(idx)) {
        index = readJson("index.json")
        return
    }

    winston.info("creating events index...")
    index = {
        events: [],
        nextId: 0
    }
    for (let fn of fs.readdirSync(currEventsPath)) {
        if (/^\d+\.json$/.test(fn)) {
            let js: EventBase = readJson(fn)
            index.nextId = Math.max(index.nextId, js.id || 0)
            index.events.push(forIndex(js))
        }
    }
    index.nextId++
    fs.writeFileSync(idx, JSON.stringify(index, null, 1))

    function readJson(fn: string) {
        return JSON.parse(fs.readFileSync(path.join(currEventsPath, fn), "utf8"))
    }
}

export function initRoutes(app: express.Express) {
    if (!gitfs.events)
        return
    currEventsPath = path.join(gitfs.config.eventsRepoPath, "current")
    loadOrCreateIndex()

    app.get("/api/events/:id", async (req, res, next) => {
        let id = parseInt(req.params["id"])
        let ev = await readEventAsync(id)
        if (!ev) {
            res.status(404).json({})
            return
        }
        res.json(ev)
    })

    app.get("/api/events", (req, res, next) => {
    })

    app.post("/api/events", (req, res, next) => {
    })

    app.post("/api/events/:id", (req, res, next) => {
    })
}
