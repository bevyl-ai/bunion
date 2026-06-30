import { expect, test } from 'bun:test'
import { countGraphqlOperations } from './dynamic-tool'

test('a single mutation counts as 1', () => {
  expect(countGraphqlOperations('mutation { commentCreate(input: { issueId: "abc", body: "hi" }) { success } }')).toBe(1)
})

test('a single query counts as 1', () => {
  expect(countGraphqlOperations('query { issue(id: "abc") { identifier } }')).toBe(1)
})

// BEV audit: an inlined string VALUE that happens to contain the English word "query"/"mutation"/"subscription"
// must not be miscounted as a second operation — this previously rejected valid single-operation calls whenever a
// workpad/comment body mentioned those words in normal prose.
test('a string value containing the word "query" does not inflate the count', () => {
  const q = 'mutation { commentCreate(input: { issueId: "abc", body: "fixed the slow query and the related mutation logic" }) { success } }'
  expect(countGraphqlOperations(q)).toBe(1)
})

test('a string value containing "subscription" (a real product term) does not inflate the count', () => {
  const q = 'mutation { commentCreate(input: { issueId: "abc", body: "the Stripe subscription webhook now fires correctly" }) { success } }'
  expect(countGraphqlOperations(q)).toBe(1)
})

test('escaped quotes inside a string value are handled correctly', () => {
  const q = 'mutation { commentCreate(input: { issueId: "abc", body: "the query said \\"mutation failed\\"" }) { success } }'
  expect(countGraphqlOperations(q)).toBe(1)
})

test('a genuine two-operation document still counts as 2 (the guard still works)', () => {
  const q = 'query A { issue(id: "x") { identifier } } mutation B { commentCreate(input: { issueId: "x", body: "y" }) { success } }'
  expect(countGraphqlOperations(q)).toBe(2)
})

test('a bare shorthand query ({ ... }) still counts as 1', () => {
  expect(countGraphqlOperations('{ issue(id: "abc") { identifier } }')).toBe(1)
})

test('a triple-quoted block string is still stripped (pre-existing behavior preserved)', () => {
  const q = 'mutation { commentCreate(input: { issueId: "abc", body: """a query inside a block string mutation""" }) { success } }'
  expect(countGraphqlOperations(q)).toBe(1)
})
