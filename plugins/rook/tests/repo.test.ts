import { describe, expect, test } from 'claude-code/testing'

import type { RookReadiness } from '../types'
import { envSetLine, exploreInstruction, generatePlan, listingKey, MAX_ENTRIES, nextStep, scanRepo, sdksIn, startSteps } from '../hooks/repo'
import type { Io } from '../hooks/workspace'

/** An in-memory repository: a file tree the scan lists and reads, and a record of what it read and listed. */
function ioOf(files: Record<string, string>, sizes: Record<string, number> = {}) {
  const reads: string[] = []
  const lists: string[] = []
  const io: Io = {
    read: async path => {
      reads.push(path)

      return files[path]
    },
    list: async path => {
      lists.push(path)
      const prefix = path === '.' || path === '' ? '' : `${path}/`
      const names = new Map<string, string>()

      for (const file of Object.keys(files)) {
        if (file.startsWith(prefix)) {
          const rest = file.slice(prefix.length)
          names.set(rest.split('/')[0] ?? '', rest.includes('/') ? 'dir' : 'file')
        }
      }

      return [...names.entries()].sort().map(([name, kind]) => ({ name, kind, ...(sizes[`${prefix}${name}`] !== undefined && { size: sizes[`${prefix}${name}`] }) }))
    },
  }

  return { io, reads, lists }
}

describe('repo scan · what a repository without rook holds', () => {
  test('agent code by its SDK, at the top level and two levels into src/', async () => {
    const { io } = ioOf({
      'main.py': 'from agents import Agent, Runner\nagent = Agent(name="support")\n',
      'src/graph/build.ts': "import { StateGraph } from '@langchain/langgraph'\n",
      'src/support/crew.py': 'from crewai import Agent, Crew\n',
      'src/util/strings.ts': 'export const trim = (s: string) => s.trim()\n',
      'src/bot.ts': "import Anthropic from '@anthropic-ai/sdk'\n",
    })

    const found = await scanRepo(io)

    expect(found.filter(item => item.kind === 'agent')).toEqual([
      { path: 'main.py', kind: 'agent', what: 'an agent: OpenAI Agents SDK' },
      { path: 'src/bot.ts', kind: 'agent', what: 'an agent: Anthropic SDK' },
      { path: 'src/graph/build.ts', kind: 'agent', what: 'an agent: LangGraph' },
      { path: 'src/support/crew.py', kind: 'agent', what: 'an agent: CrewAI' },
    ])
  })

  test('SDK names: the specific one wins over its parent, and every listed SDK is known', () => {
    expect(sdksIn("from langgraph.graph import StateGraph\nfrom langchain_core.tools import tool")).toEqual(['LangGraph'])
    expect(sdksIn('from claude_agent_sdk import query\nimport anthropic')).toEqual(['Claude Agent SDK'])
    expect(sdksIn("import { Agent } from '@openai/agents'")).toEqual(['OpenAI Agents SDK'])
    expect(sdksIn('from autogen_agentchat.agents import AssistantAgent')).toEqual(['AutoGen'])
    expect(sdksIn("import { Agent } from '@mastra/core/agent'")).toEqual(['Mastra'])
    expect(sdksIn('from llama_index.core.agent import ReActAgent')).toEqual(['LlamaIndex'])
    expect(sdksIn('import openai\nclient = openai.OpenAI()')).toEqual([]) // a plain model client is not an agent SDK
    expect(sdksIn('anthropic==0.40.0\nfastapi\n', 'dep')).toEqual(['Anthropic SDK'])
  })

  test('requirements docs (PRD.md, REQUIREMENTS.md, requirements*.md, docs/*prd*) with their headings; requirements.txt is not one', async () => {
    const { io } = ioOf({
      'PRD.md': '# Support bot\n## Refunds\n## Orders\ntext\n',
      'requirements-v2.md': '# v2\n',
      'requirements.txt': 'crewai\n',
      'docs/billing-prd.md': 'no headings here\n',
      'docs/guide.md': '# guide\n',
    })

    const found = (await scanRepo(io)).filter(item => item.kind === 'requirements')

    expect(found).toEqual([
      { path: 'PRD.md', kind: 'requirements', what: 'requirements: 3 headings' },
      { path: 'requirements-v2.md', kind: 'requirements', what: 'requirements: 1 heading' },
      { path: 'docs/billing-prd.md', kind: 'requirements', what: 'requirements' },
    ])
  })

  test('connection docs from the setup list (any case), never README; CI workflows, marked when they run rook', async () => {
    const { io } = ioOf({
      'CONNECTION.md': 'curl https://staging.example/agent',
      'openapi.yaml': 'openapi: 3.1.0',
      'README.md': '# hello',
      '.github/workflows/ci.yml': 'jobs:\n  test:\n    runs-on: ubuntu-latest\n',
      '.github/workflows/rook.yaml': 'steps:\n  - run: rook run --test --json\n',
      '.github/workflows/notes.txt': 'not a workflow',
    })

    const found = await scanRepo(io)

    expect(found.filter(item => item.kind === 'connection')).toEqual([
      { path: 'CONNECTION.md', kind: 'connection', what: 'how to reach the agent' },
      { path: 'openapi.yaml', kind: 'connection', what: "the agent's API spec" },
    ])
    expect(found.filter(item => item.kind === 'ci')).toEqual([
      { path: '.github/workflows/ci.yml', kind: 'ci', what: 'CI workflow' },
      { path: '.github/workflows/rook.yaml', kind: 'ci', what: 'CI workflow (runs rook)' },
    ])
  })

  test('skips node_modules, .git, dist, build and .venv, never goes deeper than two levels, and reads no large file', async () => {
    const { io, reads, lists } = ioOf(
      {
        'node_modules/openai-agents/index.js': "require('@openai/agents')",
        '.git/HEAD': 'ref',
        'dist/agent.js': "require('@openai/agents')",
        'build/agent.py': 'from agents import Agent',
        '.venv/lib/crewai.py': 'import crewai',
        'src/node_modules/x.js': "require('@openai/agents')",
        'src/a/b/deep.py': 'from crewai import Crew', // three levels into src
        'src/big.py': 'from crewai import Crew',
      },
      { 'src/big.py': 500_000 },
    )

    expect(await scanRepo(io)).toEqual([])
    expect(lists.some(path => /node_modules|\.git|dist|build|\.venv/.test(path))).toBe(false)
    expect(lists).not.toContain('src/a/b')
    expect(reads).not.toContain('src/big.py')
  })

  test('caps what it looks at: at most MAX_ENTRIES entries', async () => {
    const files: Record<string, string> = {}

    for (let at = 0; at < 400; at += 1) {
      files[`src/m${String(at).padStart(3, '0')}.py`] = at === 399 ? 'from crewai import Crew' : 'x = 1'
    }

    const { io, reads } = ioOf(files)

    expect(await scanRepo(io)).toEqual([]) // the 400th file is past the cap
    expect(reads.length).toBeLessThanOrEqual(40)
    expect(MAX_ENTRIES).toBe(300)
  })

  test('a dependency manifest says where to look when no code file names an SDK', async () => {
    const { io } = ioOf({ 'package.json': JSON.stringify({ dependencies: { '@mastra/core': '^0.10.0' } }), 'index.js': 'run()' })

    expect(await scanRepo(io)).toEqual([{ path: 'package.json', kind: 'agent', what: 'depends on Mastra' }])
  })

  test('the cache key follows the top-level listing, not its order', () => {
    expect(listingKey([{ name: 'b', kind: 'file' }, { name: 'a', kind: 'dir' }])).toBe(listingKey([{ name: 'a', kind: 'dir' }, { name: 'b', kind: 'file' }]))
    expect(listingKey([{ name: 'a', kind: 'dir' }])).not.toBe(listingKey([{ name: 'a', kind: 'file' }]))
  })
})

const step = (id: RookReadiness['steps'][number]['id'], ok: boolean, label: string, hint?: string) => ({ id, ok, label, ...(hint !== undefined && { hint }) })

const READY_TO_AGENT: RookReadiness = {
  hasWorkspace: true,
  steps: [
    step('installed', true, 'rook 0.1.0'),
    step('signed_in', true, 'signed in'),
    step('project', true, 'project shop'),
    step('agent', true, 'agent commercecare'),
    step('scenarios', true, '3 scenarios'),
    step('profile', true, 'profile commerce-http'),
  ],
}

describe('repo · the guided start', () => {
  test('fresh folder: create the project named after the folder, or pick one through Claude', () => {
    const readiness: RookReadiness = {
      hasWorkspace: false,
      steps: [
        step('installed', true, 'rook 0.1.0'),
        step('signed_in', true, 'signed in'),
        step('project', false, 'no project selected', 'type `/rook project` to see your projects'),
        step('agent', false, 'no agent yet', 'ask Claude'),
        step('scenarios', false, 'no scenarios', 'ask Claude'),
        step('profile', false, 'no profile', 'run `! rook profile add <name>` yourself'),
      ],
    }
    const next = nextStep(startSteps({ readiness, found: [], lens: 'qe', folder: 'support-bot' }))

    expect(next?.id).toBe('project')
    expect(next?.action).toEqual({ kind: 'create-project', label: 'Create project “support-bot”', arg: 'support-bot' })
    expect(next?.other?.kind).toBe('pick-project')
    expect(next?.command).toBe('/rook project create support-bot')
  })

  test('no agent: explore, told where the scan found it; it spends credits', () => {
    const readiness = { ...READY_TO_AGENT, steps: READY_TO_AGENT.steps.map(s => (s.id === 'agent' ? step('agent', false, 'no agent yet', 'ask Claude') : s)) }
    const found = [{ path: 'src/agent.py', kind: 'agent' as const, what: 'an agent: CrewAI' }]
    const next = nextStep(startSteps({ readiness, found, lens: 'qe', folder: 'x' }))

    expect(next?.action).toEqual({ kind: 'explore', label: 'Explore the agent', spends: true, arg: 'The agent is in src/agent.py (CrewAI).' })
    expect(exploreInstruction([])).toBeUndefined()
  })

  test('no scenarios: a QE generates from the requirements doc, a developer from the agent’s tools', () => {
    const found = [
      { path: 'PRD.md', kind: 'requirements' as const, what: 'requirements: 3 headings' },
      { path: 'src/agent.py', kind: 'agent' as const, what: 'an agent: CrewAI' },
    ]

    expect(generatePlan('qe', found)).toEqual({
      label: 'Generate scenarios from PRD.md',
      instruction: 'Cover the requirements in PRD.md: each requirement as functional scenarios, and the adversarial cases they imply.',
    })
    expect(generatePlan('dev', found).label).toBe("Generate scenarios from the agent's tools")
    expect(generatePlan('dev', found).instruction).toContain('(src/agent.py)')
    expect(generatePlan('qe', []).label).toBe("Generate scenarios from the agent's tools") // no doc: the code it is
  })

  test('no profile: from the connection doc into the prompt, or Claude writes connection.md first', () => {
    const readiness = { ...READY_TO_AGENT, steps: READY_TO_AGENT.steps.map(s => (s.id === 'profile' ? step('profile', false, 'no profile') : s)) }

    expect(nextStep(startSteps({ readiness, found: [{ path: 'connection.md', kind: 'connection', what: '' }], lens: 'qe', folder: 'x' }))?.action).toEqual({
      kind: 'add-profile',
      label: 'Put it in the prompt',
      arg: '! rook profile add http --from connection.md',
    })
    expect(nextStep(startSteps({ readiness, found: [], lens: 'qe', folder: 'x' }))?.action?.kind).toBe('connection')
  })

  test('never run here: the unset variables, then a profile test, then the first run', () => {
    const base = { readiness: READY_TO_AGENT, found: [], lens: 'qe' as const, folder: 'x', runCount: 0, scenarios: 3 }
    const unset = startSteps({ ...base, profiles: [{ id: 'http', isActive: true, isVerified: false, unset: ['A', 'B'] }] })

    expect(nextStep(unset)).toMatchObject({ id: 'env', command: envSetLine(['A', 'B']), action: { kind: 'fill-env', arg: `! rook env set '{"A":"…","B":"…"}'` } })
    expect(unset.map(s => s.id)).toEqual(['installed', 'signed_in', 'project', 'agent', 'scenarios', 'profile', 'env', 'verify', 'run'])

    const untested = startSteps({ ...base, profiles: [{ id: 'http', isActive: true, isVerified: false, unset: [] }] })
    expect(nextStep(untested)).toMatchObject({ id: 'verify', command: '/rook profile test http', action: { kind: 'test-profile', spends: true, arg: 'http' } })

    const tested = startSteps({ ...base, profiles: [{ id: 'http', isActive: true, isVerified: true, unset: [] }] })
    expect(nextStep(tested)).toMatchObject({ id: 'run', action: { kind: 'first-run', label: 'First run: 3 scenarios', spends: true } })

    expect(nextStep(startSteps({ ...base, runCount: 2, profiles: [{ id: 'http', isActive: true, isVerified: true, unset: [] }] }))).toBeUndefined()
  })
})
