import * as auth from "./auth"
import * as epub from "./epub"
import * as expander from "./expander"

describe("EPUB route authorization", () => {
    afterEach(() => jest.restoreAllMocks())

    function routes() {
        const handlers: { [path: string]: Function } = {}
        epub.init({
            get: jest.fn((path: string, handler: Function) => {
                handlers[path] = handler
            }),
        } as any)
        return handlers
    }

    async function expectDenied(path: string, epubEnabled: boolean) {
        jest.spyOn(expander, "getPageConfigAsync").mockResolvedValue({
            epub: epubEnabled,
            users: ["editor@example.test"],
        })
        const hasWritePerm = jest
            .spyOn(auth, "hasWritePermAsync")
            .mockResolvedValue(!epubEnabled)
        const next = jest.fn()

        await routes()[path](
            {
                appuser: "other@example.test",
                query: { folder: "book" },
            },
            {},
            next
        )

        expect(next).toHaveBeenCalledWith(
            expect.objectContaining({ statusCode: 403 })
        )
        if (!epubEnabled) expect(hasWritePerm).not.toHaveBeenCalled()
    }

    it("rejects TOC access without site write permission", async () => {
        await expectDenied("/api/epubtoc", true)
    })

    it("rejects EPUB generation when the site has not enabled it", async () => {
        await expectDenied("/api/epub", false)
    })
})
