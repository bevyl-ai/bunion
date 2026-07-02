import { describe, expect, test } from 'bun:test'
import { isRoutable } from './orchestrator-predicates'
import type { Config, Issue } from './types'

const cfg = (tracker: Partial<Config['tracker']> = {}): Config =>
  ({
    tracker: {
      appActorId: 'factory-app',
      requiredLabels: ['dark-factory'],
      optInProjects: [],
      ...tracker,
    },
  }) as Config

const issue = (extra: Partial<Issue> = {}): Issue =>
  ({
    id: 'i1',
    identifier: 'BEV-1',
    title: 't',
    description: '',
    url: '',
    state: 'Todo',
    stateType: 'unstarted',
    priority: 0,
    branchName: null,
    createdAt: '2026-01-01',
    updatedAt: null,
    startedAt: null,
    completedAt: null,
    labels: [],
    delegateId: null,
    project: null,
    blockers: [],
    prUrl: null,
    ...extra,
  })

describe('isRoutable', () => {
  test('routes tickets carrying every required label', () => {
    expect(isRoutable(cfg(), issue({ labels: ['repo:bunion', 'dark-factory'] }))).toBe(true)
  })

  test('routes tickets delegated to the factory app actor', () => {
    expect(isRoutable(cfg(), issue({ delegateId: 'factory-app' }))).toBe(true)
  })

  test('routes tickets in a configured opt-in project by id', () => {
    const project = { id: '6a509c29-929b-45d7-a8d1-5bbe6a982634', slugId: 'factory-fc8d8a37a6b8' }

    expect(isRoutable(cfg({ optInProjects: [project.id] }), issue({ project }))).toBe(true)
  })

  test('routes tickets in a configured opt-in project by slugId', () => {
    const project = { id: 'other-project', slugId: 'factory-fc8d8a37a6b8' }

    expect(isRoutable(cfg({ optInProjects: [project.slugId] }), issue({ project }))).toBe(true)
  })

  test('excludes tickets outside opt-in projects without label or delegation', () => {
    const project = { id: 'other-project', slugId: 'other-project-slug' }

    expect(isRoutable(cfg({ optInProjects: ['factory-fc8d8a37a6b8'] }), issue({ project }))).toBe(false)
  })

  test('empty opt-in projects preserves label/delegate-only behavior', () => {
    const project = { id: '6a509c29-929b-45d7-a8d1-5bbe6a982634', slugId: 'factory-fc8d8a37a6b8' }

    expect(isRoutable(cfg(), issue({ project }))).toBe(false)
  })
})
