interface CheerioElement {
    startIndex: number;
}

interface Cheerio {
    gw_ctx: any;
}

type SMap<T> = { [s: string]: T };



declare namespace Express {
    export interface Request {
        appuser: string;
    }
}
