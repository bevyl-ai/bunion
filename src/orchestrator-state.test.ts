import { expect, test } from 'bun:test'
import { normalizeTicketGrantRecord, planCapGrant } from './orchestrator-state'

test('numeric ticket grants from older state files migrate into audited records', () => {
  expect(normalizeTicketGrantRecord(200_000_000)).toEqual({
    total: 200_000_000,
    audit: [],
  })
})

test('audited ticket grant records keep total and valid audit entries', () => {
  expect(normalizeTicketGrantRecord({
    total: 150_000_000,
    audit: [{
      at: '2026-07-02T18:00:00.000Z',
      source: 'operator:bump',
      actor: 'dashboard-operator',
      oldCap: 200_000_000,
      newCap: 350_000_000,
      increment: 150_000_000,
      rationale: 'operator clicked budget bump to reopen a capped ticket',
    }],
  })).toEqual({
    total: 150_000_000,
    audit: [{
      at: '2026-07-02T18:00:00.000Z',
      source: 'operator:bump',
      actor: 'dashboard-operator',
      oldCap: 200_000_000,
      newCap: 350_000_000,
      increment: 150_000_000,
      rationale: 'operator clicked budget bump to reopen a capped ticket',
    }],
  })
})

test('a just-over-cap ticket can receive audited headroom up to the max effective cap', () => {
  const plan = planCapGrant({
    currentTotal: 201_000_000,
    currentEffectiveCap: 200_000_000,
    hardTokenCap: 200_000_000,
    maxEffectiveTokenCap: 400_000_000,
  })

  expect(plan.ok).toBe(true)
  expect(plan.increment).toBe(200_000_000)
  expect(plan.oldCap).toBe(200_000_000)
  expect(plan.newCap).toBe(400_000_000)
})

test('a wildly over-budget ticket is denied instead of receiving a multi-billion cap', () => {
  const plan = planCapGrant({
    currentTotal: 6_300_000_000,
    currentEffectiveCap: 200_000_000,
    hardTokenCap: 200_000_000,
    maxEffectiveTokenCap: 400_000_000,
  })

  expect(plan.ok).toBe(false)
  expect(plan.increment).toBe(0)
  expect(plan.newCap).toBe(200_000_000)
  expect(plan.deniedReason).toContain('above max 400M')
})

test('existing over-large grants are treated as capped at the max effective cap for future plans', () => {
  const plan = planCapGrant({
    currentTotal: 450_000_000,
    currentEffectiveCap: 400_000_000,
    hardTokenCap: 200_000_000,
    maxEffectiveTokenCap: 400_000_000,
  })

  expect(plan.ok).toBe(false)
  expect(plan.oldCap).toBe(400_000_000)
  expect(plan.deniedReason).toContain('would require 650M cap')
})
