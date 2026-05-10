import type { Cheerio as CheerioType, CheerioAPI } from "cheerio"
import type { Element as DomElement } from "domhandler"

declare global {
    type Cheerio = CheerioType<any> & {
        gw_ctx?: any
    }

    type CheerioStatic = CheerioAPI

    interface CheerioElement extends DomElement {}

    type SMap<T> = { [s: string]: T }

    namespace Express {
        export interface Request {
            appuser: string
            oauthuser: string
            langs: string[]
            _response: any
        }
    }
}

export {}
