import { replicatePictureSource } from "./expander"
import { cheerioFixture } from "./fixtures"

describe("replication", () => {
    describe("replicatePictureSource()", () => {
        it("replicates source correctly", async () => {
            const cheerio = cheerioFixture(jest.fn(() => "assets/img.png"))

            const replicate = jest.fn(() => Promise.resolve("cdn/img.png"))
            await replicatePictureSource(cheerio, replicate)[0]

            //@ts-ignore
            expect(cheerio.attr.mock.calls[1]).toEqual([
                "srcset",
                "cdn/img.png",
            ])
            //@ts-ignore
            expect(cheerio.attr.mock.calls[2]).toEqual([
                "data-gw-orig-srcset",
                "assets/img.png",
            ])
        })

        it("replicates source with width and height", async () => {
            const cheerio = cheerioFixture(
                jest.fn(() => "assets/img.png w100 h100")
            )

            const replicate = jest.fn(() => Promise.resolve("cdn/img.png"))
            await replicatePictureSource(cheerio, replicate)[0]

            //@ts-ignore
            expect(cheerio.attr.mock.calls[1]).toEqual([
                "srcset",
                "cdn/img.png w100 h100",
            ])
            //@ts-ignore
            expect(cheerio.attr.mock.calls[2]).toEqual([
                "data-gw-orig-srcset",
                "assets/img.png w100 h100",
            ])
        })

        it("replicates source with width and height", async () => {
            const cheerio = cheerioFixture(
                jest.fn(
                    () => "assets/img.png w100 h100, assets/img2.png w200 h200"
                )
            )

            const replicate = jest.fn()
            replicate
                .mockReturnValueOnce(Promise.resolve("cdn/img.png"))
                .mockReturnValueOnce(Promise.resolve("cdn/img2.png"))
            await replicatePictureSource(cheerio, replicate)[0]

            //@ts-ignore
            expect(cheerio.attr.mock.calls[1]).toEqual([
                "srcset",
                "cdn/img.png w100 h100, cdn/img2.png w200 h200",
            ])
            //@ts-ignore
            expect(cheerio.attr.mock.calls[2]).toEqual([
                "data-gw-orig-srcset",
                "assets/img.png w100 h100, assets/img2.png w200 h200",
            ])
        })
    })
})
