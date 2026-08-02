import { promiseQueue } from "./tools"

describe("promiseQueue()", () => {
    it("rejects synchronous callback failures and continues the queue", async () => {
        const queue = promiseQueue()
        const order: string[] = []

        const failed = queue("file", () => {
            order.push("failed")
            throw new Error("synchronous failure")
        })
        const next = queue("file", async () => {
            order.push("next")
            return 42
        })

        await expect(failed).rejects.toThrow("synchronous failure")
        await expect(next).resolves.toBe(42)
        expect(order).toEqual(["failed", "next"])
    })
})
