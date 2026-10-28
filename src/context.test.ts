import { expect, test } from "bun:test"
import { sessionTitle } from "./context"

test("sessionTitle keeps titles on one line of at most 80 characters", () => {
  expect(sessionTitle("#12 Fix the  login\nredirect ")).toBe("#12 Fix the login redirect")
  const long = sessionTitle(`Review #45 ${"word ".repeat(30)}`)
  expect(long.length).toBe(80)
  expect(long.endsWith("…")).toBe(true)
  expect(sessionTitle("x".repeat(80))).toBe("x".repeat(80))
})
