import express = require('express');
import crypto = require("crypto")
import path = require("path")
import fs = require("fs")
import gitfs = require('./gitfs')
import gmaps = require('./gmaps')
import mail = require('./mail')
import tools = require('./tools')
import auth = require('./auth')
import routing = require('./routing')
import expander = require('./expander')
import bluebird = require('bluebird')
import winston = require('winston')

export interface EventIndexEntry {
    id: number;
    startDate: string; // "2016-01-05"
    endDate: string;
    title: string;
    center: string; // "wroclaw"
}

export interface Address {
    name: string;
    address: string; // multi-line
}

// address is optional - can be taken from center
export interface FullEvent extends EventIndexEntry, Address {
    startTime: string; // "20:00"
    description: string;
    isAtCenter?: boolean;
}

export interface EventIndex {
    events: EventIndexEntry[];
    nextId: number;
}

export interface Center extends Address {
    id: string;
    country: string;
    users: string[];
}

let index: EventIndex
let currEventsPath = ""
let eventsCache: SMap<string> = {}

let centers: SMap<Center>

const writeAsync: (fn: string, v: Buffer | string) => Promise<void> = bluebird.promisify(fs.writeFile) as any

function forIndex(js: FullEvent): EventIndexEntry {
    return {
        id: js.id,
        startDate: js.startDate,
        endDate: js.endDate,
        title: js.title,
        center: js.center
    }
}

function eventFn(id: number) {
    return ("000000" + id).slice(-6) + ".json"
}

async function getCentersAsync() {
    if (centers) return centers
    if (centers === undefined)
        gitfs.events.onUpdate(isPull => {
            if (isPull)
                centers = null
        })
    centers = JSON.parse(await gitfs.events.getTextFileAsync("centers.json"))
    return centers
}

// TODO lock?
async function saveEventAsync(e: FullEvent, user: string) {
    eventsCache[e.id + ""] = JSON.stringify(e)

    let idx = index.events.findIndex(x => x.id == e.id)
    if (idx < 0) idx = index.events.length
    index.events.splice(idx, 1, forIndex(e))
    await writeAsync(path.join(currEventsPath, "index.json"), JSON.stringify(index, null, 1))

    await gitfs.events.setJsonFileAsync("current/" + eventFn(e.id), e, "Update " + e.title, user)
}

async function readEventAsync(id: number): Promise<FullEvent> {
    if (!index.events.some(e => e.id == id))
        return null
    let curr = eventsCache[id + ""]
    if (!curr) {
        let text = await gitfs.events.getTextFileAsync("current/" + eventFn(id))
        curr = eventsCache[id + ""] = text
    }
    let r: FullEvent = JSON.parse(curr)
    if (!r.address) {
        let c = await getCenterAsync(r.center)
        r.address = c.address
        r.name = c.name
    }
    return r
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
            let js: FullEvent = readJson(fn)
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

function formatDate(d: Date) {
    return d.toISOString().slice(0, 10)
}

function validDate(d: string) {
    return d == null || d == "" || /^2\d\d\d-\d\d-\d\d$/.test(d)
}

function validTime(d: string) {
    return d == null || d == "" || /^\d\d:\d\d$/.test(d)
}

function applyChanges(curr: FullEvent, delta: FullEvent) {
    if (curr.center && delta.center != curr.center)
        return "cannot change event center"
    if (!validDate(delta.startDate))
        return "invalid start date"
    if (!validDate(delta.endDate))
        return "invalid end date"
    if (!validTime(delta.startTime))
        return "invalid start time"
    if ((delta.title || "").length > 200)
        return "title too long"
    if ((delta.description || "").length > 4000)
        return "description too long"

    for (let k of [
        "center",
        "startDate",
        "endDate",
        "title",
        "description",
        "startTime",
    ]) {
        if (delta.hasOwnProperty(k))
            (curr as any)[k] = (delta as any)[k]
    }
    return ""
}

function publicCenter(c: Center) {
    return {
        id: c.id,
        name: c.name,
        country: c.country,
        address: c.address,
    }
}

async function getCenterAsync(id: string) {
    if (typeof id != "string")
        return null
    let centers = await getCentersAsync()
    return tools.lookup(centers, id)
}


function queryEvents(query: SMap<string>) {
    let startDate = query["start"] || formatDate(new Date(Date.now() - 3 * 24 * 3600 * 1000))
    let stopDate = query["stop"] || "9999-99-99"
    let center = query["center"] || null
    let ev = index.events.filter(e => {
        let end = e.endDate || e.startDate
        if (end < startDate)
            return false
        if (e.startDate > stopDate)
            return false
        if (center && e.center != center)
            return false
        return true
    })
    ev.sort((a, b) =>
        tools.strcmp(a.startDate, b.startDate) || (a.id - b.id))
    let totalCount = ev.length
    let skip = parseInt(query["skip"]) || 0
    if (skip)
        ev = ev.slice(skip)
    let count = Math.abs(parseInt(query["count"]) || 20)
    if (count > 100) count = 100
    if (ev.length > count) ev = ev.slice(0, count)
    return {
        totalCount,
        events: ev,
    }
}

export function initRoutes(app: express.Express) {
    if (!gitfs.events)
        return
    currEventsPath = path.join(gitfs.config.eventsRepoPath, "current")
    loadOrCreateIndex()

    winston.debug("mounting events")

    app.get("/ev/:id/edit", async (req, res, next) => {
        let id = req.params["id"]
        if (req.appuser) res.redirect("/ev/" + id)
        else res.redirect("/gw/login?redirect=/ev/" + id)
    })

    app.get("/ev/:id", async (req, res, next) => {
        let id = parseInt(req.params["id"]) || 0
        let ev = await readEventAsync(id)
        if (!ev) {
            if (req.params["id"] == "new") {
                if (!req.appuser)
                    return res.redirect("/gw/login?redirect=/ev/new")
                let isAdmin = await auth.hasWritePermAsync(req.appuser, [])
                let allCenters = tools.values(await getCentersAsync())
                let centers = allCenters
                    .filter(c => isAdmin || (c.users || []).indexOf(req.appuser) >= 0)
                if (centers.length == 0) {
                    res.status(402)
                    routing.sendError(req, "User not setup",
                        "Your user account is not setup to post in any center.")
                    return
                }
                let c0 = centers[0]
                centers.sort((a, b) => tools.strcmp(a.id, b.id))
                if (req.query["center"]) {
                    c0 = centers.find(c => c.id == req.query["center"])
                    if (!c0)
                        return res.status(402).end("Cannot post here")
                } else if (centers.length > 1) {
                    let pref = req.url
                    if (pref.indexOf("?") >= 0) pref += "&"
                    else pref += "?"
                    let body = centers.map(c =>
                        `<li><a href="${pref + "center=" + c.id}">${c.id}</a>: ${c.name}`)
                    routing.sendMsg(req, "Which center?",
                        "<ul>" + body.join("\n") + "</ul>"
                    )
                    return
                }
                ev = {
                    id: 0,
                    startDate: tools.formatDate(new Date(Date.now() + 14 * 24 * 3600 * 1000)),
                    endDate: "",
                    center: c0.id,
                    name: c0.name,
                    address: c0.address,
                    startTime: "20:00",
                    title: "Introduction to Buddhism by D. W. Teacher",
                    description: "<p>Details coming up soon!</p>",
                }
            } else {
                // 404
                return next()
            }
        }

        if (!tools.reqSetup(req)) return

        let addr = ev.name + ", " + gmaps.cleanAddress(ev.address)

        let gmapURL = await gmaps.getMapsPictureAsync({ address: addr })

        let cfg: expander.ExpansionConfig = {
            rootFile: "/ev/event.html",
            ref: "master",
            langs: req.langs,
            appuser: req.appuser,
            contentOverride: ev as any,
            eventInfo: req.appuser ? ev : null,
            vars: {
                "mapurl": "https://maps.google.com/?q=" + encodeURI(addr),
                "mapimg": gmapURL
            }
        }
        let page = await expander.expandFileAsync(cfg)
        // pageCache.set(cacheKey, page.html)
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf8'
        })
        res.end(page.html)
    })

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
        res.json(queryEvents(req.query))
    })

    app.post("/api/events", async (req, res, next) => {
        if (!req.appuser)
            return res.status(403).end()

        let delta = req.body as FullEvent
        let center = await getCenterAsync(delta.center)

        if (!center)
            return res.status(404).end()

        if (!await auth.hasWritePermAsync(req.appuser, center.users))
            return res.status(402).end()

        let currElt = { id: index.nextId } as FullEvent
        let isFresh = true
        if (typeof delta.id == "number") {
            if (delta.id <= 0) {
                delete delta.id
            } else {
                currElt = await readEventAsync(delta.id)
                if (!currElt)
                    return res.status(444).end()
                isFresh = false
            }
        }

        let err = applyChanges(currElt, delta)
        if (err) {
            res.status(412).json({ error: err })
        } else {
            if (isFresh)
                index.nextId++
            if (currElt.address == center.address)
                delete currElt.address
            if (currElt.name == center.name)
                delete currElt.name
            await saveEventAsync(currElt, req.appuser)
            res.json(currElt)
        }
    })

    app.get("/api/centers/:id", async (req, res, next) => {
        let centers = await getCentersAsync()
        let c = centers[req.params["id"]]
        if (!c)
            return res.status(404).end()
        if (req.appuser)
            res.json(c)
        else
            res.json(publicCenter(c))
    })

    app.get("/api/centers", async (req, res, next) => {
        let centers = await getCentersAsync()
        let lst = tools.values(centers)
        if (req.appuser)
            res.json({
                centers: lst
            })
        else
            res.json({
                centers: lst.map(publicCenter)
            })
    })
}
